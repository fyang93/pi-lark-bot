import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BotConfig, PushTarget } from "./types.ts";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${path}`);
  await chmod(path, 0o700);
}

export async function readPrivateJson(path: string, repairPermissions = true): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Invalid private file: ${path}`);
    if (repairPermissions) await handle.chmod(0o600);
    try { return JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error(`Invalid JSON in private file: ${path}`); }
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
    throw new Error("Invalid bot config: expected brand, cli_ appId and appSecret.");
  }
  return { version: 1, brand: c.brand!, appId: c.appId, appSecret: c.appSecret };
}

export async function loadConfig(stateDir: string): Promise<BotConfig | undefined> {
  try {
    for (const dir of [dirname(stateDir), stateDir]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe config directory: ${dir}`);
    }
    return validateConfig(await readPrivateJson(join(stateDir, "config.json")));
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

/** Allowlisted senders are user open_ids only; group chats are never authorized as a unit. */
export function validateAllowlist(value: unknown): { appId: string; users: string[] } {
  const stored = value as { appId?: unknown; users?: unknown } | null;
  if (!stored || typeof stored.appId !== "string" || !Array.isArray(stored.users) ||
    stored.users.some((user) => typeof user !== "string" || !user)) throw new Error("Invalid allowlist.json");
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
    throw new Error("Invalid push-target.json: expected appId, chatId and chatType.");
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
  if ((await lstat(parent)).isSymbolicLink()) throw new Error("Project config directory must not be a symlink.");
  const ignore = join(parent, ".gitignore");
  let content = "";
  try {
    if ((await lstat(ignore)).isSymbolicLink()) throw new Error("Project .gitignore must not be a symlink.");
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

export async function inspectLock(stateDir: string): Promise<{ state: "none" | "running" | "stale" | "invalid"; pid?: number }> {
  try {
    const record = await readPrivateJson(join(stateDir, "controller.lock"), false) as { pid?: number };
    if (!record || !Number.isSafeInteger(record.pid) || record.pid! <= 0) return { state: "invalid" };
    try { process.kill(record.pid!, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "stale", pid: record.pid };
    }
    return { state: "running", pid: record.pid };
  } catch (error) { return { state: isMissing(error) ? "none" : "invalid" }; }
}

/** Atomic exclusive project lock. Never steal a live or ambiguous lock. */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const path = join(stateDir, "controller.lock");
  const token = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
    finally { await handle.close(); }
    return async () => {
      try {
        const record = await readPrivateJson(path) as { token?: string };
        if (record.token === token) await unlink(path);
      } catch (error) { if (!isMissing(error)) throw error; }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const record = await readPrivateJson(path) as { pid?: number };
    if (!record || !Number.isSafeInteger(record.pid) || record.pid! <= 0) {
      throw new Error("Invalid controller.lock; inspect it manually before removing it.");
    }
    try { process.kill(record.pid!, 0); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        throw new Error(`Stale controller.lock found. Confirm the previous controller and its panes have exited, then remove ${path} and retry.`);
      }
    }
    throw new Error("This project already has a running lark-bot controller.");
  }
}
