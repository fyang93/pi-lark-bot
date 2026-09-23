// Executed inside a new Zellij pane. No shell interpolation or remote text in argv.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
let child;
try {
  const path = process.argv[2];
  const handle = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let config;
  try { config = JSON.parse(fs.readFileSync(handle, "utf8")); }
  finally { fs.closeSync(handle); }
  fs.unlinkSync(path); // one-use private environment handoff, never retain model API keys
  const env = { ...config.env };
  for (const key of ["ZELLIJ", "ZELLIJ_PANE_ID", "ZELLIJ_SESSION_NAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
    else delete env[key];
  }
  child = spawn(process.execPath, [config.cli, ...config.args], { cwd: config.cwd, env, stdio: "inherit" });
  let force;
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(signal, () => {
      child.kill(signal);
      if (!force) force = setTimeout(() => child.kill("SIGKILL"), 3000);
    });
  }
  child.on("error", () => { console.error("Could not launch pi worker."); process.exitCode = 1; });
  child.on("exit", (code) => { clearTimeout(force); process.exitCode = code ?? 1; });
} catch {
  console.error("Could not read private pi worker launch configuration.");
  process.exitCode = 1;
}
