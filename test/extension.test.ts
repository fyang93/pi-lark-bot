import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.ts";
import { acquireLock, prepareState } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function harness(cwd: string) {
  const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const messages: string[] = [];
  extension({ registerCommand(name: string, value: unknown) { commands.set(name, value); },
    on(name: string, handler: unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const ctx = { cwd, mode: "tui", isProjectTrusted: () => true,
    ui: { notify: (text: string) => messages.push(text), setStatus() {} } } as unknown as ExtensionCommandContext;
  return { commands, handlers, messages, ctx };
}

test("loading extension is inert; /lark-bot defaults to status and never writes credentials", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lark-extension-"));
  try {
    const h = harness(cwd);
    assert.deepEqual([...h.commands.keys()], ["lark-bot"]);
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
  assert(h.messages.at(-1)?.includes("/lark-bot connect"));
});
