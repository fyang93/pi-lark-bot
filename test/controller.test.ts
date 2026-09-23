import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotController, ProgressMessage, senderCode, splitText } from "../src/controller.ts";
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
    assert.equal(transport.sends.filter((x) => x.text.startsWith("Answer")).length, 0);
    assert(transport.sends.some((x) => x.chat === "chat_ou_x"));
    assert(transport.updates.includes("Answer new-user"));
    assert.equal(transport.sends.filter((x) => x.text.startsWith("Answer")).length, 0, "final replies reuse the streamed bubble");
    await bot.stop();
    const bot2 = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers });
    await bot2.start(); await bot2.receive(msg("a")); await bot2.drain();
    assert.equal(calls.length, 3);
    await bot2.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("direct and group senders require approval and share the persisted user allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-allowlist-"));
  const calls: string[] = []; let prompts = 0;
  const workers: WorkerFactory = { async open(key) { return { async run(text, emit) {
    calls.push(`${key}|${text}`); emit({ type: "done", text: "ok" });
  }, async close() {} }; }, async close() {} };
  const group: IncomingMessage = { id: "group", userId: "ou_group", chatId: "oc_room", text: "hello", chatType: "group", mentionedBot: true };
  try {
    const transport = new FakeTransport();
    const bot = new BotController({ config, stateDir: dir, transport, workers,
      authorizeUser: async (userId) => { prompts++; return userId === "ou_allowed" || userId === "ou_group"; } });
    await bot.start();
    await Promise.all([
      bot.receive(msg("first", "ou_allowed")), bot.receive(msg("second", "ou_allowed")),
      bot.receive(msg("denied", "ou_denied")), bot.receive(group),
    ]);
    await bot.drain();
    assert.equal(prompts, 3, "concurrent messages from one new user share one prompt, while a group sender is also checked");
    assert(calls.includes("ou_allowed|first") && calls.includes("ou_allowed|second"));
    assert(calls.includes("group:oc_room|ou_group: hello"));
    assert(!calls.some((x) => x.includes("denied")));
    assert(transport.sends.some((x) => x.chat === "chat_ou_denied" && x.text.includes("本机拒绝启动")));
    assert.equal(bot.status.allowlisted, 2);
    await bot.stop();

    let restartPrompts = 0;
    const bot2 = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers,
      authorizeUser: async () => { restartPrompts++; return false; } });
    await bot2.start(); await bot2.receive(msg("after-restart", "ou_allowed")); await bot2.drain();
    assert.equal(restartPrompts, 0);
    assert(calls.includes("ou_allowed|after-restart"));
    await bot2.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("quoted files are prepared only after authorization and their cache paths reach the worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-prepared-file-"));
  const prompts: string[] = []; const prepared: string[] = [];
  const transport = new FakeTransport();
  (transport as any).prepareMessage = async (message: IncomingMessage) => {
    prepared.push(message.id);
    return { ...message, attachments: [{ status: "ready", type: "file", path: "/private/cache/report.csv", name: "report.csv", size: 12, sourceMessageId: "om_file" }] };
  };
  const workers: WorkerFactory = { async open() { return { async run(text, emit) {
    prompts.push(text); emit({ type: "done", text: "ok" });
  }, async close() {} }; }, async close() {} };
  const bot = new BotController({ config, stateDir: dir, transport, workers,
    authorizeUser: async (userId) => userId === "ou_allowed" });
  try {
    await bot.start();
    await bot.receive({ ...msg("denied", "ou_denied"), parentMessageId: "om_file" });
    await bot.receive({ ...msg("allowed", "ou_allowed"), parentMessageId: "om_file" });
    await bot.drain();
    assert.deepEqual(prepared, ["allowed"]);
    assert.match(prompts[0]!, /\/private\/cache\/report\.csv/);
    assert.match(prompts[0]!, /untrusted user input/);
  } finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
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
    const original = transport.update.bind(transport);
    transport.update = async (...args) => { await original(...args); if (args[1] === "other") otherDone.resolve(); };
    await otherDone.promise;
    assert.deepEqual(order, ["one", "other"]);
    gate.resolve(); await bot.drain();
    assert.deepEqual(order, ["one", "other", "two"]);
    assert(transport.sends.some((x) => x.text.includes("正在排队")));
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
    if (args[1].includes("消息过长或队列已满")) rejected.resolve();
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
    assert(!transport.sends.some((x) => x.text === "stopped"));
    assert(transport.updates.at(-1)?.includes("已停止"));
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
    assert(transport.updates.at(-1)?.includes("已停止"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stop during completion update prevents subsequent final answer sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-final-stop-"));
  const began = deferred(); const gate = deferred();
  const transport = new FakeTransport();
  transport.update = async (_id, text) => {
    if (text === "should-not-send") { began.resolve(); await gate.promise; }
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
    assert(transport.updates.includes("should-not-send"));
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
    assert(errors > 0); assert(transport.updates.includes("success"));
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

test("rejected senders get a code the operator can allowlist, and the picker list stays bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-denied-"));
  try {
    const transport = new FakeTransport();
    const workers: WorkerFactory = { async open() { return { async run() {}, async close() {} }; }, async close() {} };
    const bot = new BotController({ config, stateDir: dir, transport, workers, authorizeUser: async () => false });
    await bot.start();
    for (let i = 0; i < 25; i++) await bot.receive(msg(`m${i}`, `ou_user${i}`));
    await bot.receive(msg("again", "ou_user24"));
    await bot.drain();

    const denied = bot.listDenied();
    assert.equal(denied.length, 5, "the in-memory picker list is capped");
    assert.equal(new Set(denied.map((entry) => entry.userId)).size, 5, "one entry per sender");
    assert.equal(denied[0]!.userId, "ou_user24", "most recent first");
    assert(transport.sends.some((send) => send.text.includes(`授权码：${senderCode("ou_user24")}`)));

    assert.equal((await bot.allow("nonsense")).ok, false);
    assert.equal((await bot.allow(senderCode("ou_user24"))).ok, true);
    assert(!bot.listDenied().some((entry) => entry.userId === "ou_user24"), "allowlisting clears the pending entry");
    assert.equal(bot.status.allowlisted, 1);
    assert.equal((await bot.allow("ou_never_seen")).ok, true, "a full open_id needs no rejection history");
    assert.equal((await bot.deny(senderCode("ou_never_seen"))).ok, true, "deny resolves a code like allow does");
    assert.equal((await bot.deny("ou_never_seen")).ok, false);
    assert.equal((await bot.deny("")).ok, false);
    assert.equal(bot.status.allowlisted, 1);
    await bot.stop();

    const restored = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers });
    await restored.start();
    assert.equal(restored.status.allowlisted, 1, "manual allowlisting persists");
    assert.equal(restored.listDenied().length, 0, "rejection history never outlives the listener");
    await restored.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the push target is set from the worker's own chat, persists, and gates pushing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-push-"));
  try {
    const transport = new FakeTransport();
    const workers: WorkerFactory = {
      async open() { return { async run(_text, emit) { emit({ type: "done", text: "ok" }); }, async close() {} }; },
      async close() {},
    };
    const notices: string[] = [];
    const bot = new BotController({ config, stateDir: dir, transport, workers, onNotice: (text) => notices.push(text) });
    await bot.start();

    assert.equal((await bot.push("nothing yet")).ok, false, "no target means no pushing");
    assert.equal((await bot.handleWorkerRequest("group:oc_team", { action: "set-target" })).ok, false,
      "a worker with no seen conversation cannot set a target");

    const group: IncomingMessage = { id: "g1", userId: "ou_a", chatId: "oc_team", text: "hi", chatType: "group", mentionedBot: true };
    await bot.receive(group);
    await bot.drain();
    assert.equal((await bot.handleWorkerRequest("group:oc_team", { action: "set-target" })).ok, true);
    assert(notices.some((text) => text.includes("oc_team")));
    assert.deepEqual(bot.status.pushTarget, { chatId: "oc_team", chatType: "group" });

    transport.sends.length = 0;
    assert.equal((await bot.push("build finished")).ok, true);
    assert.deepEqual(transport.sends, [{ chat: "oc_team", text: "build finished", reply: undefined }],
      "a push is a plain message, never a reply");
    assert.equal((await bot.push("   ")).ok, false);
    await bot.stop();

    const restored = new BotController({ config, stateDir: dir, transport: new FakeTransport(), workers });
    await restored.start();
    assert.deepEqual(restored.status.pushTarget, { chatId: "oc_team", chatType: "group" });
    assert.equal((await restored.handleWorkerRequest("group:oc_team", { action: "clear-target" })).ok, true);
    assert.equal(restored.status.pushTarget, undefined);
    assert.equal((await restored.push("after clear")).ok, false);
    await restored.stop();

    const other = new BotController({ config: { ...config, appId: "cli_other" }, stateDir: dir, transport: new FakeTransport(), workers });
    await other.start();
    assert.equal(other.status.pushTarget, undefined, "a target never carries over to another app");
    await other.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pushes are rate limited and truncated, and stop with the listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lark-push-limit-"));
  try {
    const transport = new FakeTransport();
    const workers: WorkerFactory = { async open() { return { async run() {}, async close() {} }; }, async close() {} };
    const bot = new BotController({ config, stateDir: dir, transport, workers });
    await bot.start();
    await bot.setPushTarget({ version: 1, appId: config.appId, chatId: "oc_team", chatType: "group", setBy: "local", setAt: "" });

    const long = "x".repeat(200_000);
    transport.sends.length = 0;
    assert.equal((await bot.push(long)).ok, true);
    assert.equal(transport.sends.length, 4, "an oversized push is capped at four cards");
    assert(transport.sends.at(-1)!.text.endsWith("（内容过长，已截断）"));

    for (let i = 0; i < 15; i++) assert.equal((await bot.push(`n${i}`)).ok, true);
    assert.equal(transport.sends.length, 19);
    const wholePush = await bot.push(long);
    assert.equal(wholePush.ok, false, "a multi-card push is rejected rather than half sent");
    assert.equal(transport.sends.length, 19, "nothing was sent for the rejected push");
    assert.equal((await bot.push("last one")).ok, true, "a single card still fits the remaining budget");
    const blocked = await bot.push("one too many");
    assert.equal(blocked.ok, false);
    assert(blocked.text.includes("过于频繁"));

    await bot.stop();
    assert.equal((await bot.push("after stop")).ok, false);
    assert.equal((await bot.handleWorkerRequest("ou_a", { action: "push", text: "after stop" })).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
