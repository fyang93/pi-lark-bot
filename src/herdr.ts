// herdr panes for worker sessions. Pane ids look like `w1:p2`.
// Reuse owned worker panes without disturbing the user's focused pane; fall
// back to background tabs in the controller's workspace when no split fits.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = { encoding: "utf8" as const, timeout: 10_000 };
const bin = () => process.env.HERDR_BIN_PATH || "herdr";
const MIN_COLUMNS = 80, MIN_ROWS = 24;

export function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("请先在 herdr 分屏中启动 Pi，再执行 /lark-bot on。");
  }
  try { execFileSync(bin(), ["--version"], { ...options, timeout: 5000 }); }
  catch { throw new Error("请安装 herdr，并确认可从 PATH 执行。"); }
}

/** herdr prints `{result}` or `{error: {code, message}}` (exit 1); raise its message, never output bodies. */
async function herdr(args: string[], overrides: { timeout?: number; signal?: AbortSignal } = {}): Promise<any> {
  let stdout: string;
  try { ({ stdout } = await execFileAsync(bin(), args, { ...options, ...overrides })); }
  catch (error: any) {
    let code = "failed";
    try { code = JSON.parse(error.stdout || error.stderr).error.code; } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} 执行失败（${code}）。`);
  }
  return stdout.trim() ? JSON.parse(stdout).result : undefined;
}

/** Split direction that leaves both halves usable, side by side first. */
export function splitDirection(width: number, height: number): "right" | "down" | null {
  if (Math.floor(width / 2) >= MIN_COLUMNS && height >= MIN_ROWS) return "right";
  if (width >= MIN_COLUMNS && Math.floor(height / 2) >= MIN_ROWS) return "down";
  return null;
}

const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

// Queue only layout inspection + creation, not worker startup. Parallel messages
// must see the geometry resulting from the preceding split.
let creationQueue: Promise<unknown> = Promise.resolve();
const opened = new Set<string>();

async function openPane(name: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let current: any, target: string, direction: "right" | "down" | null = null;
  try {
    // HERDR_PANE_ID can be a stale launch-time alias after the controller moves.
    ({ pane: current } = await herdr(["pane", "current", "--current"], { signal }));
    const parent = current.pane_id;
    target = parent;
    const { panes } = await herdr(["pane", "list", "--workspace", current.workspace_id], { signal });
    // Only pane list reports workspace-wide focus; layout focus is per tab.
    const focused = panes.find((pane: any) => pane.focused)?.pane_id;
    const tabs = new Map<string, string[]>();
    for (const pane of panes) tabs.set(pane.tab_id, [...tabs.get(pane.tab_id) ?? [], pane.pane_id]);
    const layouts = [parent, ...[...tabs]
      .filter(([tab, ids]) => tab !== current.tab_id && ids.every(id => opened.has(id)))
      .map(([, ids]) => ids[0])];
    const area = (pane: any) => pane.rect.width * pane.rect.height;
    for (const id of layouts) {
      const { layout } = await herdr(["pane", "layout", "--pane", id], { signal });
      if (layout.zoomed) continue;
      const agents = layout.panes.filter((pane: any) => opened.has(pane.pane_id) && pane.pane_id !== focused);
      const own = layout.panes.filter((pane: any) => pane.pane_id === parent);
      for (const pane of [...agents.sort((a: any, b: any) => area(b) - area(a)), ...own]) {
        direction = splitDirection(pane.rect.width, pane.rect.height);
        if (direction) { target = pane.pane_id; break; }
      }
      if (direction) break;
    }
  } catch { throw new Error("无法读取 herdr 布局，未创建 Pi 会话分屏。"); }
  signal?.throwIfAborted();
  // Do not time out or abort creation: herdr may already have created the pane,
  // and its reply is the only way to learn the id needed for cleanup.
  const pane: string = direction
    ? (await herdr(["pane", "split", target!, "--direction", direction, "--no-focus", "--cwd", "/"], { timeout: 0 })).pane.pane_id
    : (await herdr(["tab", "create", "--workspace", current.workspace_id, "--no-focus", "--label", name, "--cwd", "/"], { timeout: 0 })).root_pane.pane_id;
  opened.add(pane);
  return pane;
}

/** Open a pane named `name` and run `command` (literal argv, shell-quoted) in its shell; returns the pane id. */
export async function createSurface(name: string, command: string[], signal?: AbortSignal): Promise<string> {
  requireHerdr();
  const opening = creationQueue.then(() => openPane(name, signal));
  creationQueue = opening.catch(() => {});
  const pane = await opening;
  try {
    signal?.throwIfAborted();
    await herdr(["pane", "rename", pane, name]).catch(() => {});
    signal?.throwIfAborted();
    await herdr(["pane", "run", pane, command.map(quote).join(" ")]);
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
  opened.delete(pane);
  if (agent) {
    try { pane = JSON.parse(execFileSync(bin(), ["agent", "get", agent], { ...options, timeout: 5000 })).result.agent.pane_id ?? pane; }
    catch { /* not (or no longer) a named agent: use the pane it was opened in */ }
  }
  opened.delete(pane);
  try { execFileSync(bin(), ["pane", "close", pane], { ...options, stdio: "ignore", timeout: 5000 }); }
  catch { /* an already-closed pane needs no cleanup */ }
}
