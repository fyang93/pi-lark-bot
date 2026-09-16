import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotController, ProgressMessage, splitText } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, WorkerFactory } from "../src/types.ts";

const config = { version: 1 as const, brand: "feishu" as const, appId: "cli_test", appSecret: "secret" };
const msg = (id: string, userId = "ou_a"): IncomingMessage => ({ id, userId, chatId: `chat_${userId}`, text: id });
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; }
class FakeTransport implements BotTransport {
  sends: { chat: string; text: string; reply?: string }[] = [];
  updates: string[] = [];
  receiver?: (message: IncomingMessage) => Promise<void>;
  stopped = false;
  async start(receiver: (message: IncomingMessage) => Promise<void>) { this.receiver = receiver; }
  async stop() { this.stopped = true; }
  async send(chat: string, text: string, reply?: string) { this.sends.push({ chat, text, reply }); return `id_${this.sends.length}`; }
  async update(_id: string, text: string) { this.updates.push(text); }
}

test("controller deduplicates across restart, reuses per-user worker and sends streamed/final replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-controller-"));
  try {
    const transport = new FakeTransport();
    const calls: string[] = [];
    const workers: WorkerFactory = {
      async open(user) { return { async run(text, emit) {
        calls.push(`${user}:${text}`);
        emit({ type: "progress", text: "Using read" });
        emit({ type: "text", text: "Draft answer" });
        emit({ type: "done", text: `Answer ${text}` });
      }, async close() {} }; }, async close() {},
    };
    const bot = new BotController({ config, stateDir: dir, transport, workers });
    await bot.start();
    await Promise.all([bot.receive(msg("a")), bot.receive(msg("a")), bot.receive(msg("b", "ou_b")), bot.receive(msg("new-user", "ou_x"))]);
    await bot.drain();
    assert.deepEqual(calls.sort(), ["ou_a:a", "ou_b:b", "ou_x:new-user"]);
    assert.equal(transport.sends.filter((x) => x.text.startsWith("Answer")).length, 3);
    assert(transport.sends.some((x) => x.chat === "chat_ou_x"));
    assert(transport.updates.includes("✅ Completed"));
    await bot.stop();
    const bot2 = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers });
    await bot2.start(); await bot2.receive(msg("a")); await bot2.drain();
    assert.equal(calls.length, 3);
    await bot2.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("same-user FIFO, different users concurrent, event handler does not wait for model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-controller-"));
  const gate = deferred(); const began = deferred();
  const order: string[] = [];
  const workers: WorkerFactory = { async open() { return { async run(text, emit) {
    order.push(text); if (text === "one") { began.resolve(); await gate.promise; }
    emit({ type: "done", text });
  }, async close() {} }; }, async close() { gate.resolve(); } };
  const transport = new FakeTransport();
  const bot = new BotController({ config, stateDir: dir, transport, workers });
  try {
    await bot.start();
    await bot.receive(msg("one")); await began.promise;
    await bot.receive(msg("two")); await bot.receive(msg("other", "ou_b"));
    // Admission barrier via a standalone user job finishing, without a sleep.
    const otherDone = deferred();
    const original = transport.send.bind(transport);
    transport.send = async (...args) => { const id = await original(...args); if (args[1] === "other") otherDone.resolve(); return id; };
    await otherDone.promise;
    assert.deepEqual(order, ["one", "other"]);
    gate.resolve(); await bot.drain();
    assert.deepEqual(order, ["one", "other", "two"]);
    assert(transport.sends.some((x) => x.text.includes("Queued")));
  } finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("group members share one FIFO session, isolated from DMs and other groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-groups-"));
  const gate = deferred(), began = deferred(), otherDone = deferred();
  const calls: string[] = [];
  const workers: WorkerFactory = { async open(key) { return { async run(text, emit) {
    calls.push(`${key}|${text}`);
    if (text === "ou_a: first") { began.resolve(); await gate.promise; }
    if (text === "ou_a: other") otherDone.resolve();
    emit({ type: "done", text });
  }, async close() {} }; }, async close() { gate.resolve(); } };
  const bot = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers });
  const group = (id: string, userId = "ou_a", chatId = "oc_x"): IncomingMessage => ({ id, text: id, userId, chatId, chatType: "group", mentionedBot: true });
  try {
    await bot.start(); await bot.receive(group("first")); await began.promise;
    await bot.receive(group("second", "ou_b"));
    await bot.receive(msg("dm")); await bot.receive(group("other", "ou_a", "oc_y"));
    await bot.receive({ ...group("ignored"), mentionedBot: false });
    await otherDone.promise;
    assert.deepEqual(calls, ["group:oc_x|ou_a: first", "ou_a|dm", "group:oc_y|ou_a: other"]);
    gate.resolve(); await bot.drain();
    assert.equal(calls.at(-1), "group:oc_x|ou_b: second");
  } finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("per-user queue and input-size limits reject excess work without invoking the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-limits-"));
  const started = deferred(); const rejected = deferred(); const gate = deferred();
  let count = 0; const transport = new FakeTransport();
  const send = transport.send.bind(transport);
  transport.send = async (...args) => {
    const id = await send(...args);
    if (args[1].includes("Message too long or queue full")) rejected.resolve();
    return id;
  };
  const workers: WorkerFactory = { async open() { return { async run(_text, emit) {
    if (++count === 1) { started.resolve(); await gate.promise; }
    emit({ type: "done", text: "ok" });
  }, async close() {} }; }, async close() { gate.resolve(); } };
  const bot = new BotController({ config, stateDir: dir, transport, workers });
  try {
    await bot.start(); await bot.receive(msg("first")); await started.promise;
    for (let i = 0; i < 20; i++) await bot.receive(msg(`queued-${i}`));
    await rejected.promise; gate.resolve(); await bot.drain();
    assert.equal(count, 20);
    await bot.receive({ ...msg("long", "ou_b"), text: "中".repeat(22_000) }); await bot.drain();
    assert.equal(count, 20);
  } finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("stop closes workers, skips queued work and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-controller-"));
  const gate = deferred(); const began = deferred(); let closes = 0; let runs = 0;
  const workers: WorkerFactory = { async open() { return { async run(_text, emit) {
    runs++; began.resolve(); await gate.promise; emit({ type: "done", text: "stopped" });
  }, async close() {} }; }, async close() { closes++; gate.resolve(); } };
  const transport = new FakeTransport();
  const bot = new BotController({ config, stateDir: dir, transport, workers });
  try {
    await bot.start(); await bot.receive(msg("one")); await began.promise;
    await bot.receive(msg("two"));
    await Promise.all([bot.stop(), bot.stop()]);
    await bot.receive(msg("three"));
    assert.equal(closes, 1); assert.equal(runs, 1); assert.equal(bot.status.active, false);
    assert(!transport.updates.includes("✅ Completed"));
    assert(!transport.sends.some((x) => x.text === "stopped"));
    assert(transport.updates.at(-1)?.includes("Stopped"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stop during pane startup finalizes the preparing card without running a prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-open-stop-"));
  const opened = deferred(); const gate = deferred(); let runs = 0;
  const transport = new FakeTransport();
  const workers: WorkerFactory = { async open() {
    opened.resolve(); await gate.promise;
    return { async run() { runs++; }, async close() {} };
  }, async close() { gate.resolve(); } };
  const bot = new BotController({ config, stateDir: dir, transport, workers });
  try {
    await bot.start(); await bot.receive(msg("one")); await opened.promise;
    await bot.stop();
    assert.equal(runs, 0);
    assert(transport.updates.at(-1)?.includes("Stopped"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stop during completion update prevents subsequent final answer sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-final-stop-"));
  const began = deferred(); const gate = deferred();
  const transport = new FakeTransport();
  transport.update = async (_id, text) => {
    if (text === "✅ Completed") { began.resolve(); await gate.promise; }
    transport.updates.push(text);
  };
  const workers: WorkerFactory = { async open() { return { async run(_text, emit) {
    emit({ type: "done", text: "should-not-send" });
  }, async close() {} }; }, async close() {} };
  const bot = new BotController({ config, stateDir: dir, transport, workers });
  try {
    await bot.start(); await bot.receive(msg("one")); await began.promise;
    const stopping = bot.stop(); gate.resolve(); await stopping;
    assert(!transport.sends.some((x) => x.text === "should-not-send"));
    assert(transport.updates.at(-1)?.includes("Stopped"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("worker failures are reported, next message still runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-controller-"));
  const transport = new FakeTransport(); let errors = 0;
  const workers: WorkerFactory = { async open() { return { async run(text, emit) {
    if (text === "bad") throw new Error("do not expose secret");
    emit({ type: "done", text: "success" });
  }, async close() {} }; }, async close() {} };
  const bot = new BotController({ config, stateDir: dir, transport, workers, onError: () => { errors++; } });
  try {
    await bot.start(); await bot.receive(msg("bad")); await bot.receive(msg("good")); await bot.drain();
    assert(errors > 0); assert(transport.sends.some((x) => x.text === "success"));
    assert(!transport.sends.some((x) => x.text.includes("secret")));
  } finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("stream updates coalesce and final cannot be overwritten by an earlier in-flight edit", async () => {
  const transport = new FakeTransport(); const started = deferred(); const gate = deferred();
  transport.update = async (_id, text) => { if (text === "first") { started.resolve(); await gate.promise; } transport.updates.push(text); };
  const progress = new ProgressMessage(transport, "card", 1);
  progress.set("first"); await started.promise;
  for (let i = 0; i < 1000; i++) progress.set(`chunk ${i}`);
  const finished = progress.finish("final"); gate.resolve(); await finished;
  assert.deepEqual(transport.updates, ["first", "final"]);
  progress.set("late"); assert.equal(transport.updates.at(-1), "final");
});

test("stop during asynchronous startup cannot resurrect a listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-start-stop-"));
  const transport = new FakeTransport(); let starts = 0;
  transport.start = async () => { starts++; };
  const bot = new BotController({ config, stateDir: dir, transport,
    workers: { async open() { throw new Error("unexpected"); }, async close() {} } });
  try {
    const starting = bot.start();
    const rejected = assert.rejects(starting, /stopped during startup/);
    await bot.stop(); await rejected;
    assert.equal(starts, 0); assert.equal(bot.status.active, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("late transport handshake after stop is closed again and cannot report startup success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-handshake-stop-"));
  const began = deferred(); const gate = deferred(); let live = false;
  const transport = new FakeTransport();
  transport.start = async () => { began.resolve(); await gate.promise; live = true; };
  transport.stop = async () => { live = false; };
  const bot = new BotController({ config, stateDir: dir, transport,
    workers: { async open() { throw new Error("unexpected"); }, async close() {} } });
  try {
    const starting = bot.start();
    const rejected = assert.rejects(starting, /stopped during connection startup/);
    await began.promise; await bot.stop(); gate.resolve(); await rejected;
    assert.equal(live, false); assert.equal(bot.status.active, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("UTF8 chunking is lossless, including supplementary Unicode", () => {
  const text = "你好🙂\n".repeat(10_000);
  const chunks = splitText(text);
  assert.equal(chunks.join(""), text);
  assert(chunks.every((x) => Buffer.byteLength(x) <= 12_000));
});
