import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZellijWorkers } from "../src/panes.ts";
import { BotController } from "../src/controller.ts";
import type { BotTransport, WorkerEvent } from "../src/types.ts";

const execFile = promisify(execFileCallback);
const enabled = process.env.PI_LARK_BOT_INTEGRATION === "1";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const timeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
async function listenMock(fixture: string) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push(body);
      const messages = JSON.parse(body).messages ?? [];
      const content = [...messages].reverse().find((message) => message.role === "user")?.content;
      const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish_reason?: string) => response.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: "echo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (prompt === "first prompt" && messages.at(-1)?.role !== "tool") {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "fixture-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: fixture }) } }] }, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "mock:" });
        if (prompt === "interrupt me") {
          await new Promise<void>((resolve) => response.once("close", resolve));
          return;
        }
        await delay(200); // cross worker/controller throttle windows
        chunk({ content: prompt }, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests };
}
async function run(worker: Awaited<ReturnType<ZellijWorkers["open"]>>, prompt: string) {
  const events: WorkerEvent[] = [];
  await timeout(worker.run(prompt, (event) => events.push(event)), 15000, "remote prompt");
  return events;
}
async function panes(): Promise<{ id: number; is_plugin: boolean; is_focused: boolean; tab_id: number }[]> {
  const { stdout, stderr } = await execFile("zellij", ["action", "list-panes", "--json", "--all"], { timeout: 5000 });
  assert(stdout.trim(), `Zellij list-panes returned no JSON: ${stderr}`);
  return JSON.parse(stdout);
}
async function paneIds(): Promise<Set<string>> {
  return new Set((await panes()).filter((pane) => !pane.is_plugin).map((pane) => `terminal_${pane.id}`));
}

test("real Zellij/pi: tools, streaming, native panes, isolation, crash recovery and history", { skip: !enabled, timeout: 100000 }, async () => {
  const session = process.env.PI_LARK_BOT_TEST_SESSION;
  assert(session?.startsWith("pi-lark-bot-test-") && process.env.ZELLIJ_SESSION_NAME === session,
    "Refusing to manipulate a working Zellij session; run npm run test:integration.");
  const parent = process.env.ZELLIJ_PANE_ID!; assert.match(parent, /^\d+$/);
  const root = await mkdtemp(join(tmpdir(), "pi-lark-bot-integration-"));
  const project = join(root, "project"); await mkdir(project);
  const fixture = join(project, "fixture.txt"); await writeFile(fixture, "harmless tool fixture");
  const mock = await listenMock(fixture);
  const common = { cwd: project, stateDir: join(root, "state"), appId: "integration-app",
    model: { provider: "mock", id: "echo" }, startupTimeoutMs: 15000,
    workerExtensionPath: resolve("test/fixtures/mock-worker-extension.ts"),
    env: { PI_CODING_AGENT_DIR: join(root, "pi"), LARK_BOT_MOCK_URL: mock.url },
  };
  let workers: ZellijWorkers | undefined, restored: ZellijWorkers | undefined, bridge: BotController | undefined;
  const owned = new Set<string>();
  const record = (factory: ZellijWorkers) => factory.list().forEach((pane) => { if (pane.paneId) owned.add(pane.paneId); });
  const assertPlacement = async () => {
    const current = await panes();
    const parentPane = current.find((p) => !p.is_plugin && p.id === Number(parent));
    assert(parentPane);
    assert(parentPane.is_focused, "must not steal parent focus");
    for (const id of owned) {
      const pane = current.find((p) => !p.is_plugin && `terminal_${p.id}` === id);
      if (pane) assert.equal(pane.tab_id, parentPane.tab_id);
    }
  };
  try {
    workers = new ZellijWorkers(common);
    const one = await timeout(workers.open("user-one"), 20000, "first pane startup"); record(workers);
    const first = await run(one, "first prompt");
    assert(first.some((event) => event.type === "progress" && event.text === "正在调用工具：read"), JSON.stringify(first));
    assert(first.some((event) => event.type === "text" && event.text === "mock:"));
    assert.deepEqual(first.at(-1), { type: "done", text: "mock:first prompt", error: false });
    assert.strictEqual(await workers.open("user-one"), one);
    const two = await timeout(workers.open("user-two"), 20000, "second pane startup"); record(workers);
    assert.notStrictEqual(two, one); await assertPlacement();
    if (process.env.PI_LARK_BOT_SIBLING_TEST === "1") {
      const sibling = await import(pathToFileURL(resolve("../pi-interactive-subagents/pi-extension/subagents/zellij.ts")).href);
      const extra: string = sibling.createSurface("layout-fixture"); owned.add(extra);
      try { await assertPlacement(); } finally { sibling.closeSurface(extra); }
      await assertPlacement();
    }
    await run(two, "separate user");
    assert(!mock.requests.at(-1)!.includes("first prompt"));
    await run(one, "second prompt");
    assert(mock.requests.at(-1)!.includes("first prompt"));
    assert(!mock.requests.at(-1)!.includes("separate user"));
    const abort = new AbortController(), interrupted: WorkerEvent[] = [];
    await timeout(one.run("interrupt me", (event) => {
      interrupted.push(event);
      if (event.type === "text" && event.text === "mock:") abort.abort();
    }, abort.signal), 15000, "interrupt active Pi turn");
    assert.equal(abort.signal.aborted, true);
    assert.match(interrupted.at(-1)!.text, /已停止/);
    assert.equal((interrupted.at(-1) as { error?: boolean }).error, false);
    assert.strictEqual(await workers.open("user-one"), one);
    await run(one, "after interrupt");
    assert(mock.requests.at(-1)!.includes("first prompt"));
    const crashed = workers.list().find((pane) => pane.userId === "user-one")!.paneId!;
    await execFile("zellij", ["action", "close-pane", "--pane-id", crashed], { timeout: 5000 });
    await delay(100);
    const recovered = await timeout(workers.open("user-one"), 20000, "crash replacement"); record(workers);
    assert.notStrictEqual(recovered, one);
    await run(recovered, "after crash"); assert(mock.requests.at(-1)!.includes("first prompt"));
    await workers.close(); workers = undefined;
    for (const id of owned) assert(!(await paneIds()).has(id), `owned pane ${id} must close after stop`);
    restored = new ZellijWorkers(common);
    const resumed = await timeout(restored.open("user-one"), 20000, "restored pane"); record(restored);
    await run(resumed, "after restart");
    const request = mock.requests.at(-1)!;
    assert(request.includes("first prompt") && request.includes("second prompt") && request.includes("after crash"));
    await restored.close(); restored = undefined;
    const outbound: string[] = [], edits: string[] = [];
    const transport: BotTransport = { async start() {}, async stop() {},
      async send(_chat, text) { outbound.push(text); return `card-${outbound.length}`; }, async update(_id, text) { edits.push(text); } };
    const botWorkers = new ZellijWorkers(common);
    bridge = new BotController({ config: { version: 1, brand: "feishu", appId: "integration-app", appSecret: "fixture" },
      stateDir: common.stateDir, workers: botWorkers, transport, streamInterval: 20 });
    await bridge.start(); await bridge.receive({ id: "message-1", userId: "ou_owner", chatId: "chat", text: "first prompt" });
    await timeout(bridge.drain(), 25000, "bot reply"); record(botWorkers);
    assert(edits.includes("mock:first prompt"));
    assert(edits.some((text) => text.includes("read") || text.includes("mock:")));
    await bridge.receive({ id: "group-1", userId: "ou_owner", chatId: "oc_room", chatType: "group", mentionedBot: true, text: "group first" });
    await timeout(bridge.drain(), 25000, "first group reply"); record(botWorkers);
    const groupPane = botWorkers.list().find((pane) => pane.userId === "group:oc_room")!;
    assert(groupPane && groupPane.paneId !== botWorkers.list().find((pane) => pane.userId === "ou_owner")?.paneId);
    await bridge.receive({ id: "group-2", userId: "ou_other", chatId: "oc_room", chatType: "group", mentionedBot: true, text: "group second" });
    await timeout(bridge.drain(), 25000, "second group reply");
    assert.equal(botWorkers.list().find((pane) => pane.userId === "group:oc_room")?.paneId, groupPane.paneId);
    assert(mock.requests.at(-1)!.includes("ou_owner: group first"));
    assert(!mock.requests.at(-1)!.includes('"first prompt"'));
    assert(edits.includes("mock:ou_other: group second"));
    await bridge.stop(); bridge = undefined;
    restored = new ZellijWorkers(common);
    const groupResumed = await restored.open("group:oc_room"); record(restored);
    await run(groupResumed, "after group restart");
    assert(mock.requests.at(-1)!.includes("ou_other: group second"));
    await restored.close(); restored = undefined;
    const remaining = await paneIds();
    for (const id of owned) assert(!remaining.has(id), `leaked pane ${id}`);
  } finally {
    await bridge?.stop(); await restored?.close(); await workers?.close();
    mock.server.closeAllConnections();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
