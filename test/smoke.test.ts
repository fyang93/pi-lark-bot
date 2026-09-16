import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Uses the actual installed pi loader (jiti), not the tsx test runner's imports. No model request. */
test("real pi loads packaged extension without activating it", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-smoke-"));
  const cwd = join(root, "project"); await mkdir(cwd);
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") };
  delete env.PI_LARK_BOT_WORKER;
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", resolve("src/index.ts")],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((done) => { child.once("exit", () => done()); child.once("error", () => done()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await new Promise<any>((accept, reject) => {
      timer = setTimeout(() => reject(new Error("pi smoke startup timeout")), 20_000);
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value: any;
          try { value = JSON.parse(line); } catch { continue; }
          if (value.type === "extension_error") reject(new Error("pi extension loading error"));
          if (value.id === "commands") accept(value);
        }
      });
      child.stderr.resume();
      child.once("error", reject);
      child.once("exit", () => reject(new Error("pi exited before get_commands")));
      child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    });
    assert.equal(commands.success, true);
    assert(commands.data.commands.some((command: any) => command.name === "lark-bot"));
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited; clearTimeout(force);
    await rm(root, { recursive: true, force: true });
  }
});
