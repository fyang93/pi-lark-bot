import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
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
    await assert.rejects(acquireLock(root), /running or unverified/);
    await unlock(); await unlock();
    assert.deepEqual(await inspectLock(root), { state: "none" });
    const unlock2 = await acquireLock(root); await unlock2();
    const lockPath = join(root, "controller.lock");
    await writePrivateJson(lockPath, { pid: 0 });
    await assert.rejects(acquireLock(root), /unverified/);
    assert.deepEqual(await readPrivateJson(lockPath), { pid: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dead owner is recovered once; unresponsive socket is never reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-storage-owner-"));
  const lockPath = join(root, "controller.lock");
  const socketDir = join(root, "fake");
  const socketPath = join(socketDir, "push.sock");
  const peers = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.on("error", () => {});
  });
  try {
    await writePrivateJson(lockPath, { pid: 2147483647, token: "old" });
    assert.equal((await inspectLock(root)).state, "stale");
    const [a, b] = await Promise.allSettled([acquireLock(root), acquireLock(root)]);
    const owners = [a, b].filter((value): value is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>> => value.status === "fulfilled");
    assert.equal(owners.length, 1, "two simultaneous recovery attempts cannot own the lock");
    await owners[0]!.value();
    await writePrivateJson(lockPath, { pid: 2147483647, token: "old" });
    await mkdir(socketDir, { mode: 0o700 });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    await writePrivateJson(join(root, "push-endpoint.json"),
      { cwd: root, appId: "cli_test", token: "secret", ownerToken: "old", socket: socketPath });
    assert.equal((await inspectLock(root)).state, "invalid", "unresponsive socket must fail closed");
    await assert.rejects(acquireLock(root), /unverified/);
    assert.deepEqual(await readPrivateJson(lockPath), { pid: 2147483647, token: "old" });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
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
