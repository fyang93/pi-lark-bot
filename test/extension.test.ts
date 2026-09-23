import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.ts";
import { acquireLock, prepareState, readPrivateJson, writePrivateJson } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function harness(cwd: string) {
  const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const messages: string[] = [];
  const tools = new Map<string, any>(); let activeTools: string[] = ["read", "bash"];
  extension({ registerCommand(name: string, value: unknown) { commands.set(name, value); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) { activeTools = names; },
    on(name: string, handler: unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const selections: string[] = [];
  const ctx = { cwd, mode: "tui", isProjectTrusted: () => true,
    ui: { notify: (text: string) => messages.push(text), setStatus() {}, theme: { fg: (_color: string, text: string) => text },
      select: async (_title: string, options: string[]) => { selections.push(...options); return undefined; } } } as unknown as ExtensionCommandContext;
  return { commands, handlers, messages, tools, selections, ctx, activeTools: () => activeTools };
}

test("loading extension is inert; /lark-bot defaults to status and never writes credentials", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-extension-"));
  try {
    const h = harness(cwd);
    assert.deepEqual([...h.commands.keys()], ["lark-bot"]);
    assert.deepEqual([...h.tools.keys()], [], "loading registers no tool");
    assert.deepEqual([...h.handlers.keys()], ["session_shutdown"]);
    assert.deepEqual(await readdir(cwd), []);
    await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("not connected"));
    assert(h.messages.at(-1)?.includes("stopped"));
    assert.deepEqual(await readdir(cwd), []);
    await h.handlers.get("session_shutdown")();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("status reports a project lock held by another controller instance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-extension-lock-"));
  const stateDir = await prepareState(cwd, ".pi"); const unlock = await acquireLock(stateDir);
  try {
    const h = harness(cwd); await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("another pi holds the project lock"));
  } finally { await unlock(); await rm(cwd, { recursive: true, force: true }); }
});

test("worker process never registers a second bot listener command", () => {
  const old = process.env.PI_LARK_BOT_WORKER;
  process.env.PI_LARK_BOT_WORKER = "1";
  try { const h = harness("/tmp"); assert.equal(h.commands.size, 0); assert.equal(h.handlers.size, 0); }
  finally { if (old === undefined) delete process.env.PI_LARK_BOT_WORKER; else process.env.PI_LARK_BOT_WORKER = old; }
});

test("untrusted project commands are rejected and unknown commands show help", async () => {
  const h = harness("/does-not-exist");
  h.ctx.isProjectTrusted = () => false;
  await h.commands.get("lark-bot").handler("on", h.ctx);
  assert(h.messages.at(-1)?.includes("Trust"));
  await h.commands.get("lark-bot").handler("unknown", h.ctx);
  assert(h.messages.at(-1)?.includes("/lark-bot link"));
});

test("/lark-bot allow, deny and push edit project state without starting a listener", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-local-"));
  try {
    const h = harness(cwd);
    const run = (args: string) => h.commands.get("lark-bot").handler(args, h.ctx);

    await run("push");
    assert(h.messages.at(-1)?.includes("link first"), "every local edit needs credentials");

    const stateDir = await prepareState(cwd, ".pi");
    await writePrivateJson(join(stateDir, "config.json"),
      { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" });

    await run("push");
    assert(h.messages.at(-1)?.includes("No push target configured"));

    await run("allow");
    assert(h.messages.at(-1)?.includes("No recent rejections"), "codes need a running listener to resolve");
    await run("allow not-an-id");
    assert(h.messages.at(-1)?.includes("Not a valid open_id"));

    await run("allow ou_alice0001");
    assert(h.messages.at(-1)?.includes("Allowlisted ou_alice0001"));
    assert.deepEqual(await readPrivateJson(join(stateDir, "allowlist.json")),
      { appId: "cli_test", users: ["ou_alice0001"] });
    await run("allow ou_alice0001");
    assert(h.messages.at(-1)?.includes("already allowlisted"));

    await run("deny ou_alice0001");
    assert.deepEqual(await readPrivateJson(join(stateDir, "allowlist.json")), { appId: "cli_test", users: [] });
    await run("deny ou_alice0001");
    assert(h.messages.at(-1)?.includes("not allowlisted"));

    await writePrivateJson(join(stateDir, "push-target.json"),
      { version: 1, appId: "cli_test", chatId: "oc_team", chatType: "group", setBy: "group:oc_team", setAt: "" });
    await run("push");
    assert(h.messages.at(-1)?.includes("group oc_team"));
    await run("push off");
    assert(h.messages.at(-1)?.includes("push target cleared"));
    await run("push");
    assert(h.messages.at(-1)?.includes("No push target configured"));

    assert.deepEqual([...h.tools.keys()], [], "the push tool appears only while this pi listens");
    assert.deepEqual(h.activeTools(), ["read", "bash"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
