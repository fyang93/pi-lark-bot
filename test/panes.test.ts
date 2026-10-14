import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { __panesTest__, ZellijWorkers } from "../src/panes.ts";
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
  assert.throws(() => new ZellijWorkers({ cwd: "", appId: "app" }));
  assert.throws(() => new ZellijWorkers({ cwd: "/tmp", appId: "" }));
  assert((await readFile(__panesTest__.piCliPath(), "utf8")).length > 0);
});

async function fixture(settings: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lark-pane-test-"));
  const previous = Object.fromEntries(["PATH", "ZELLIJ", "ZELLIJ_PANE_ID", ...Object.keys(settings)]
    .map(key => [key, process.env[key]]));
  const zellijPath = join(root, "zellij");
  await copyFile(fileURLToPath(new URL("./fixtures/fake-zellij.cjs", import.meta.url)), zellijPath);
  await chmod(zellijPath, 0o700);
  Object.assign(process.env, { PATH: `${root}:${previous.PATH}`, ZELLIJ: "0", ZELLIJ_PANE_ID: "0", ...settings });
  const options = { cwd: root, appId: "cli_test", startupTimeoutMs: 3000 };
  const cleanup = async () => {
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
  const factory = new ZellijWorkers({ ...f.options, env: { TEST_READY_DELAY: "50" } });
  let resumed: ZellijWorkers | undefined;
  try {
    const [a, a2, b] = await Promise.all([factory.open("ou_a"), factory.open("ou_a"), factory.open("ou_b")]);
    assert.equal(a, a2); assert.notEqual(a, b);
    assert.equal(factory.list().length, 2);
    assert.notEqual(factory.list()[0]!.paneId, factory.list()[1]!.paneId);
    const events: WorkerEvent[] = [];
    const prompt = "你好🙂\n!this-is-not-shell\n'\"\\";
    let done!: () => void;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    await a.run(prompt, (event) => { events.push(event); if (event.type === "done") done(); });
    await completed;
    assert(events.some((event) => event.type === "text" && event.text === "你好🙂"));
    assert.equal(events.at(-1)?.text, prompt);
    assert(!events.some((event) => event.text === "must-ignore"));
    const sessionFile = factory.list().find((pane) => pane.userId === "ou_a")!.sessionFile;
    assert.equal(JSON.parse((await readFile(sessionFile, "utf8")).trim()).text, prompt);
    await factory.close();
    assert.equal(factory.list().length, 0);
    resumed = new ZellijWorkers(f.options);
    const again = await resumed.open("ou_a"); await again.run("follow-up", () => {});
    assert.equal(resumed.list()[0]!.sessionFile, sessionFile);
    assert.equal((await readFile(sessionFile, "utf8")).trim().split("\n").length, 2);
  } finally { await factory.close(); await resumed?.close(); await f.cleanup(); }
});

test("handoff does not wait for output; the next message and interrupt reach the same pane", { timeout: 10000 }, async () => {
  const f = await fixture(); const factory = new ZellijWorkers(f.options);
  try {
    const worker = await factory.open("ou_a");
    await worker.run("NO_OUTPUT", () => { throw new Error("unexpected output"); });
    await worker.run("NO_OUTPUT", () => {});
    await worker.interrupt!();
    assert.equal(await factory.open("ou_a"), worker);
    const history = await readFile(factory.list()[0]!.sessionFile, "utf8");
    assert.equal(history.trim().split("\n").length, 2);
  } finally { await factory.close(); await f.cleanup(); }
});

test("tiled placement takes priority, while valid but full layouts use a new tab", { timeout: 10000 }, async () => {
  const parent = { id: 0, is_plugin: false, tab_id: 1, pane_rows: 40, pane_columns: 120 };
  const sibling = { id: 7, is_plugin: false, tab_id: 1, pane_rows: 40, pane_columns: 100 };
  for (const [panes, expected] of [
    [[parent], { target: "0", direction: "right" }],
    [[parent, sibling], { target: "7", direction: "down" }],
    [[{ ...parent, pane_columns: 90, pane_rows: 18 }], { action: "new-tab" }],
    [[parent, { ...sibling, pane_columns: 130 }], { action: "new-tab" }],
    [[parent, { ...sibling, pane_columns: undefined }], null],
    [[{ ...parent, is_fullscreen: true }], { action: "new-tab" }],
    [[{ ...parent, tab_id: undefined }], null],
  ] as const) {
    const f = await fixture({ TEST_PANES: JSON.stringify(panes), TEST_ZELLIJ_VERSION: "zellij 0.45.1" });
    const workers = new ZellijWorkers(f.options);
    try {
      if (expected) {
        await workers.open("ou_a");
        const [create] = (await readFile(join(f.root, "creates.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(create.action, "action" in expected ? expected.action : "new-pane");
        if ("target" in expected) { assert.equal(create.target, expected.target); assert.equal(create.direction, expected.direction); }
        else assert.equal(create.focus, "--no-focus");
      } else {
        await assert.rejects(workers.open("ou_a"), /Cannot verify parent pane and tab geometry/);
        assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith("pane-")), []);
      }
    } finally { await workers.close(); await f.cleanup(); }
  }
  for (const mode of ["lost-reply", "missing"] as const) {
    const f = await fixture({ TEST_CREATE: mode, TEST_ZELLIJ_VERSION: "zellij 0.45.0" });
    const workers = new ZellijWorkers(f.options);
    try {
      if (mode === "lost-reply") {
        await workers.open("ou_a");
        assert.equal(workers.list().length, 1);
      } else await assert.rejects(workers.open("ou_a"), /not retried/);
      const creates = (await readFile(join(f.root, "creates.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(creates.length, 1); assert.equal(creates[0].focus, "--no-focus");
    } finally { await workers.close(); await f.cleanup(); }
  }
});

test("tab creation confirms one pane by tab ID or unique marker without retrying", { timeout: 10000 }, async () => {
  for (const mode of ["normal", "lost-reply", "delayed", "missing", "ambiguous"] as const) {
    const f = await fixture({ TEST_ZELLIJ_VERSION: "zellij 0.45.1", TEST_PANES: JSON.stringify([
      { id: 0, is_plugin: false, tab_id: 1, pane_rows: 18, pane_columns: 90 }]),
      TEST_TAB_CREATE: mode === "ambiguous" ? "lost-reply" : mode,
      TEST_TAB_AMBIGUOUS: mode === "ambiguous" ? "1" : "0",
      TEST_TAB_LIST_DELAY: mode === "delayed" ? "1" : "0" });
    const workers = new ZellijWorkers(f.options);
    try {
      if (mode === "normal" || mode === "lost-reply" || mode === "delayed") {
        await workers.open("ou_a");
        assert.match(workers.list()[0]!.paneId!, /^terminal_\d+$/);
        const record = JSON.parse(await readFile(join(f.root, `${workers.list()[0]!.paneId!.replace("terminal_", "pane-")}.json`), "utf8"));
        assert.match(record.tabName, /^lark-/);
        assert.equal(record.title, record.tabName);
        await (await workers.open("ou_a")).run("tab-worker", () => {});
        assert.match(await readFile(workers.list()[0]!.sessionFile, "utf8"), /tab-worker/);
        await workers.close();
        assert.deepEqual((await readdir(f.root)).filter(file => file.startsWith("pane-")), [], "close only the owned terminal pane");
      } else await assert.rejects(workers.open("ou_a"), /not retried/);
      const creates = (await readFile(join(f.root, "creates.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(creates.map(create => create.action), ["new-tab"]);
      assert.equal(creates[0].focus, "--no-focus");
      assert.equal(creates[0].parent, "0");
      assert.equal(process.env.ZELLIJ_PANE_ID, "0");
    } finally { await workers.close(); await f.cleanup(); }
  }
  for (const settings of [
    { TEST_LIST_FAIL: "1" },
    { TEST_PANES: JSON.stringify([{ id: 0, is_plugin: false, tab_id: 1, pane_rows: 18, pane_columns: 90 }]) },
  ] as Record<string, string>[]) {
    const f = await fixture(settings); const workers = new ZellijWorkers(f.options);
    try {
      await assert.rejects(workers.open("ou_a"), /Cannot inspect Zellij layout|Zellij 0\.45\+ is required/);
      assert(!(await readdir(f.root)).includes("creates.jsonl"));
    } finally { await workers.close(); await f.cleanup(); }
  }
});

test("missing project directory fails before invoking Zellij or recreating it", async () => {
  const f = await fixture();
  const factory = new ZellijWorkers({ ...f.options, cwd: join(f.root, "missing-project") });
  try {
    await assert.rejects(factory.open("ou_a"), /project directory is unavailable/);
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("pane-")), []);
    assert(!(await readdir(f.root)).includes("missing-project"));
  } finally { await factory.close(); await f.cleanup(); }
});

test("crashed worker rejects current prompt and is replaced on the next open", { timeout: 10000 }, async () => {
  const f = await fixture(); const factory = new ZellijWorkers(f.options);
  try {
    const first = await factory.open("ou_a");
    await assert.rejects(first.run("CRASH", () => {}), /exited|closed|connection/);
    const next = await factory.open("ou_a"); assert.notEqual(first, next);
    await next.run("recovered", () => {});
  } finally { await factory.close(); await f.cleanup(); }
});

test("closing while startup is pending rejects promptly and cleans resources", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new ZellijWorkers({ ...f.options, env: { TEST_READY_DELAY: "2000" } });
  try {
    const opening = factory.open("ou_a"); const rejected = assert.rejects(opening, /closed|cancelled/);
    await Promise.all([factory.close(), factory.close(), rejected]);
    assert.deepEqual(factory.list(), []);
    await assert.rejects(factory.open("ou_a"), /closed/);
  } finally { await factory.close(); await f.cleanup(); }
});

test("startup deadline cancels the pending handshake and permits a clean retry", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new ZellijWorkers({ ...f.options, startupTimeoutMs: 250, env: { TEST_READY_DELAY: "2000" } });
  try {
    await assert.rejects(factory.open("ou_a"), /Timed out|closed/);
    assert.deepEqual(factory.list(), []);
  } finally { await factory.close(); await f.cleanup(); }
});
