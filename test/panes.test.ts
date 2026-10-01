import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { __panesTest__, HerdrWorkers } from "../src/panes.ts";
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
  assert.throws(() => new HerdrWorkers({ cwd: "", appId: "app" }));
  assert.throws(() => new HerdrWorkers({ cwd: "/tmp", appId: "" }));
  assert((await readFile(__panesTest__.piCliPath(), "utf8")).length > 0);
});

async function fixture(settings: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lark-pane-test-"));
  const previous = Object.fromEntries(["HERDR_BIN_PATH", "HERDR_ENV", "HERDR_PANE_ID", ...Object.keys(settings)]
    .map(key => [key, process.env[key]]));
  const herdrPath = join(root, "herdr");
  await copyFile(fileURLToPath(new URL("./fixtures/fake-herdr.cjs", import.meta.url)), herdrPath);
  await chmod(herdrPath, 0o700);
  Object.assign(process.env, { HERDR_BIN_PATH: herdrPath, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p0", ...settings });
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
  const factory = new HerdrWorkers({ ...f.options, env: { TEST_READY_DELAY: "50" } });
  let resumed: HerdrWorkers | undefined;
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
    resumed = new HerdrWorkers(f.options);
    const again = await resumed.open("ou_a"); await again.run("follow-up", () => {});
    assert.equal(resumed.list()[0]!.sessionFile, sessionFile);
    assert.equal((await readFile(sessionFile, "utf8")).trim().split("\n").length, 2);
  } finally { await factory.close(); await resumed?.close(); await f.cleanup(); }
});

test("handoff does not wait for output; the next message and interrupt reach the same pane", { timeout: 10000 }, async () => {
  const f = await fixture(); const factory = new HerdrWorkers(f.options);
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

test("workers split the controller's own pane unfocused, else open a background tab", { timeout: 10000 }, async () => {
  for (const [layout, zoomed, expected] of [
    [[["w1:p0", 120, 40]], false, { action: "split", target: "w1:p0", direction: "right" }],
    [[["w1:p0", 120, 40], ["w1:p7", 100, 60]], false, { action: "split", target: "w1:p0", direction: "right" }],  // never another pane
    [[["w1:p0", 90, 18]], false, { action: "tab" }],
    [[["w1:p0", 90, 18], ["w1:p7", 200, 50]], false, { action: "tab" }],  // too small: a tab, not the bigger neighbour
    [[["w1:p0", 160, 50]], true, { action: "tab" }],
  ] as const) {
    const f = await fixture({ TEST_LAYOUT: JSON.stringify(layout), TEST_ZOOMED: zoomed ? "1" : "0" });
    const workers = new HerdrWorkers(f.options);
    try {
      const worker = await workers.open("ou_a");
      const [create] = (await readFile(join(f.root, "creates.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(create.action, expected.action);
      assert.equal(create.focus, "--no-focus");
      assert.equal(create.cwd, "/");
      if ("target" in expected) { assert.equal(create.target, expected.target); assert.equal(create.direction, expected.direction); }
      const paneId = workers.list()[0]!.paneId!;
      assert.match(paneId, /^w1:p\d+$/);
      const read = async () => JSON.parse(await readFile(join(f.root, `pane-${paneId.replace("w1:p", "")}.json`), "utf8"));
      for (let i = 0; i < 50 && !(await read()).agent; i++) await new Promise((done) => setTimeout(done, 20));
      const pane = await read();
      assert.match(pane.label, /^lark-[a-f0-9]{10}$/);
      assert.equal(pane.agent, pane.label, "the ready worker is named in herdr's agents sidebar");
      await worker.run("worker", () => {});
      await workers.close();
      assert.deepEqual((await readdir(f.root)).filter(file => /^pane-\d+\.json$/.test(file)), [], "close the owned pane");
    } finally { await workers.close(); await f.cleanup(); }
  }
});

test("an uninspectable layout creates nothing, and a failed launch closes its pane", { timeout: 10000 }, async () => {
  let f = await fixture({ TEST_LAYOUT_FAIL: "1" });
  let workers = new HerdrWorkers(f.options);
  try {
    await assert.rejects(workers.open("ou_a"), /Cannot inspect herdr layout/);
    assert(!(await readdir(f.root)).includes("creates.jsonl"));
  } finally { await workers.close(); await f.cleanup(); }
  f = await fixture({ TEST_RUN_FAIL: "1" });
  workers = new HerdrWorkers(f.options);
  try {
    await assert.rejects(workers.open("ou_a"), /herdr pane run failed \(pane_not_found\)/);
    assert.deepEqual((await readdir(f.root)).filter(file => /^pane-\d+\.json$/.test(file)), []);
  } finally { await workers.close(); await f.cleanup(); }
});

test("missing project directory fails before invoking herdr or recreating it", async () => {
  const f = await fixture();
  const factory = new HerdrWorkers({ ...f.options, cwd: join(f.root, "missing-project") });
  try {
    await assert.rejects(factory.open("ou_a"), /project directory is unavailable/);
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("pane-")), []);
    assert(!(await readdir(f.root)).includes("missing-project"));
  } finally { await factory.close(); await f.cleanup(); }
});

test("crashed worker rejects current prompt and is replaced on the next open", { timeout: 10000 }, async () => {
  const f = await fixture(); const factory = new HerdrWorkers(f.options);
  try {
    const first = await factory.open("ou_a");
    await assert.rejects(first.run("CRASH", () => {}), /exited|closed|connection/);
    const next = await factory.open("ou_a"); assert.notEqual(first, next);
    await next.run("recovered", () => {});
  } finally { await factory.close(); await f.cleanup(); }
});

test("closing while startup is pending rejects promptly and cleans resources", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new HerdrWorkers({ ...f.options, env: { TEST_READY_DELAY: "2000" } });
  try {
    const opening = factory.open("ou_a"); const rejected = assert.rejects(opening, /closed|cancelled/);
    await Promise.all([factory.close(), factory.close(), rejected]);
    assert.deepEqual(factory.list(), []);
    await assert.rejects(factory.open("ou_a"), /closed/);
  } finally { await factory.close(); await f.cleanup(); }
});

test("startup deadline cancels the pending handshake and permits a clean retry", { timeout: 10000 }, async () => {
  const f = await fixture();
  const factory = new HerdrWorkers({ ...f.options, startupTimeoutMs: 250, env: { TEST_READY_DELAY: "2000" } });
  try {
    await assert.rejects(factory.open("ou_a"), /Timed out|closed/);
    assert.deepEqual(factory.list(), []);
  } finally { await factory.close(); await f.cleanup(); }
});

test("closing finds a moved worker pane through its agent name", { timeout: 10000 }, async () => {
  const f = await fixture(); const workers = new HerdrWorkers(f.options);
  try {
    await workers.open("ou_a");
    const { paneId } = workers.list()[0]!;
    const read = async (id: string) => JSON.parse(await readFile(join(f.root, `pane-${id.replace("w1:p", "")}.json`), "utf8"));
    for (let i = 0; i < 50 && !(await read(paneId!)).agent; i++) await new Promise((done) => setTimeout(done, 20));
    const { agent } = await read(paneId!);
    // The user moves the pane to another workspace: herdr gives it a new id; the agent name follows.
    await rename(join(f.root, `pane-${paneId!.replace("w1:p", "")}.json`), join(f.root, "pane-50.json"));
    await writeFile(join(f.root, "moved.json"), JSON.stringify({ [agent]: "w1:p50" }));
    await workers.close();
    assert.deepEqual((await readdir(f.root)).filter((file) => /^pane-\d+\.json$/.test(file)), [], "the moved pane is closed");
  } finally { await workers.close(); await f.cleanup(); }
});
