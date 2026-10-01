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
      if (message.type === "abort") { send({ type: "accepted", id: message.id }); continue; }
      if (message.type !== "prompt") continue;
      if (message.text === "CRASH") process.exit(0);
      fs.appendFileSync(session, JSON.stringify(message) + "\n");
      send({ type: "accepted", id: message.id });
      if (message.text === "NO_OUTPUT") continue;
      send({ type: "done", id: "wrong-id", text: "must-ignore" });
      send({ type: "progress", text: "working" });
      const line = Buffer.from(JSON.stringify({ type: "text", text: "你好🙂" }) + "\n");
      const offset = line.indexOf(Buffer.from("你")) + 1;
      socket.write(line.subarray(0, offset));
      setImmediate(() => {
        socket.write(line.subarray(offset));
        send({ type: "done", text: message.text });
      });
    }
  });
  socket.on("error", () => process.exit(0));
  socket.on("close", () => { clearTimeout(watchdog); process.exit(0); });
} else {
  // herdr CLI: records mutations in creates.jsonl; panes are pane-<n>.json with the worker's pid.
  const root = path.dirname(process.argv[1]);
  const [group, action, ...args] = process.argv.slice(2);
  const ok = (result) => console.log(JSON.stringify({ result }));
  const fail = (code) => { console.log(JSON.stringify({ error: { code, message: code } })); process.exit(1); };
  const record = (entry) => fs.appendFileSync(path.join(root, "creates.jsonl"), JSON.stringify(entry) + "\n");
  const newPane = () => {
    const counter = path.join(root, "pane-counter");
    const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
    fs.writeFileSync(counter, String(n));
    fs.writeFileSync(path.join(root, `pane-${n}.json`), "{}");
    return `w1:p${n}`;
  };
  const file = (pane) => path.join(root, `pane-${pane.replace("w1:p", "")}.json`);
  if (group === "--version") console.log("herdr 0.9.1");
  else if (group === "pane" && action === "layout") {
    if (process.env.TEST_LAYOUT_FAIL === "1") fail("pane_not_found");
    const panes = JSON.parse(process.env.TEST_LAYOUT || '[["w1:p0",160,50]]');
    ok({ layout: { zoomed: process.env.TEST_ZOOMED === "1", panes: panes.map(([pane_id, width, height]) => ({ pane_id, rect: { width, height } })) } });
  } else if (group === "pane" && action === "split") {
    record({ action: "split", target: args[0], direction: args[2], focus: args[3], cwd: args[5] });
    ok({ pane: { pane_id: newPane() } });
  } else if (group === "tab" && action === "create") {
    record({ action: "tab", focus: args[0], label: args[2], cwd: args[4] });
    ok({ root_pane: { pane_id: newPane() }, tab: {} });
  } else if ((group === "pane" || group === "agent") && action === "rename") {
    if (!fs.existsSync(file(args[0]))) fail("pane_not_found");
    const saved = JSON.parse(fs.readFileSync(file(args[0]), "utf8"));
    fs.writeFileSync(file(args[0]), JSON.stringify({ ...saved, [group === "pane" ? "label" : "agent"]: args[1] }));
    ok({});
  } else if (group === "pane" && action === "run") {
    if (process.env.TEST_RUN_FAIL === "1") fail("pane_not_found");
    // The shell would run `'node' 'launcher' 'launch.json'`; check it is quoted literal argv.
    const command = [...args[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map(m => m[1].replace(/'\\''/g, "'"));
    const assert = require("node:assert/strict");
    assert.equal(command.length, 3);
    assert.equal(command[0], process.execPath);
    assert.equal(path.basename(command[1]), "launch-worker.cjs");
    const child = spawn(process.execPath, [__filename, "--child", command[2]], { detached: true, stdio: "ignore" });
    child.unref();
    const saved = JSON.parse(fs.readFileSync(file(args[0]), "utf8"));
    fs.writeFileSync(file(args[0]), JSON.stringify({ ...saved, pid: child.pid }));
  } else if (group === "pane" && action === "close") {
    try { process.kill(JSON.parse(fs.readFileSync(file(args[0]), "utf8")).pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(file(args[0])); } catch {}
    ok({ type: "ok" });
  } else process.exitCode = 1;
}
