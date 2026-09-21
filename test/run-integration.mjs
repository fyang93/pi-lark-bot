// Isolated Zellij session: no commands target the user's working session.
// util-linux `script` supplies a PTY for the real TUI and focus assertions.
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
  const session = `pi-lark-bot-test-${randomUUID()}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT_") && !key.startsWith("PI_LARK_BOT_") && !key.startsWith("ZELLIJ")));
  Object.assign(env, { PI_LARK_BOT_INTEGRATION: "1", PI_LARK_BOT_TEST_SESSION: session, TERM: "xterm-256color" });
  try { await access(resolve(project, "../pi-interactive-subagents/pi-extension/subagents/zellij.ts")); env.PI_LARK_BOT_SIBLING_TEST = "1"; } catch {}
  const config = join(root, "config.kdl"), layout = join(root, "layout.kdl");
  await writeFile(config, 'on_force_close "quit"\nsession_serialization false\nauto_layout true\n');
  await writeFile(layout, `layout {\n pane command=${JSON.stringify(process.execPath)} {\n  args ${[fileURLToPath(import.meta.url), "--inside", root].map((s) => JSON.stringify(s)).join(" ")}\n }\n}\n`);
  let watcher, timer, terminal, rejectResult;
  const result = new Promise((accept, reject) => {
    rejectResult = reject;
    watcher = watch(root, (_event, file) => { if (file === "exit-code") accept(); });
    timer = setTimeout(() => reject(new Error("Isolated Zellij integration timed out")), 115000);
  });
  result.catch(() => {});
  try {
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    terminal = spawn("script", ["-q", "-c", `stty cols 200 rows 60; exec ${["zellij", "--config", config, "--new-session-with-layout", layout, "--session", session].map(quote).join(" ")}`, join(root, "terminal.log")], { env, stdio: ["pipe", "ignore", "ignore"] });
    terminal.on("error", rejectResult);
    terminal.on("exit", () => rejectResult(new Error("Isolated Zellij terminal exited before tests completed")));
    await result;
    process.exitCode = Number(await readFile(join(root, "exit-code"), "utf8")) || 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    clearTimeout(timer); watcher.close();
    await exec("zellij", ["kill-session", session], { env, timeout: 5000 }).catch(() => {});
    terminal?.stdin.end();
    terminal?.kill();
    try { console.log(await readFile(join(root, "test.log"), "utf8")); } catch {}
    console.log(`Isolated session diagnostics: ${root}`);
  }
}
