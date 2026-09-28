import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.ts";
import { LarkTransport } from "../src/lark.ts";
import { permissionInstructions } from "../src/registration.ts";
import { acquireLock, prepareState, readPrivateJson, writePrivateJson } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function harness(cwd: string) {
  const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const messages: string[] = [];
  const tools = new Map<string, any>(); let activeTools: string[] = ["read", "bash"];
  extension({ registerCommand(name: string, value: unknown) { commands.set(name, value); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getThinkingLevel: () => "off",
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) { activeTools = names; },
    on(name: string, handler: unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const selections: string[] = [];
  const ctx = { cwd, mode: "tui", isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [] },
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
    assert.deepEqual([...h.handlers.keys()], ["session_before_switch", "session_before_fork", "session_shutdown", "session_start"]);
    // No listener means no interruption: /new must stay silent when the bot is off.
    let asked = 0;
    const probe = { ui: { confirm: async () => { asked++; return true; } } };
    assert.equal(await h.handlers.get("session_before_switch")({ reason: "new" }, probe), undefined);
    assert.equal(await h.handlers.get("session_before_fork")({ position: "at" }, probe), undefined);
    assert.equal(asked, 0);
    assert.deepEqual(await readdir(cwd), []);
    await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("not connected"));
    assert(h.messages.at(-1)?.includes("stopped"));
    assert.deepEqual(await readdir(cwd), []);
    await h.handlers.get("session_shutdown")();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("/new restores an enabled listener once in a fresh runtime; off and quit stay off", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-new-"));
  const env = { PATH: process.env.PATH, ZELLIJ: process.env.ZELLIJ, ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID };
  let starts = 0, stops = 0, confirmations = 0;
  t.mock.method(LarkTransport.prototype, "start", async () => { starts++; });
  t.mock.method(LarkTransport.prototype, "stop", async () => { stops++; });
  let h = harness(cwd);
  const configure = () => { h.ctx.ui.confirm = async () => { confirmations++; return true; }; };
  try {
    await writeFile(join(cwd, "zellij"), '#!/bin/sh\necho "zellij 0.44.0"\n', { mode: 0o700 });
    process.env.PATH = `${cwd}:${env.PATH}`;
    process.env.ZELLIJ = "1"; process.env.ZELLIJ_PANE_ID = "0";
    const stateDir = await prepareState(cwd, ".pi");
    await writePrivateJson(join(stateDir, "config.json"),
      { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" });
    configure();
    await h.commands.get("lark-bot").handler("on", h.ctx);
    assert.equal(starts, 1, h.messages.join("\n"));
    assert(h.activeTools().includes("lark_push"));
    for (let i = 0; i < 2; i++) {
      await h.handlers.get("session_before_switch")({ reason: "new" }, h.ctx);
      assert.equal(confirmations, 1, "/new needs no further authorization");
      await h.handlers.get("session_shutdown")({ reason: "new" }, h.ctx);
      assert(!h.activeTools().includes("lark_push"));
      assert.equal(stops, i + 1);
      h = harness(cwd); configure();
      await h.handlers.get("session_start")({ reason: "new" }, h.ctx);
      assert.equal(starts, i + 2, h.messages.join("\n"));
      assert(h.activeTools().includes("lark_push"));
      await h.handlers.get("session_start")({ reason: "new" }, h.ctx);
      assert.equal(starts, i + 2, "handoff is consumed once");
    }
    await h.commands.get("lark-bot").handler("off", h.ctx);
    await h.handlers.get("session_shutdown")({ reason: "new" }, h.ctx);
    h = harness(cwd); configure();
    await h.handlers.get("session_start")({ reason: "new" }, h.ctx);
    assert.equal(starts, 3, "off must not be restored");
    for (const reason of ["quit", "reload", "resume", "fork"]) {
      await h.commands.get("lark-bot").handler("on", h.ctx);
      const before: number = starts;
      await h.handlers.get("session_shutdown")({ reason }, h.ctx);
      h = harness(cwd); configure();
      await h.handlers.get("session_start")({ reason: reason === "quit" ? "startup" : reason }, h.ctx);
      assert.equal(starts, before, `${reason} must not restore listening`);
    }
    for (const guard of ["trust", "cwd", "mode", "credentials"]) {
      await h.commands.get("lark-bot").handler("on", h.ctx);
      const before: number = starts;
      await h.handlers.get("session_shutdown")({ reason: "new" }, h.ctx);
      h = harness(cwd); configure();
      const ctx = { ...h.ctx };
      if (guard === "trust") ctx.isProjectTrusted = () => false;
      if (guard === "cwd") ctx.cwd = tmpdir();
      if (guard === "mode") ctx.mode = "rpc";
      if (guard === "credentials") await writePrivateJson(join(stateDir, "config.json"),
        { version: 1, brand: "feishu", appId: "cli_changed", appSecret: "secret" });
      await h.handlers.get("session_start")({ reason: "new" }, ctx);
      assert.equal(starts, before, `${guard} must prevent automatic restoration`);
      await h.handlers.get("session_start")({ reason: "new" }, h.ctx);
      assert.equal(starts, before, "rejected handoff must not linger");
    }
  } finally {
    await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("status reports a project lock held by another controller instance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-extension-lock-"));
  const stateDir = await prepareState(cwd, ".pi"); const unlock = await acquireLock(stateDir);
  try {
    const h = harness(cwd); await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("another pi holds the project lock"));
  } finally { await unlock(); await rm(cwd, { recursive: true, force: true }); }
});

test("link only shows a permission dialog when grants are missing or unknown", async () => {
  const originalFetch = globalThis.fetch;
  const required = new URL(permissionInstructions({ brand: "feishu", appId: "cli_test" }).split("\n")[1]!)
    .searchParams.get("scopes")!.split(",");
  try {
    for (const state of ["granted", "missing", "unknown"]) {
      const cwd = await mkdtemp(join(tmpdir(), "lark-link-"));
      try {
        const h = harness(cwd);
        let choice = 0;
        const dialogs: string[] = [];
        h.ctx.ui.select = async () => choice++ === 0 ? "Feishu" : "Enter existing App ID / App Secret";
        h.ctx.ui.input = async () => "cli_test";
        h.ctx.ui.confirm = async (_title, body) => { dialogs.push(body); return true; };
        h.ctx.ui.custom = (async (factory: any) => new Promise((resolve) => {
          const component = factory({ requestRender() {} }, {}, {}, resolve);
          component.handleInput("private-secret"); component.handleInput("\r"); component.dispose();
        })) as typeof h.ctx.ui.custom;
        globalThis.fetch = (async (input) => {
          if (state === "unknown") throw new Error("private-secret");
          return new Response(JSON.stringify(String(input).includes("tenant_access_token")
            ? { code: 0, tenant_access_token: "token" }
            : { code: 0, data: { scopes: required.slice(state === "missing" ? 1 : 0)
              .map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 })) } }),
          { headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        await h.commands.get("lark-bot").handler("link", h.ctx);
        assert.equal(dialogs.length, state === "granted" ? 0 : 1);
        if (dialogs.length) assert(dialogs[0]!.includes("https://open.feishu.cn/page/scope-apply?"));
        assert(![...h.messages, ...dialogs].join("\n").includes("private-secret"));
        const stored = await readPrivateJson(join(cwd, ".pi/lark-bot/config.json")) as { appId: string };
        assert.equal(stored.appId, "cli_test", "failed checks must not discard saved credentials");
        assert.equal(h.tools.size, 0, "link never starts the listener");
        assert(!h.commands.get("lark-bot").getArgumentCompletions("").includes("permissions"));
      } finally { await rm(cwd, { recursive: true, force: true }); }
    }
  } finally { globalThis.fetch = originalFetch; }
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
