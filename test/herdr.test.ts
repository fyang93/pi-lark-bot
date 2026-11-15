import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSurface, createSurface, splitDirection } from "../src/herdr.ts";

test("splits leave at least 80 columns and 24 rows, side by side first", () => {
  for (const [width, height, expected] of [
    [160, 24, "right"], [159, 24, null], [160, 23, null],
    [80, 48, "down"], [80, 47, null], [79, 48, null],
    [120, 40, null], [160, 100, "right"], [159, 100, "down"],
  ] as const) assert.equal(splitDirection(width, height), expected, `${width}×${height}`);
});

const current = { pane_id: "w1:p0", workspace_id: "w1", tab_id: "w1:t0" };
const pane = (id: string, tab = "w1:t0", focused = false) => ({ pane_id: id, tab_id: tab, focused });
const layout = (panes: [string, number, number, boolean?][], zoomed = false) => ({
  zoomed, panes: panes.map(([pane_id, width, height, focused]) => ({ pane_id, focused, rect: { width, height } })),
});

async function fixture(settings: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lark-herdr-test-"));
  const env = { HERDR_BIN_PATH: join(root, "herdr"), HERDR_ENV: "1", HERDR_PANE_ID: "stale:p99", TEST_RUN_NOOP: "1", ...settings };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  await copyFile(new URL("./fixtures/fake-herdr.cjs", import.meta.url), env.HERDR_BIN_PATH);
  await chmod(env.HERDR_BIN_PATH, 0o700);
  Object.assign(process.env, env);
  const geometry = (value: unknown) => writeFile(join(root, "geometry.json"), JSON.stringify(value));
  const entries = async (file: string): Promise<any[]> => {
    try { return (await readFile(join(root, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  };
  const openings = async () => (await entries("creates.jsonl")).filter(entry => entry.action !== "run");
  const cleanup = async () => {
    for (const file of await readdir(root)) {
      if (/^pane-\d+\.json$/.test(file)) closeSurface(`w1:p${file.slice(5, -5)}`);
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  return { geometry, openings, entries, cleanup };
}

test("uses the controller's current identity and workspace, never the active workspace default", async () => {
  const f = await fixture();
  try {
    await f.geometry({
      current: { pane_id: "w7:p3", workspace_id: "w7", tab_id: "w7:t2" },
      panes: [pane("w7:p3", "w7:t2")],
      layouts: { "w7:p3": layout([["w7:p3", 100, 25]]) },
    });
    await createSurface("lark-test", []);
    assert.deepEqual(await f.openings(), [{ action: "tab", workspace: "w7", focus: "--no-focus", label: "lark-test", cwd: "/" }]);
    const calls = await f.entries("calls.jsonl");
    assert(calls.some(call => JSON.stringify(call) === JSON.stringify(["pane", "current", "--current"])));
    assert(calls.some(call => JSON.stringify(call) === JSON.stringify(["pane", "layout", "--pane", "w7:p3"])));
    assert(!calls.some(call => call.includes("stale:p99")));
  } finally { await f.cleanup(); }
});

test("prefers the largest unfocused owned pane, then the controller, never a user's neighbour", async () => {
  const f = await fixture();
  try {
    await createSurface("first", []); // w1:p1
    await createSurface("second", []); // w1:p2
    for (const [sizes, focused, target] of [
      [[["w1:p0", 320, 100], ["w1:p1", 160, 48], ["w1:p2", 200, 50], ["w1:p77", 400, 100]], undefined, "w1:p2"],
      [[["w1:p0", 80, 24], ["w1:p1", 160, 48, true]], undefined, "w1:p1"], // per-tab focus does not mean user focus
      [[["w1:p0", 80, 24], ["w1:p1", 160, 48]], "w1:p1", undefined],
      [[["w1:p0", 160, 48], ["w1:p1", 80, 24]], undefined, "w1:p0"],
      [[["w1:p0", 80, 24], ["w1:p77", 400, 100]], undefined, undefined],
    ] as const) {
      await f.geometry({ current, panes: [pane("w1:p0"), pane("w1:p1", "w1:t0", focused === "w1:p1"), pane("w1:p2"), pane("w1:p77")], layouts: { "w1:p0": layout(sizes as unknown as [string, number, number, boolean?][]) } });
      await createSurface("next", []);
      const last = (await f.openings()).at(-1);
      assert.equal(last.action, target ? "split" : "tab");
      if (target) assert.equal(last.target, target);
    }
  } finally { await f.cleanup(); }
});

test("fills only wholly owned background tabs and skips zoomed or user-focused panes", async () => {
  const f = await fixture();
  try {
    await f.geometry({ current, panes: [pane("w1:p0")], layouts: { "w1:p0": layout([["w1:p0", 80, 24]]) } });
    await createSurface("background", []); // w1:p1 in a new tab
    for (const [mixed, zoomed, focused, split] of [
      [false, false, false, true],
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
    ]) {
      await f.geometry({
        current,
        panes: [pane("w1:p0"), pane("w1:p1", "w1:t1", focused), ...(mixed ? [pane("w1:p77", "w1:t1")] : [])],
        layouts: {
          "w1:p0": layout([["w1:p0", 160, 48]], true),
          "w1:p1": layout([["w1:p1", 200, 60, true], ...(mixed ? [["w1:p77", 200, 60] as [string, number, number]] : [])], zoomed),
        },
      });
      await createSurface("next", []);
      const last = (await f.openings()).at(-1);
      assert.equal(last.action, split ? "split" : "tab");
      if (split) assert.equal(last.target, "w1:p1");
    }
  } finally { await f.cleanup(); }
});

test("serializes inspection and creation so parallel launches see fresh geometry", async () => {
  const f = await fixture({ TEST_SPLIT_DELAY: "150" });
  try {
    await f.geometry({
      current, panes: [pane("w1:p0")], layouts: { "w1:p0": layout([["w1:p0", 160, 24]]) },
      afterCreate: { current, panes: [pane("w1:p0"), pane("w1:p1")], layouts: { "w1:p0": layout([["w1:p0", 80, 24], ["w1:p1", 80, 24]]) } },
    });
    await Promise.all([createSurface("one", []), createSurface("two", [])]);
    assert.deepEqual((await f.openings()).map(entry => entry.action), ["split", "tab"]);
    const calls = await f.entries("calls.jsonl");
    const inspections = calls.map((call, index) => call[1] === "layout" ? index : -1).filter(index => index >= 0);
    const split = calls.findIndex(call => call[1] === "split");
    assert(inspections[0] < split && split < inspections[1]);
  } finally { await f.cleanup(); }
});

test("an aborted queued launch creates nothing and does not poison the queue", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createSurface("cancelled", [], controller.signal), /abort/i);
    assert.deepEqual(await f.openings(), []);
    await createSurface("next", []);
    assert.equal((await f.openings()).length, 1);
  } finally { await f.cleanup(); }
});

test("abort during creation waits for the pane id, closes it, and never runs the command", async () => {
  const f = await fixture({ TEST_SPLIT_DELAY: "150" });
  try {
    const controller = new AbortController();
    const opening = createSurface("cancelled", [], controller.signal);
    // Attach the rejection handler before triggering cancellation.
    const rejected = assert.rejects(opening, /abort/i);
    const deadline = Date.now() + 3000;
    while (!(await f.openings()).length) {
      assert(Date.now() < deadline, "split should start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await rejected;
    const calls = await f.entries("calls.jsonl");
    assert(calls.some(call => call[1] === "close" && call[2] === "w1:p1"));
    assert(!calls.some(call => call[1] === "run"));
  } finally { await f.cleanup(); }
});

test("closed panes are no longer considered owned", async () => {
  const f = await fixture();
  try {
    const id = await createSurface("first", []);
    closeSurface(id);
    await f.geometry({ current, panes: [pane("w1:p0"), pane(id)], layouts: { "w1:p0": layout([["w1:p0", 80, 24], [id, 200, 60]]) } });
    await createSurface("next", []);
    assert.equal((await f.openings()).at(-1).action, "tab");
  } finally { await f.cleanup(); }
});
