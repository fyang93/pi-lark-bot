import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCallback);
test("launcher preserves actual pane identity, transfers environment privately and never interprets arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-launcher-test-"));
  try {
    const cli = join(root, "fake-cli.cjs");
    await writeFile(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),pane:process.env.ZELLIJ_PANE_ID,secret:process.env.FIXTURE_SECRET,cwd:process.cwd()}));');
    const config = join(root, "launch.json");
    const args = ['$(touch never-created)', 'a\n!echo not-a-command', '"quoted"'];
    await writeFile(config, JSON.stringify({ cli, args, cwd: root, env: { FIXTURE_SECRET: "private-value", ZELLIJ_PANE_ID: "wrong-parent-id" } }), { mode: 0o600 });
    const result = await execFile(process.execPath, [resolve("src/launch-worker.cjs"), config], {
      env: { ...process.env, ZELLIJ_PANE_ID: "new-pane-id" }, timeout: 5000,
    });
    assert.deepEqual(JSON.parse(result.stdout), { args, pane: "new-pane-id", secret: "private-value", cwd: root });
    await assert.rejects(readFile(config), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "never-created")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
