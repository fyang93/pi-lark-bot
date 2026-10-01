// herdr panes for worker sessions. Pane ids look like `w1:p2`.
// Workers open as unfocused splits of the controller's own pane, or in a
// background tab when splitting it would leave either half too small.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = { encoding: "utf8" as const, timeout: 10_000 };
const bin = () => process.env.HERDR_BIN_PATH || "herdr";
const MIN_COLUMNS = 50, MIN_ROWS = 15;

export function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("Start pi inside herdr before running /lark-bot on.");
  }
  try { execFileSync(bin(), ["--version"], { ...options, timeout: 5000 }); }
  catch { throw new Error("herdr must be installed and available on PATH."); }
}

/** herdr prints `{result}` or `{error: {code, message}}` (exit 1); raise its message, never output bodies. */
async function herdr(args: string[]): Promise<any> {
  let stdout: string;
  try { ({ stdout } = await execFileAsync(bin(), args, options)); }
  catch (error: any) {
    let code = "failed";
    try { code = JSON.parse(error.stdout || error.stderr).error.code; } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed (${code})`);
  }
  return stdout.trim() ? JSON.parse(stdout).result : undefined;
}

/** Split direction that leaves both halves usable; a cell is about twice as tall as wide. */
export function splitDirection(width: number, height: number): "right" | "down" | null {
  const fits = { right: Math.floor(width / 2) >= MIN_COLUMNS && height >= MIN_ROWS, down: width >= MIN_COLUMNS && Math.floor(height / 2) >= MIN_ROWS };
  const order: ("right" | "down")[] = height * 2 > width ? ["down", "right"] : ["right", "down"];
  return order.find(direction => fits[direction]) ?? null;
}

const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

/** Open a pane named `name` and run `command` (literal argv, shell-quoted) in its shell; returns the pane id. */
export async function createSurface(name: string, command: string[]): Promise<string> {
  requireHerdr();
  let layout: any;
  try { ({ layout } = await herdr(["pane", "layout", "--pane", process.env.HERDR_PANE_ID!])); }
  catch { throw new Error("Cannot inspect herdr layout; worker creation was not attempted."); }
  // Split only the controller's own pane, never another pane the user may be working in;
  // a background tab when it is too small or zoomed. Never unzoom or rearrange the layout.
  const parent = process.env.HERDR_PANE_ID!;
  const own = layout.zoomed ? undefined : layout.panes.find((pane: any) => pane.pane_id === parent);
  const direction = own && splitDirection(own.rect.width, own.rect.height);
  const pane: string = direction
    ? (await herdr(["pane", "split", parent, "--direction", direction, "--no-focus", "--cwd", "/"])).pane.pane_id
    : (await herdr(["tab", "create", "--no-focus", "--label", name, "--cwd", "/"])).root_pane.pane_id;
  await herdr(["pane", "rename", pane, name]).catch(() => {});
  try { await herdr(["pane", "run", pane, command.map(quote).join(" ")]); }
  catch (error) { closeSurface(pane); throw error; }
  return pane;
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
