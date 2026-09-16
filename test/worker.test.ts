import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker-extension.ts";

async function harness(t: TestContext, options: { idle?: boolean; accept?: boolean } = {}) {
  const keys = ["PI_LARK_BOT_SOCKET", "PI_LARK_BOT_RUN_ID", "PI_LARK_BOT_TOKEN", "PI_LARK_BOT_WORKER"];
  const old = keys.map((key) => process.env[key]);
  const root = await mkdtemp(join(tmpdir(), "pi-lark-worker-test-"));
  let peer: Socket | undefined;
  const messages: any[] = [], inbox: any[] = [], readers: ((value: any) => void)[] = [];
  let connected!: () => void;
  const connection = new Promise<void>((resolve) => { connected = resolve; });
  const server = createServer((socket) => {
    peer = socket; socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk; let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        messages.push(value); const reader = readers.shift(); if (reader) reader(value); else inbox.push(value);
      }
    });
    connected();
  });
  t.after(async () => {
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  });
  const path = join(root, "worker.sock");
  await new Promise<void>((resolve) => server.listen(path, resolve));
  Object.assign(process.env, { PI_LARK_BOT_SOCKET: path, PI_LARK_BOT_RUN_ID: "run", PI_LARK_BOT_TOKEN: "token" });
  delete process.env.PI_LARK_BOT_WORKER; // never use a real process-exit fallback inside a unit test
  const handlers = new Map<string, Function>();
  let idle = options.idle ?? true;
  const prompts: string[] = [];
  let shutdownResolve!: () => void, submittedResolve!: () => void;
  const shutdown = new Promise<void>((resolve) => { shutdownResolve = resolve; });
  const submitted = new Promise<void>((resolve) => { submittedResolve = resolve; });
  const context = { isIdle: () => idle, async abort() {}, shutdown: shutdownResolve, ui: { notify() {}, setStatus() {} } };
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
  workerExtension({ on(name: string, handler: Function) { handlers.set(name, handler); },
    sendUserMessage(text: string) {
      prompts.push(text); submittedResolve();
      if (options.accept !== false) { emit("input", { source: "extension", text }); emit("before_agent_start", { prompt: text }); }
    },
  } as never);
  emit("session_start"); await connection;
  const next = (): Promise<any> => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => readers.push(resolve));
  const until = async (type: string) => { for (;;) { const value = await next(); if (value.type === type) return value; } };
  assert.deepEqual(await next(), { type: "hello", runId: "run", token: "token" });
  assert.deepEqual(await next(), { type: "ready" });
  return { messages, prompts, next, until, emit, submitted, shutdown,
    idle(value: boolean) { idle = value; },
    prompt(text = "hello") { peer!.write(`${JSON.stringify({ type: "prompt", id: "p1", text })}\n`); },
    disconnect() { peer!.destroy(); },
    finish(text: string, failed = false) {
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: failed ? "error" : "stop" };
      emit("message_start", { message }); emit("message_update", { message }); emit("message_end", { message });
      emit("agent_end", { messages: [message] }); emit("agent_settled");
    },
  };
}

test("worker authenticates IPC, coalesces text and forces its final snapshot", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.prompt();
  assert.deepEqual(await h.next(), { type: "progress", text: "正在处理中…", id: "p1" });
  for (let i = 0; i < 100; i++) h.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: `draft-${i}` }] } });
  h.finish("Hi");
  assert.deepEqual(await h.until("text"), { type: "text", text: "Hi", id: "p1" });
  assert.deepEqual(await h.until("done"), { type: "done", id: "p1", text: "Hi" });
  assert.equal(h.messages.filter((event) => event.type === "text").length, 1);
});

test("forwards later non-interactive extension turns through the original remote channel", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.prompt(); await h.until("progress"); h.finish("初始回复"); await h.until("done");
  h.emit("before_agent_start", { prompt: "extension continuation" });
  h.finish("后续回复");
  assert.equal((await h.until("done")).text, "后续回复");
});

test("keeps the remote reply open until a spawned subagent's steered result settles", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.prompt(); await h.until("progress");
  h.emit("tool_execution_start", { toolName: "subagent" });
  await h.until("progress");
  h.emit("agent_settled");
  assert.equal((await h.until("progress")).text, "正在等待子代理完成…");
  h.emit("before_agent_start", { prompt: "subagent result" });
  h.finish("子代理结果已整理");
  assert.equal((await h.until("done")).text, "子代理结果已整理");
});

test("local output is private; remote prompt waits until local agent fully settles", { timeout: 3000 }, async (t) => {
  const h = await harness(t, { idle: false }); h.prompt("remote question");
  assert.match((await h.next()).text, /正在等待/);
  h.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "local-secret" }] } });
  h.emit("agent_settled"); assert.equal(h.prompts.length, 0);
  h.idle(true); h.emit("agent_settled");
  assert.equal((await h.until("progress")).text, "正在处理中…");
  assert.deepEqual(h.prompts, ["remote question"]);
  h.finish("public answer"); await h.until("done");
  assert(!JSON.stringify(h.messages).includes("local-secret"));
});

test("64,000-byte prompts survive JSON escaping and socket chunking", { timeout: 3000 }, async (t) => {
  const h = await harness(t); const text = "\u0001".repeat(64_000); h.prompt(text);
  await h.until("progress"); assert.equal(h.prompts[0], text);
  h.finish("accepted"); assert.equal((await h.until("done")).text, "accepted");
});

test("controller loss while pending never starts a ghost turn", { timeout: 3000 }, async (t) => {
  const h = await harness(t, { idle: false }); h.prompt(); await h.until("progress");
  h.disconnect(); await h.shutdown;
  h.idle(true); h.emit("agent_settled");
  assert.deepEqual(h.prompts, []);
});

test("retry/tool turns reset drafts; local confirmation progress is forwarded without arguments", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.prompt(); await h.until("progress");
  h.emit("tool_execution_start", { toolName: "read", args: { secret: "never-forward" } });
  assert.equal((await h.next()).text, "正在调用工具：read");
  h.emit("ui_prompt_start"); assert.match((await h.next()).text, /正在等待本地确认/);
  h.emit("ui_prompt_end"); assert.equal((await h.next()).text, "正在处理中…");
  h.idle(false); h.finish("temporary failure", true);
  h.idle(true); h.finish("recovered");
  const done = await h.until("done");
  assert.equal(done.text, "recovered"); assert.equal(done.error, undefined);
  assert(!JSON.stringify(h.messages).includes("never-forward"));
});

test("an intercepted handoff times out and shuts down rather than hanging or accepting later prompts", { timeout: 3000 }, async (t) => {
  const h = await harness(t, { accept: false });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.prompt(); await h.submitted;
  t.mock.timers.tick(10_000);
  assert.equal((await h.until("done")).error, true);
  await h.shutdown;
  assert.deepEqual(h.prompts, ["hello"]);
});
