import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, inspectLock, loadConfig, prepareState, readPrivateJson, validateAllowlist, validateConfig, validatePushTarget, writePrivateJson } from "../src/storage.ts";

const config = { version: 1, brand: "feishu", appId: "cli_test", appSecret: "super-secret" };
test("credentials and ignore are project-local with private permissions; no global fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-storage-"));
  try {
    const a = join(root, "a"); const b = join(root, "b");
    const dir = await prepareState(a, ".pi");
    await prepareState(a, ".pi");
    await writePrivateJson(join(dir, "config.json"), config);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "config.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(a, ".pi", ".gitignore"), "utf8"), "/lark-bot/\n");
    assert.equal((await loadConfig(dir))?.appSecret, "super-secret");
    assert.equal(await loadConfig(join(b, ".pi", "lark-bot")), undefined);
    await writeFile(join(dir, "config.json"), '{"secret":"super-secret",bad');
    await assert.rejects(loadConfig(dir), (error: Error) => !error.message.includes("super-secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses symlinked auth files and config directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-storage-"));
  try {
    await mkdir(join(root, "actual")); await symlink(join(root, "actual"), join(root, ".pi"));
    await assert.rejects(prepareState(root, ".pi"), /symlink/);
    const path = join(root, "actual", "config.json");
    await writeFile(path, JSON.stringify(config));
    await symlink(path, join(root, "linked.json"));
    await assert.rejects(readPrivateJson(join(root, "linked.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exclusive lock prevents duplicate project listeners and releases idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-storage-"));
  try {
    assert.deepEqual(await inspectLock(root), { state: "none" });
    const unlock = await acquireLock(root);
    assert.deepEqual(await inspectLock(root), { state: "running", pid: process.pid });
    await assert.rejects(acquireLock(root), /already has a running/);
    await unlock(); await unlock();
    assert.deepEqual(await inspectLock(root), { state: "none" });
    const unlock2 = await acquireLock(root); await unlock2();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config rejects malformed secrets and unsupported brands", () => {
  assert.throws(() => validateConfig({ ...config, brand: "https://evil.test" }));
  assert.throws(() => validateConfig({ ...config, appSecret: "" }));
  assert.deepEqual(validateConfig(config), config);
});

test("push target and allowlist files reject malformed content", () => {
  assert.throws(() => validatePushTarget({ version: 1, appId: "cli_test", chatId: "oc_team" }), /Invalid push-target/);
  assert.throws(() => validatePushTarget({ version: 1, appId: "cli_test", chatId: "../escape", chatType: "group" }), /Invalid push-target/);
  assert.throws(() => validatePushTarget({ version: 2, appId: "cli_test", chatId: "oc_team", chatType: "group" }), /Invalid push-target/);
  assert.deepEqual(
    validatePushTarget({ version: 1, appId: "cli_test", chatId: "oc_team", chatType: "group", extra: "dropped" }),
    { version: 1, appId: "cli_test", chatId: "oc_team", chatType: "group", setBy: "", setAt: "" });
  assert.throws(() => validateAllowlist({ appId: "cli_test", users: ["ou_a", 7] }), /Invalid allowlist/);
  assert.throws(() => validateAllowlist({ appId: "cli_test" }), /Invalid allowlist/);
  assert.deepEqual(validateAllowlist({ appId: "cli_test", users: ["ou_a"] }), { appId: "cli_test", users: ["ou_a"] });
});
