#!/usr/bin/env node
// Deterministic subprocess fixture: no real terminal or API calls.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
if (process.argv[2] === "--child") {
  const config = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const session = config.args[config.args.indexOf("--session") + 1];
  const socket = net.createConnection(config.env.PI_LARK_BOT_SOCKET);
  const watchdog = setTimeout(() => process.exit(2), 20000);
  socket.setEncoding("utf8");
  const send = (message) => socket.write(JSON.stringify(message) + "\n");
  socket.on("connect", () => {
    send({ type: "hello", runId: config.env.PI_LARK_BOT_RUN_ID, token: config.env.PI_LARK_BOT_TOKEN });
    setTimeout(() => send({ type: "ready" }), Number(config.env.TEST_READY_DELAY || 0));
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.type !== "prompt") continue;
      if (message.text === "CRASH") process.exit(0);
      fs.appendFileSync(session, JSON.stringify(message) + "\n");
      send({ type: "done", id: "wrong-id", text: "must-ignore" });
      send({ type: "progress", id: message.id, text: "working" });
      const line = Buffer.from(JSON.stringify({ type: "text", id: message.id, text: "你好🙂" }) + "\n");
      const offset = line.indexOf(Buffer.from("你")) + 1;
      socket.write(line.subarray(0, offset));
      setImmediate(() => {
        socket.write(line.subarray(offset));
        send({ type: "done", id: message.id, text: message.text });
      });
    }
  });
  socket.on("error", () => process.exit(0));
  socket.on("close", () => { clearTimeout(watchdog); process.exit(0); });
} else {
  const root = path.dirname(process.argv[1]);
  const action = process.argv[2];
  if (action === "split-window") {
    fs.writeFileSync(path.join(root, `pane-${process.pid}.json`), JSON.stringify({ pid: null }));
    console.log(`%${process.pid}`);
  } else if (action === "respawn-pane") {
    const id = process.argv[process.argv.indexOf("-t") + 1].slice(1);
    const child = spawn(process.execPath, [__filename, "--child", process.argv.at(-1)], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(root, `pane-${id}.json`), JSON.stringify({ pid: child.pid }));
  } else if (action === "kill-pane") {
    const id = process.argv.at(-1).slice(1), file = path.join(root, `pane-${id}.json`);
    try { const { pid } = JSON.parse(fs.readFileSync(file, "utf8")); process.kill(pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(file); } catch {}
  } else if (action !== "select-layout") process.exitCode = 1;
}
