import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker-extension.ts";

async function harness(t: TestContext, options: { fail?: boolean } = {}) {
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
  const handlers = new Map<string, Function>();
  t.after(async () => {
    handlers.get("session_shutdown")?.(); peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  });
  const path = join(root, "worker.sock");
  await new Promise<void>((resolve) => server.listen(path, resolve));
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, { PI_LARK_BOT_SOCKET: path, PI_LARK_BOT_RUN_ID: "run", PI_LARK_BOT_TOKEN: "token" });
  const prompts: { text: string; options: any }[] = [];
  let aborts = 0, shutdowns = 0;
  const context = { isIdle: () => false, hasPendingMessages: () => true,
    abort() { aborts++; }, shutdown() { shutdowns++; }, ui: { notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } } };
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
  const tools = new Map<string, any>();
  workerExtension({ on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    sendUserMessage(text: string, opts: any) {
      prompts.push({ text, options: opts });
      if (options.fail) throw new Error("private error");
    },
  } as never);
  emit("session_start"); await connection;
  const next = (): Promise<any> => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => readers.push(resolve));
  const until = async (type: string) => { for (;;) { const value = await next(); if (value.type === type) return value; } };
  assert.deepEqual(await next(), { type: "hello", runId: "run", token: "token" });
  assert.deepEqual(await next(), { type: "ready" });
  return { messages, prompts, tools, next, until, emit,
    get aborts() { return aborts; }, get shutdowns() { return shutdowns; },
    send(message: object) { peer!.write(`${JSON.stringify(message)}\n`); },
    disconnect() { peer!.destroy(); },
    finish(text: string, stopReason = "stop") {
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason };
      emit("message_start", { message }); emit("message_update", { message }); emit("message_end", { message });
      emit("agent_end", { messages: [message] }); emit("agent_settled");
    },
  };
}

test("busy Pi accepts successive follow-ups without waiting for any answer, even with a dialog open", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.emit("ui_prompt_start");
  for (const id of ["first", "second", "/not-a-command"]) {
    h.send({ type: "prompt", id, text: id });
    assert.deepEqual(await h.until("accepted"), { type: "accepted", id });
  }
  assert.deepEqual(h.prompts, ["first", "second", "/not-a-command"].map((text) => ({ text,
    options: { deliverAs: "followUp", expandPromptTemplates: false } })));
  assert.equal(h.messages.some((m) => m.type === "done"), false);
});

test("output is chat-wide: subagent results inside a turn or later both finish without special lifecycle guesses", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  h.send({ type: "prompt", id: "first", text: "question" }); await h.until("accepted");
  h.emit("tool_execution_start", { toolName: "subagent" }); await h.until("progress");
  h.emit("message_end", { message: { role: "custom", customType: "subagent_result", content: "private payload" } });
  h.finish("final answer");
  assert.deepEqual(await h.until("done"), { type: "done", text: "final answer", error: false });
  h.emit("before_agent_start", { prompt: "background continuation" }); h.finish("later answer");
  assert.equal((await h.until("done")).text, "later answer");
  h.send({ type: "prompt", id: "next", text: "next question" }); await h.until("accepted");
  h.finish("next answer"); assert.equal((await h.until("done")).text, "next answer");
  assert(!h.messages.some((m) => m.text?.includes("private payload")));
});

test("chat pane local assistant output is forwarded, but thinking and tool result bodies are not", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.send({ type: "prompt", id: "first", text: "hi" }); await h.until("accepted");
  h.emit("input", { source: "interactive", text: "local message" });
  h.emit("message_end", { message: { role: "toolResult", content: "secret tool body" } });
  h.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }] } });
  h.finish("local assistant reply");
  assert.equal((await h.until("done")).text, "local assistant reply");
  assert(!JSON.stringify(h.messages).includes("secret"));
});

test("abort is chat-scoped and acknowledged separately from assistant output", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.send({ type: "prompt", id: "p", text: "hi" }); await h.until("accepted");
  h.send({ type: "abort", id: "stop" });
  assert.deepEqual(await h.until("accepted"), { type: "accepted", id: "stop" });
  assert.equal(h.aborts, 1);
  h.finish("partial", "aborted"); assert.match((await h.until("done")).text, /已停止/);
  h.send({ type: "prompt", id: "next", text: "next" }); await h.until("accepted");
  assert.equal(h.prompts.length, 2); assert.equal(h.shutdowns, 0);
});

test("handoff failures are rejected once without exposing errors or auto-retrying", { timeout: 3000 }, async (t) => {
  const h = await harness(t, { fail: true }); h.send({ type: "prompt", id: "p", text: "hi" });
  assert.deepEqual(await h.next(), { type: "rejected", id: "p" });
  assert.equal(h.prompts.length, 1);
});

test("long idle periods do not close the bridge", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000 });
  const h = await harness(t); h.send({ type: "prompt", id: "p", text: "hi" }); await h.until("accepted");
  h.finish("answer"); await h.until("done");
  t.mock.timers.tick(24 * 60 * 60_000);
  h.send({ type: "prompt", id: "next", text: "tomorrow" }); await h.until("accepted");
  assert.equal(h.shutdowns, 0); assert.equal(h.aborts, 0);
});

test("model turns do not receive chat identity system prompts", async (t) => {
  const h = await harness(t);
  assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("push tools use controller IPC and do not carry chat credentials", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const result = h.tools.get("lark_push").execute("call", { text: "notice" });
  const request = await h.until("request");
  assert.equal(request.action, "push"); assert.equal(request.text, "notice");
  h.send({ type: "response", id: request.id, ok: true, text: "sent" });
  assert.match(JSON.stringify(await result), /sent/);
});
