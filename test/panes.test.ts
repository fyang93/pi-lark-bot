import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { __panesTest__, TmuxWorkers } from "../src/panes.ts";
import type { WorkerEvent } from "../src/types.ts";

test("user session keys are deterministic and do not expose identifiers", () => {
  const one = __panesTest__.sessionKey("app-id", "user-id");
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.equal(one, __panesTest__.sessionKey("app-id", "user-id"));
  assert.notEqual(one, __panesTest__.sessionKey("app-id", "another-user"));
  assert.notEqual(one, __panesTest__.sessionKey("another-app", "user-id"));
  assert.equal(one.includes("user-id"), false);
});

test("factory validates required controller identity and resolves the real pi CLI", async () => {
  assert.throws(() => new TmuxWorkers({ cwd: "", appId: "app" }));
  assert.throws(() => new TmuxWorkers({ cwd: "/tmp", appId: "" }));
  assert((await readFile(__panesTest__.piCliPath(), "utf8")).length > 0);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lark-pane-test-"));
  const previous = { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  const tmuxPath = join(root, "tmux");
  await copyFile(fileURLToPath(new URL("./fixtures/fake-tmux.cjs", import.meta.url)), tmuxPath);
  await chmod(tmuxPath, 0o700);
  Object.assign(process.env, { PATH: `${root}:${previous.PATH}`, TMUX: "fixture", TMUX_PANE: "%99999999" });
  const options = { cwd: root, appId: "cli_test", startupTimeoutMs: 3000 };
  const cleanup = async () => {
    // Let the copied surface's 120ms cosmetic timer finish against this mock.
    await new Promise((resolve) => setTimeout(resolve, 160));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const file of await readdir(root)) {
      if (/^pane-\d+\.json$/.test(file)) {
        try { process.kill(JSON.parse(await readFile(join(root, file), "utf8")).pid, "SIGTERM"); } catch {}
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, options, cleanup };
}

test("real socket/subprocess bridge reuses users, preserves Unicode, filters wrong IDs and restores sessions", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new TmuxWorkers({ ...f.options, env: { TEST_READY_DELAY: "50" } });
  let resumed: TmuxWorkers | undefined;
  try {
    const [a, a2, b] = await Promise.all([factory.open("ou_a"), factory.open("ou_a"), factory.open("ou_b")]);
    assert.equal(a, a2); assert.notEqual(a, b);
    assert.equal(factory.list().length, 2);
    assert.notEqual(factory.list()[0]!.paneId, factory.list()[1]!.paneId);
    const events: WorkerEvent[] = [];
    const prompt = "你好🙂\n!this-is-not-shell\n'\"\\";
    await a.run(prompt, (event) => events.push(event));
    assert(events.some((event) => event.type === "text" && event.text === "你好🙂"));
    assert.equal(events.at(-1)?.text, prompt);
    assert(!events.some((event) => event.text === "must-ignore"));
    const sessionFile = factory.list().find((pane) => pane.userId === "ou_a")!.sessionFile;
    assert.equal(JSON.parse((await readFile(sessionFile, "utf8")).trim()).text, prompt);
    await factory.close();
    assert.equal(factory.list().length, 0);
    resumed = new TmuxWorkers(f.options);
    const again = await resumed.open("ou_a"); await again.run("follow-up", () => {});
    assert.equal(resumed.list()[0]!.sessionFile, sessionFile);
    assert.equal((await readFile(sessionFile, "utf8")).trim().split("\n").length, 2);
  } finally { await factory.close(); await resumed?.close(); await f.cleanup(); }
});

test("missing project directory fails before invoking tmux or recreating it", async () => {
  const f = await fixture();
  const factory = new TmuxWorkers({ ...f.options, cwd: join(f.root, "missing-project") });
  try {
    await assert.rejects(factory.open("ou_a"), /project directory is unavailable/);
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("pane-")), []);
    assert(!(await readdir(f.root)).includes("missing-project"));
  } finally { await factory.close(); await f.cleanup(); }
});

test("crashed worker rejects current prompt and is replaced on the next open", { timeout: 10000 }, async () => {
  const f = await fixture(); const factory = new TmuxWorkers(f.options);
  try {
    const first = await factory.open("ou_a");
    await assert.rejects(first.run("CRASH", () => {}), /exited|closed|connection/);
    const next = await factory.open("ou_a"); assert.notEqual(first, next);
    await next.run("recovered", () => {});
  } finally { await factory.close(); await f.cleanup(); }
});

test("closing while startup is pending rejects promptly and cleans resources", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new TmuxWorkers({ ...f.options, env: { TEST_READY_DELAY: "2000" } });
  try {
    const opening = factory.open("ou_a"); const rejected = assert.rejects(opening, /closed|cancelled/);
    await Promise.all([factory.close(), factory.close(), rejected]);
    assert.deepEqual(factory.list(), []);
    await assert.rejects(factory.open("ou_a"), /closed/);
  } finally { await factory.close(); await f.cleanup(); }
});

test("startup deadline cancels the pending handshake and permits a clean retry", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new TmuxWorkers({ ...f.options, startupTimeoutMs: 250, env: { TEST_READY_DELAY: "2000" } });
  try {
    await assert.rejects(factory.open("ou_a"), /Timed out|closed/);
    assert.deepEqual(factory.list(), []);
  } finally { await factory.close(); await f.cleanup(); }
});
