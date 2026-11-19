// Each Lark conversation runs in the root pane of its own background herdr tab.
// Pane ids look like `w1:p2`.
import { execFile, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = { encoding: "utf8" as const, timeout: 10_000 };
const bin = () => process.env.HERDR_BIN_PATH || "herdr";

export function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("请先在 herdr 中启动 Pi，再执行 /lark-bot on。");
  }
  try { execFileSync(bin(), ["--version"], { ...options, timeout: 5000 }); }
  catch { throw new Error("请安装 herdr，并确认可从 PATH 执行。"); }
}

/** herdr prints `{result}` (plain text for `pane read`) or `{error: {code, message}}` (exit 1). */
async function herdr(args: string[], { raw, ...overrides }: { timeout?: number; signal?: AbortSignal; raw?: boolean } = {}): Promise<any> {
  let stdout: string;
  try { ({ stdout } = await execFileAsync(bin(), args, { ...options, ...overrides })); }
  catch (error: any) {
    overrides.signal?.throwIfAborted();
    let code = "failed";
    try { code = JSON.parse(error.stdout || error.stderr).error.code; } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} 执行失败（${code}）。`);
  }
  return raw ? stdout : stdout.trim() ? JSON.parse(stdout).result : undefined;
}

const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

// Serialize tab creation only; workers can start and run concurrently.
let creationQueue: Promise<unknown> = Promise.resolve();

async function openTab(name: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Resolve the live controller: HERDR_PANE_ID can be stale after a move.
  const current = await herdr(["pane", "current", "--current"], { signal });
  signal?.throwIfAborted();
  const workspace = current?.pane?.workspace_id;
  if (typeof workspace !== "string" || !workspace) throw new Error("无法读取 herdr 当前工作区，未创建 Pi 会话标签页。");
  // Do not time out or abort creation: herdr may already have created the tab,
  // and its reply is the only way to learn the root pane id needed for cleanup.
  const { root_pane } = await herdr([
    "tab", "create", "--workspace", workspace, "--no-focus", "--label", name, "--cwd", "/",
  ], { timeout: 0 });
  return root_pane.pane_id;
}

/** Shell startup scripts can consume the command that `pane run` types into a new tab. */
async function waitForShell(pane: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  for (let ready = 0; ready < 2 && Date.now() < deadline;) {
    await delay(100, undefined, { signal });
    try {
      const { process_info: info } = await herdr(["pane", "process-info", "--pane", pane], { signal, timeout: remaining() });
      const idle = info.foreground_processes.length === 1 && info.foreground_processes[0].pid === info.shell_pid;
      const output = idle && await herdr([
        "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "5",
      ], { raw: true, signal, timeout: remaining() });
      ready = output && output.trim() ? ready + 1 : 0;
    } catch {
      // Older herdr versions may not report shell state; let `pane run` decide.
      signal?.throwIfAborted();
      return;
    }
  }
}

/** Open a dedicated background tab and run literal argv in its root pane's shell. */
export async function createSurface(name: string, command: string[], signal?: AbortSignal): Promise<string> {
  requireHerdr();
  const opening = creationQueue.then(() => openTab(name, signal));
  creationQueue = opening.catch(() => {});
  const pane = await opening;
  try {
    signal?.throwIfAborted();
    await herdr(["pane", "rename", pane, name]).catch(() => {});
    await waitForShell(pane, signal);
    signal?.throwIfAborted();
    await herdr(["pane", "run", pane, command.map(quote).join(" ")]);
    signal?.throwIfAborted();
    return pane;
  } catch (error) { closeSurface(pane); throw error; }
}

/**
 * Show the pane's pi in herdr's agents sidebar under `name` ([a-z][a-z0-9_-]{0,31}); true once
 * it holds the name. herdr may detect the agent a moment after the worker is ready, so this
 * retries; a name held by another agent is not retried.
 */
export async function nameAgent(pane: string, name: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { await herdr(["agent", "rename", pane, name]); return true; }
    catch (error) {
      if (String((error as Error).message).includes("agent_name_taken")) return false;
      await new Promise((done) => setTimeout(done, 1000).unref());
    }
  }
  return false;
}

/**
 * Close the pane, found through its agent name when given: a pane moved to another
 * workspace gets a new id, the name follows the agent. Falls back to `pane`. Pass a
 * name only once this pane's agent holds it, or another agent's pane could be closed.
 */
export function closeSurface(pane: string, agent?: string): void {
  if (agent) {
    try { pane = JSON.parse(execFileSync(bin(), ["agent", "get", agent], { ...options, timeout: 5000 })).result.agent.pane_id ?? pane; }
    catch { /* not (or no longer) a named agent: use the pane it was opened in */ }
  }
  try { execFileSync(bin(), ["pane", "close", pane], { ...options, stdio: "ignore", timeout: 5000 }); }
  catch { /* an already-closed pane needs no cleanup */ }
}
