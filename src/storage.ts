import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BotConfig, PushTarget } from "./types.ts";
import type { Endpoint } from "./push-ipc.ts";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`目录不安全，已拒绝访问：${path}`);
  await chmod(path, 0o700);
}

export async function readPrivateJson(path: string, repairPermissions = true): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`私有文件无效或过大：${path}`);
    if (repairPermissions) await handle.chmod(0o600);
    try { return JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error(`私有文件的 JSON 格式无效：${path}`); }
  } finally { await handle.close(); }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await privateDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

export function validateConfig(value: unknown): BotConfig {
  const c = value as Partial<BotConfig> | null;
  if (!c || c.version !== 1 || !["feishu", "lark"].includes(c.brand ?? "") ||
    typeof c.appId !== "string" || !/^cli_[a-zA-Z0-9_-]+$/.test(c.appId) ||
    typeof c.appSecret !== "string" || !c.appSecret.trim() || c.appSecret.length > 4096) {
    throw new Error("机器人配置无效：请检查品牌、以 cli_ 开头的 App ID 和 App Secret。");
  }
  return { version: 1, brand: c.brand!, ...(c.domain === "feishu" || c.domain === "lark" ? { domain: c.domain } : {}), appId: c.appId, appSecret: c.appSecret };
}

export async function loadConfig(stateDir: string): Promise<BotConfig | undefined> {
  try {
    for (const dir of [dirname(stateDir), stateDir]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`配置目录不安全，已拒绝访问：${dir}`);
    }
    return validateConfig(await readPrivateJson(join(stateDir, "config.json")));
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

/** Allowlisted senders are user open_ids only; group chats are never authorized as a unit. */
export function validateAllowlist(value: unknown): { appId: string; users: string[] } {
  const stored = value as { appId?: unknown; users?: unknown } | null;
  if (!stored || typeof stored.appId !== "string" || !Array.isArray(stored.users) ||
    stored.users.some((user) => typeof user !== "string" || !user)) throw new Error("allowlist.json 格式无效，请检查白名单文件。");
  return { appId: stored.appId, users: stored.users as string[] };
}

/** An allowlist written under a different App ID never carries over. */
export async function loadAllowlist(stateDir: string, appId: string): Promise<Set<string>> {
  try {
    const stored = validateAllowlist(await readPrivateJson(join(stateDir, "allowlist.json")));
    return new Set(stored.appId === appId ? stored.users : []);
  } catch (error) { if (isMissing(error)) return new Set(); throw error; }
}

export async function saveAllowlist(stateDir: string, appId: string, users: Iterable<string>): Promise<void> {
  await writePrivateJson(join(stateDir, "allowlist.json"), { appId, users: [...new Set(users)].sort() });
}

export function validatePushTarget(value: unknown): PushTarget {
  const target = value as Partial<PushTarget> | null;
  if (!target || target.version !== 1 || typeof target.appId !== "string" || !target.appId ||
    typeof target.chatId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target.chatId) ||
    (target.chatType !== "p2p" && target.chatType !== "group")) {
    throw new Error("push-target.json 格式无效：请检查 appId、chatId 和 chatType。");
  }
  return { version: 1, appId: target.appId, chatId: target.chatId, chatType: target.chatType,
    setBy: typeof target.setBy === "string" ? target.setBy : "",
    setAt: typeof target.setAt === "string" ? target.setAt : "" };
}

/** Absent, or stored under another App ID, both mean "no target": pushing stays disabled. */
export async function loadPushTarget(stateDir: string, appId: string): Promise<PushTarget | undefined> {
  try {
    const target = validatePushTarget(await readPrivateJson(join(stateDir, "push-target.json")));
    return target.appId === appId ? target : undefined;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export async function savePushTarget(stateDir: string, target: PushTarget | undefined): Promise<void> {
  const path = join(stateDir, "push-target.json");
  if (target) await writePrivateJson(path, target);
  else await rm(path, { force: true });
}

/** Add ignore before any credential is created; never modify global Git configuration. */
export async function prepareState(cwd: string, configDirName: string): Promise<string> {
  const parent = join(cwd, configDirName);
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink()) throw new Error("项目配置目录不能是符号链接。");
  const ignore = join(parent, ".gitignore");
  let content = "";
  try {
    if ((await lstat(ignore)).isSymbolicLink()) throw new Error("项目配置目录中的 .gitignore 不能是符号链接。");
    content = await readFile(ignore, "utf8");
  } catch (error) { if (!isMissing(error)) throw error; }
  if (!content.split(/\r?\n/).includes("/lark-bot/")) {
    const handle = await open(ignore, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(`${content && !content.endsWith("\n") ? "\n" : ""}/lark-bot/\n`); }
    finally { await handle.close(); }
  }
  const dir = join(parent, "lark-bot");
  await privateDir(dir);
  return dir;
}

type Lock = { pid: number; token: string };
async function probe(stateDir: string, lock: Lock): Promise<"live" | "dead" | "unknown"> {
  let endpoint: Endpoint;
  try { endpoint = await readPrivateJson(join(stateDir, "push-endpoint.json"), false) as Endpoint; }
  catch (error) { return isMissing(error) ? "dead" : "unknown"; }
  if (!endpoint || typeof endpoint.token !== "string" || endpoint.ownerToken !== lock.token ||
    typeof endpoint.cwd !== "string" || typeof endpoint.appId !== "string" || typeof endpoint.socket !== "string" ||
    basename(endpoint.socket) !== "push.sock") return "unknown";
  try {
    const directory = await lstat(dirname(endpoint.socket));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700) return "unknown";
    const socket = await lstat(endpoint.socket);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) return "unknown";
  } catch (error) { if (isMissing(error)) return "dead"; return "unknown"; }
  return new Promise((resolve) => {
    const socket = createConnection(endpoint.socket); let data = "", done = false;
    const finish = (state: "live" | "dead" | "unknown") => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(state);
    };
    const timer = setTimeout(() => finish("unknown"), 1000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ type: "ping", token: endpoint.token, cwd: endpoint.cwd, appId: endpoint.appId }) + "\n"));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "dead" : "unknown"));
    socket.on("close", () => finish("unknown"));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) { finish("unknown"); return; }
      const end = data.indexOf("\n"); if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        finish(response.ok === true && response.type === "status" && response.ownerToken === lock.token &&
          response.cwd === endpoint.cwd && response.appId === endpoint.appId && response.socket === endpoint.socket ? "live" : "unknown");
      } catch { finish("unknown"); }
    });
  });
}

export async function inspectLock(stateDir: string): Promise<{ state: "none" | "running" | "stale" | "invalid"; pid?: number }> {
  try {
    const record = await readPrivateJson(join(stateDir, "controller.lock"), false) as Lock;
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.token !== "string") return { state: "invalid" };
    const peer = await probe(stateDir, record);
    if (peer === "live") return { state: "running", pid: record.pid };
    if (peer === "unknown") return { state: "invalid", pid: record.pid }; // unresponsive owners fail closed
    try { process.kill(record.pid, 0); return { state: "running", pid: record.pid }; }
    catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "running", pid: record.pid }; }
  } catch (error) { return { state: isMissing(error) ? "none" : "invalid" }; }
}

/** Atomically claim the project; recover only a provably dead owner under a recovery mutex. */
export async function acquireLock(stateDir: string): Promise<(() => Promise<void>) & { token: string }> {
  const path = join(stateDir, "controller.lock");
  const token = randomUUID();
  const claim = async () => {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
    finally { await handle.close(); }
  };
  try { await claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await inspectLock(stateDir)).state !== "stale") throw new Error("此项目已有正在运行或身份未确认的 Lark 控制端，请检查 owner 会话。");
    const mutex = join(stateDir, "controller.recovery");
    try { await mkdir(mutex, { mode: 0o700 }); }
    catch { throw new Error("正在恢复控制端，或恢复状态无法确认；请稍后重试或手动检查。"); }
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() ||
        (before.mode & 0o777) !== 0o600) throw new Error("控制端锁文件不安全，请手动检查。");
      const record = await readPrivateJson(path, false) as Lock;
      if ((await inspectLock(stateDir)).state !== "stale") throw new Error("恢复期间控制端 owner 已变化，请重新检查。");
      const after = await lstat(path);
      if (before.ino !== after.ino || before.dev !== after.dev) throw new Error("恢复期间控制端锁文件已变化，请重新检查。");
      // Only a dead process with a missing/refused endpoint may be reclaimed.
      const endpointPath = join(stateDir, "push-endpoint.json");
      try {
        const entry = await lstat(endpointPath);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() ||
          (entry.mode & 0o777) !== 0o600) throw new Error("控制端端点文件不安全，请手动检查。");
        const endpoint = await readPrivateJson(endpointPath, false) as Endpoint;
        if (endpoint.ownerToken !== record.token) throw new Error("无法确认控制端端点的身份，请手动检查。");
        await unlink(endpointPath);
      } catch (e) { if (!isMissing(e)) throw e; }
      await unlink(path);
      await claim();
    } finally { await rmdir(mutex); }
  }
  const unlock = (async () => {
    try {
      const record = await readPrivateJson(path) as Lock;
      if (record.token === token) await unlink(path);
    } catch (error) { if (!isMissing(error)) throw error; }
  }) as (() => Promise<void>) & { token: string };
  unlock.token = token;
  return unlock;
}
