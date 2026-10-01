// Executed inside a new herdr pane. No shell interpolation or remote text in argv.
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
  // The pane's own herdr identity, not the controller's, so herdr attributes the worker to this pane.
  for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith("HERDR_")) env[key] = value;
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
