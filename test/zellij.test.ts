import test, { mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { requireZellij, createSurface, closeSurface } from "../src/zellij.ts";

test("Zellij validates availability, version and pane IDs, and launches literal argv without layout changes", () => {
  const originalEnv = { ...process.env };
  const calls: string[][] = [];
  let version = "zellij 0.43.1", pane = "terminal_12\n", missing = false;
  mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
    assert.equal(command, "zellij");
    calls.push(args);
    if (missing) throw new Error("ENOENT");
    return args[0] === "--version" ? version : pane;
  });
  syncBuiltinESMExports();
  try {
    delete process.env.ZELLIJ;
    assert.throws(requireZellij, /Start pi inside Zellij/);
    assert.equal(calls.length, 0);
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_PANE_ID = "0";
    assert.throws(requireZellij, /0\.44\+/);
    version = "unknown";
    assert.throws(requireZellij, /0\.44\+/);
    missing = true;
    assert.throws(requireZellij, /PATH/);
    missing = false;
    version = "zellij 0.44.3";
    const command = ["/node path", "/launcher 'quoted'.cjs", "/private/launch.json"];
    assert.equal(createSurface("worker", command), "terminal_12");
    assert.deepEqual(calls.at(-1), ["action", "new-pane", "--near-current-pane", "--name", "worker",
      "--cwd", "/", "--", ...command]);
    closeSurface("terminal_12");
    assert.deepEqual(calls.at(-1), ["action", "close-pane", "--pane-id", "terminal_12"]);
    assert.throws(() => closeSurface("invalid"), /Invalid Zellij pane ID/);
    pane = "unexpected";
    assert.throws(() => createSurface("worker", command), /valid pane ID/);
    process.env.ZELLIJ_PANE_ID = "invalid";
    assert.throws(requireZellij, /Start pi inside Zellij/);
  } finally {
    process.env = originalEnv;
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
