import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createSurface } from "../src/herdr.ts";

async function fixture(settings: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lark-herdr-test-"));
  const env = { HERDR_BIN_PATH: join(root, "herdr"), HERDR_ENV: "1", HERDR_PANE_ID: "stale:p99", TEST_RUN_NOOP: "1", ...settings };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  await copyFile(new URL("./fixtures/fake-herdr.cjs", import.meta.url), env.HERDR_BIN_PATH);
  await chmod(env.HERDR_BIN_PATH, 0o700);
  Object.assign(process.env, env);
  const entries = async <T>(file: string): Promise<T[]> => {
    try { return (await readFile(join(root, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  };
  const calls = () => entries<string[]>("calls.jsonl");
  const openings = async () => (await entries<{ action: string; label: string }>("creates.jsonl")).filter(entry => entry.action === "tab");
  const waitFor = async (ready: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 3000;
    while (!(await ready())) {
      assert(Date.now() < deadline, `${label} should start`);
      await delay(10);
    }
  };
  const waitForCall = (group: string, action: string) =>
    waitFor(async () => (await calls()).some(call => call[0] === group && call[1] === action), `${group} ${action}`);
  const cleanup = async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  const current = (workspace: string) => writeFile(join(root, "current.json"), JSON.stringify({ workspace_id: workspace, pane_id: `${workspace}:p3` }));
  const release = (gate: "tab" | "run") => writeFile(join(root, `release-${gate}`), "");
  const panes = async () => (await readdir(root)).filter(file => /^pane-\d+\.json$/.test(file));
  return { current, calls, openings, waitFor, waitForCall, release, panes, cleanup };
}

test("opens a dedicated unfocused tab for each launch in the controller's live workspace", async () => {
  const f = await fixture();
  try {
    await f.current("w7");
    assert.equal(await createSurface("lark-first", ["node"]), "w7:p1");
    await f.current("w8");
    assert.equal(await createSurface("lark-second", ["node"]), "w8:p2");
    assert.deepEqual(await f.openings(), [
      { action: "tab", workspace: "w7", focus: "--no-focus", label: "lark-first", cwd: "/" },
      { action: "tab", workspace: "w8", focus: "--no-focus", label: "lark-second", cwd: "/" },
    ]);
    const calls = await f.calls();
    assert.deepEqual(calls.filter(call => call[1] === "current"), Array.from({ length: 2 }, () => ["pane", "current", "--current"]));
    assert.deepEqual(calls.filter(call => call[1] === "run").map(call => call[2]), ["w7:p1", "w8:p2"]);
    assert(!calls.some(call => call.includes("stale:p99") || (call[0] === "pane" && ["list", "layout", "split"].includes(call[1]!))));
  } finally { await f.cleanup(); }
});

test("waits for a new shell to be idle with output twice before running the worker", async () => {
  const f = await fixture({ TEST_SHELL_BUSY_CHECKS: "2", TEST_EMPTY_SCREEN_CHECKS: "1" });
  try {
    assert.equal(await createSurface("lark-slow-shell", ["node"]), "w1:p1");
    const calls = await f.calls();
    assert.deepEqual(calls.filter(call => call[0] === "pane").map(call => call[1]), [
      "current", "rename", "process-info", "process-info", "process-info", "read", // busy, then idle but empty
      "process-info", "read", "process-info", "read", "run",
    ]);
  } finally { await f.cleanup(); }
});

test("starts without the optional shell probe when herdr does not support it", async () => {
  const f = await fixture({ TEST_PROBE_FAIL: "1" });
  try {
    assert.equal(await createSurface("lark-test", ["node"]), "w1:p1");
    assert.equal((await f.calls()).at(-1)?.[1], "run");
  } finally { await f.cleanup(); }
});

test("a slow worker launch does not hold up the next tab", async () => {
  const f = await fixture({ TEST_RUN_GATE: "slow" });
  const slow = createSurface("slow", ["node"]);
  try {
    await f.waitForCall("pane", "run");
    assert.equal(await createSurface("next", ["node"]), "w1:p2");
    assert.deepEqual((await f.openings()).map(entry => entry.label), ["slow", "next"]);
  } finally {
    await f.release("run");
    try { assert.equal(await slow, "w1:p1"); } finally { await f.cleanup(); }
  }
});

test("an aborted queued launch creates nothing and does not poison the queue", async () => {
  const f = await fixture({ TEST_TAB_GATE: "first" });
  const first = createSurface("first", ["node"]);
  try {
    await f.waitForCall("tab", "create");
    const controller = new AbortController();
    const cancelled = createSurface("cancelled", ["node"], controller.signal);
    const rejected = assert.rejects(cancelled, /abort/i);
    controller.abort();
    await f.release("tab");
    await rejected;
    assert.equal(await first, "w1:p1");
    assert.equal(await createSurface("next", ["node"]), "w1:p2");
    assert.deepEqual((await f.openings()).map(entry => entry.label), ["first", "next"]);
    assert.equal((await f.calls()).filter(call => call[1] === "current").length, 2);
  } finally {
    await f.release("tab");
    await first.catch(() => {});
    await f.cleanup();
  }
});

test("abort during tab creation waits for the root pane id, closes it, and never runs the command", async () => {
  const f = await fixture({ TEST_TAB_GATE: "cancelled" });
  const controller = new AbortController();
  const rejected = assert.rejects(createSurface("cancelled", ["node"], controller.signal), /abort/i);
  try {
    await f.waitFor(async () => (await f.openings()).length > 0, "tab create");
    assert.deepEqual(await f.panes(), ["pane-1.json"], "herdr already allocated a root pane");
    controller.abort();
    await f.release("tab");
    await rejected;
    const calls = await f.calls();
    assert.deepEqual(calls.at(-1), ["pane", "close", "w1:p1"]);
    assert(!calls.some(call => call[1] === "run"));
    assert.deepEqual(await f.panes(), []);
  } finally {
    controller.abort();
    await f.release("tab");
    await rejected.catch(() => {});
    await f.cleanup();
  }
});

test("aborting while the shell starts closes the root pane without running a command", async () => {
  const f = await fixture({ TEST_SHELL_BUSY_CHECKS: "100" });
  const controller = new AbortController();
  const rejected = assert.rejects(createSurface("lark-cancelled", ["node"], controller.signal), /abort/i);
  try {
    await f.waitForCall("pane", "process-info");
    controller.abort();
    await rejected;
    const calls = await f.calls();
    assert.deepEqual(calls.at(-1), ["pane", "close", "w1:p1"]);
    assert(!calls.some(call => call[1] === "run"));
    assert.deepEqual(await f.panes(), []);
  } finally {
    controller.abort();
    await rejected.catch(() => {});
    await f.cleanup();
  }
});
