// Pane primitives adapted from pi-interactive-subagents (MIT).
// Placement follows the user's layout; no shell input or exit polling needed.
import { execFileSync } from "node:child_process";

export function requireZellij(): void {
  // Zellij uses "0" as a presence marker; pane IDs are numeric, including zero.
  if (!process.env.ZELLIJ || !/^\d+$/.test(process.env.ZELLIJ_PANE_ID ?? "")) {
    throw new Error("Start pi inside Zellij 0.44+ before running /lark-bot on.");
  }
  let version: string;
  try { version = execFileSync("zellij", ["--version"], { encoding: "utf8", timeout: 5000 }); }
  catch { throw new Error("Zellij 0.44+ must be installed and available on PATH."); }
  const match = version.match(/zellij (\d+)\.(\d+)\.(\d+)/);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 44)) {
    throw new Error("Zellij 0.44+ is required for pane-targeted CLI actions.");
  }
}

export function createSurface(name: string, command: string[]): string {
  requireZellij();
  // --direction bypasses swap layouts and must not be combined with --near-current-pane.
  // Start the launcher directly, without waiting for a shell or typing commands.
  // IPC teardown owns closing: --close-on-exit races with controller cleanup.
  const pane = execFileSync("zellij", ["action", "new-pane", "--near-current-pane", "--name", name,
    "--cwd", "/", "--", ...command], { encoding: "utf8", timeout: 10_000 }).trim();
  if (!/^terminal_\d+$/.test(pane)) throw new Error("Zellij did not return a valid pane ID.");
  return pane;
}

export function closeSurface(surface: string): void {
  if (!/^terminal_\d+$/.test(surface)) throw new Error("Invalid Zellij pane ID.");
  execFileSync("zellij", ["action", "close-pane", "--pane-id", surface], { encoding: "utf8", timeout: 5000 });
}
