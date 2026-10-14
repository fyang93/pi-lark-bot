import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import extension from "../src/index.ts";
import { pushViaOwner } from "../src/push-ipc.ts";
import { LarkTransport } from "../src/lark.ts";
import { BotController } from "../src/controller.ts";
import { permissionInstructions } from "../src/registration.ts";
import { acquireLock, inspectLock, prepareState, readPrivateJson, writePrivateJson } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function harness(cwd: string) {
  const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
  const tools = new Map<string, any>(); let activeTools: string[] = ["read", "bash"];
  extension({ registerCommand(name: string, value: unknown) { commands.set(name, value); },
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getThinkingLevel: () => "off",
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) { activeTools = names; },
    on(name: string, handler: unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const selections: string[] = [];
  const ctx = { cwd, mode: "tui", isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [] },
    ui: { notify: (text: string) => messages.push(text), setStatus(_key: string, text?: string) { statuses.push(text); }, theme: { fg: (_color: string, text: string) => text },
      select: async (_title: string, options: string[]) => { selections.push(...options); return undefined; } } } as unknown as ExtensionCommandContext;
  return { commands, handlers, messages, statuses, tools, selections, ctx, activeTools: () => activeTools };
}

test("loading extension is inert; /lark-bot defaults to status and never writes credentials", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-extension-"));
  try {
    const h = harness(cwd);
    assert.deepEqual([...h.commands.keys()], ["lark-bot"]);
    assert.deepEqual([...h.tools.keys()], ["lark_push"], "every local Pi has the outbound tool");
    assert.deepEqual([...h.handlers.keys()], ["session_before_switch", "session_before_fork", "session_shutdown", "session_start"]);
    // No listener means no interruption: /new must stay silent when the bot is off.
    let asked = 0;
    const probe = { ui: { confirm: async () => { asked++; return true; } } };
    assert.equal(await h.handlers.get("session_before_switch")({ reason: "new" }, probe), undefined);
    assert.equal(await h.handlers.get("session_before_fork")({ position: "at" }, probe), undefined);
    assert.equal(asked, 0);
    assert.deepEqual(await readdir(cwd), []);
    await assert.rejects(h.tools.get("lark_push").execute("call", { text: "hello" }, undefined, undefined, h.ctx), /not listening/);
    await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("not connected"));
    assert(h.messages.at(-1)?.includes("stopped"));
    assert.deepEqual(await readdir(cwd), []);
    await h.handlers.get("session_shutdown")();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert(check(), "peer status did not update");
}

test("linked on persists across launches; two sessions elect one listener; off stays off", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-new-"));
  const env = { PATH: process.env.PATH, ZELLIJ: process.env.ZELLIJ, ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID };
  let starts = 0, stops = 0, confirmations = 0;
  const sent: Array<{ chat: string; text: string }> = [];
  t.mock.method(LarkTransport.prototype, "start", async () => { starts++; });
  t.mock.method(LarkTransport.prototype, "stop", async () => { stops++; });
  t.mock.method(LarkTransport.prototype, "send", async (chat: string, text: string) => {
    sent.push({ chat, text }); return `m_${sent.length}`;
  });
  const sessions: ReturnType<typeof harness>[] = [];
  const next = () => { const h = harness(cwd); h.ctx.ui.confirm = async () => { confirmations++; return true; }; sessions.push(h); return h; };
  try {
    await writeFile(join(cwd, "zellij"), '#!/bin/sh\necho "zellij 0.44.0"\n', { mode: 0o700 });
    process.env.PATH = `${cwd}:${env.PATH}`;
    process.env.ZELLIJ = "1"; process.env.ZELLIJ_PANE_ID = "0";
    const stateDir = await prepareState(cwd, ".pi");
    const first = next();
    await first.handlers.get("session_start")({ reason: "startup" }, first.ctx);
    assert.equal(starts, 0, "unlinked projects stay off");
    assert.equal(first.statuses.at(-1), undefined, "unlinked project has no Lark status");
    await writePrivateJson(join(stateDir, "config.json"),
      { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" });
    await writePrivateJson(join(stateDir, "push-target.json"),
      { version: 1, appId: "cli_test", chatId: "oc_team", chatType: "group", setBy: "group:oc_team", setAt: "" });
    const second = next();
    await second.handlers.get("session_start")({ reason: "startup" }, second.ctx);
    assert.equal(starts, 0, "link alone stays off");
    assert.equal(second.statuses.length, 0, "link alone has no Lark status");
    await first.commands.get("lark-bot").handler("on", first.ctx);
    assert.equal(starts, 1, first.messages.join("\n"));
    assert.equal(first.statuses.at(-1), "🐤 Feishu: on");
    assert.deepEqual(await readPrivateJson(join(stateDir, "enabled.json")), { appId: "cli_test", enabled: true });
    await waitFor(() => second.statuses.at(-1) === "🐤 Feishu: push");
    await second.handlers.get("session_start")({ reason: "startup" }, second.ctx);
    assert.equal(starts, 1, "the existing owner keeps the sole listener");
    assert.equal(second.statuses.at(-1), "🐤 Feishu: push");
    await first.handlers.get("session_start")({ reason: "resume" }, first.ctx);
    assert.equal(first.statuses.at(-1), "🐤 Feishu: on", "owner remains on");
    const untrusted = next(); untrusted.ctx.isProjectTrusted = () => false;
    await untrusted.handlers.get("session_start")({ reason: "startup" }, untrusted.ctx);
    assert.equal(untrusted.statuses.length, 0, "untrusted session has no Lark status");
    assert(second.activeTools().includes("lark_push"), "non-owner has a real push tool");
    assert(first.activeTools().includes("lark_push"));
    const push = (h: ReturnType<typeof harness>, text: string) =>
      h.tools.get("lark_push").execute("call", { text }, undefined, undefined, h.ctx);
    await push(second, "from non-owner");
    assert.deepEqual(sent, [{ chat: "oc_team", text: "from non-owner" }]);
    const endpoint = await readPrivateJson(join(stateDir, "push-endpoint.json")) as { socket: string; cwd: string; appId: string };
    const forged = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(endpoint.socket); let data = "";
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({ token: "wrong", cwd: endpoint.cwd, appId: endpoint.appId, text: "forged" }) + "\n"));
      socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { socket.destroy(); resolve(data); } });
    });
    assert.match(forged, /Unauthorized push request/);
    assert.equal((await pushViaOwner(stateDir, cwd, "cli_wrong", "wrong app")).ok, false);
    assert.equal(sent.length, 1, "forged and mismatched requests never send");
    for (let i = 1; i < 20; i++) await push(i % 2 ? first : second, `shared ${i}`);
    await assert.rejects(push(second, "over limit"), /每分钟最多 20/);
    assert.equal(sent.length, 20, "all local sessions share the controller's push limit");
    await second.commands.get("lark-bot").handler("off", second.ctx);
    assert(second.messages.at(-1)?.includes("Another pi holds the project lock"));
    assert.equal(stops, 0, "a non-owner cannot stop the owner");
    assert.deepEqual(await readPrivateJson(join(stateDir, "enabled.json")), { appId: "cli_test", enabled: true });
    await first.handlers.get("session_shutdown")({ reason: "quit" }, first.ctx);
    assert.equal(stops, 1);
    await assert.rejects(readPrivateJson(join(stateDir, "push-endpoint.json")), /ENOENT/);
    const third = next();
    const status = Object.getOwnPropertyDescriptor(BotController.prototype, "status")!;
    Object.defineProperty(BotController.prototype, "status", {
      ...status, get() { return { ...status.get!.call(this), queued: 2 }; },
    });
    try {
      await third.handlers.get("session_start")({ reason: "startup" }, third.ctx);
      assert.equal(third.statuses.at(-1), "🐤 Feishu: on · 2 pending handoffs");
    } finally { Object.defineProperty(BotController.prototype, "status", status); }
    assert.equal(starts, 2, "new Pi launch restores listening");
    assert.equal(confirmations, 1, "automatic startup does not re-prompt");
    await third.commands.get("lark-bot").handler("off", third.ctx);
    assert.equal(third.statuses.at(-1), undefined, "owner off clears status");
    await waitFor(() => second.statuses.at(-1) === undefined);
    await assert.rejects(push(second, "after off"), /not listening/);
    await assert.rejects(readPrivateJson(join(stateDir, "push-endpoint.json")), /ENOENT/);
    assert.deepEqual(await readPrivateJson(join(stateDir, "enabled.json")), { appId: "cli_test", enabled: false });
    const fourth = next();
    await fourth.handlers.get("session_start")({ reason: "startup" }, fourth.ctx);
    assert.equal(starts, 2, "off disables future startup");
    assert.equal(fourth.statuses.length, 0, "off project has no status on new session");
    await fourth.commands.get("lark-bot").handler("on", fourth.ctx);
    await waitFor(() => second.statuses.at(-1) === "🐤 Feishu: push");
    await fourth.handlers.get("session_shutdown")({ reason: "new" }, fourth.ctx);
    const fifth = next();
    await fifth.handlers.get("session_start")({ reason: "new" }, fifth.ctx);
    assert.equal(starts, 4, "/new also resumes after shutdown");
    await fifth.handlers.get("session_shutdown")({ reason: "quit" }, fifth.ctx);
    await writePrivateJson(join(stateDir, "config.json"),
      { version: 1, brand: "feishu", appId: "cli_changed", appSecret: "secret" });
    const sixth = next();
    await sixth.handlers.get("session_start")({ reason: "startup" }, sixth.ctx);
    assert.equal(starts, 4, "another app cannot inherit prior on preference");
  } finally {
    for (const h of sessions) await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("simultaneous automatic starts publish just one listener and push endpoint", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-simultaneous-"));
  const env = { PATH: process.env.PATH, ZELLIJ: process.env.ZELLIJ, ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID };
  const a = harness(cwd), b = harness(cwd);
  let starts = 0;
  t.mock.method(LarkTransport.prototype, "start", async () => { starts++; });
  t.mock.method(LarkTransport.prototype, "stop", async () => {});
  try {
    await writeFile(join(cwd, "zellij"), '#!/bin/sh\necho "zellij 0.44.0"\n', { mode: 0o700 });
    process.env.PATH = `${cwd}:${env.PATH}`;
    process.env.ZELLIJ = "1"; process.env.ZELLIJ_PANE_ID = "0";
    const dir = await prepareState(cwd, ".pi");
    await writePrivateJson(join(dir, "config.json"), { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" });
    await writePrivateJson(join(dir, "enabled.json"), { appId: "cli_test", enabled: true });
    await Promise.all([a, b].map((h) => h.handlers.get("session_start")({ reason: "startup" }, h.ctx)));
    assert.equal(starts, 1);
    const endpoint = await readPrivateJson(join(dir, "push-endpoint.json")) as { ownerToken: string };
    const lock = await readPrivateJson(join(dir, "controller.lock")) as { token: string };
    assert.equal(endpoint.ownerToken, lock.token);
    assert.equal((await inspectLock(dir)).state, "running", "live owner answers the identity probe");
  } finally {
    await Promise.all([a, b].map((h) => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx)));
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
    await writePrivateJson(join(stateDir, "enabled.json"), { appId: "cli_test", enabled: true });
    const h = harness(cwd); await h.commands.get("lark-bot").handler("", h.ctx);
    assert(h.messages.at(-1)?.includes("another pi holds the project lock"));
    await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
    assert.equal(h.statuses.length, 0, "a live PID without a verified owner socket is not push_only");
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
        assert.equal(h.tools.size, 1, "link registers the tool but never starts the listener");
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

    assert.deepEqual([...h.tools.keys()], ["lark_push"]);
    assert.deepEqual(h.activeTools(), ["read", "bash", "lark_push"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
