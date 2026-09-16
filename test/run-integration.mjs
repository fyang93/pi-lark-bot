// Isolated tmux server: no commands can target the user's working server.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rename, access } from "node:fs/promises";
import { watch, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[2] === "--inside") {
  const root = process.argv[3];
  const log = openSync(join(root, "test.log"), "w", 0o600);
  const child = spawn(process.execPath, [join(project, "node_modules/tsx/dist/cli.mjs"), "--test", "--test-timeout=100000", "test/integration.test.ts"], { cwd: project, env: process.env, stdio: ["ignore", log, log] });
  closeSync(log);
  const finish = async (code) => {
    await writeFile(join(root, "exit-code.tmp"), String(code));
    await rename(join(root, "exit-code.tmp"), join(root, "exit-code"));
    process.exitCode = code;
  };
  child.on("error", () => void finish(1));
  child.on("exit", (code) => void finish(code ?? 1));
} else {
  const root = await mkdtemp(join(tmpdir(), "pi-lark-bot-test-"));
  const socket = join(root, "tmux.sock");
  const session = `pi-lark-bot-test-${randomUUID()}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT_") && !key.startsWith("PI_LARK_BOT_") && key !== "TMUX" && key !== "TMUX_PANE"));
  Object.assign(env, { PI_LARK_BOT_INTEGRATION: "1", PI_LARK_BOT_TEST_SOCKET: socket });
  try { await access(resolve(project, "../pi-interactive-subagents/pi-extension/subagents/tmux.ts")); env.PI_LARK_BOT_SIBLING_TEST = "1"; } catch {}
  let watcher, timer;
  const result = new Promise((accept, reject) => {
    watcher = watch(root, (_event, file) => { if (file === "exit-code") accept(); });
    timer = setTimeout(() => reject(new Error("Isolated tmux integration timed out")), 115000);
  });
  result.catch(() => {});
  try {
    await exec("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "200", "-y", "60", "-c", project, "--", process.execPath, fileURLToPath(import.meta.url), "--inside", root], { env, timeout: 10000 });
    await result;
    process.exitCode = Number(await readFile(join(root, "exit-code"), "utf8")) || 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    clearTimeout(timer); watcher.close();
    await exec("tmux", ["-S", socket, "kill-server"], { env, timeout: 5000 }).catch(() => {});
    try { console.log(await readFile(join(root, "test.log"), "utf8")); } catch {}
    console.log(`Isolated server diagnostics: ${root}`);
  }
}
