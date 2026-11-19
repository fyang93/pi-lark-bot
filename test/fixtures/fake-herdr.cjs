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
      if (!fs.existsSync(session)) fs.writeFileSync(session, JSON.stringify({
        type: "session", version: 3, id: "fixture", cwd: config.cwd, timestamp: new Date().toISOString(),
      }) + "\n");
      const leaf = JSON.parse(fs.readFileSync(session, "utf8").trim().split("\n").at(-1));
      fs.appendFileSync(session, JSON.stringify({ type: "custom_message", customType: "lark_input",
        id: message.id, parentId: leaf.type === "session" ? null : leaf.id, timestamp: new Date().toISOString(),
        content: message.text, display: true }) + "\n");
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
  const newPane = (workspace) => {
    const counter = path.join(root, "pane-counter");
    const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
    fs.writeFileSync(counter, String(n));
    fs.writeFileSync(path.join(root, `pane-${n}.json`), "{}");
    return `${workspace}:p${n}`;
  };
  const file = (pane) => path.join(root, `pane-${pane.split(":p").at(-1)}.json`);
  const probe = (kind, pane) => {
    const counter = `${file(pane)}-${kind}`;
    const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
    fs.writeFileSync(counter, String(count));
    return count;
  };
  const waitForRelease = (gate) => {
    const deadline = Date.now() + 5000;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(root, gate))) {
      if (Date.now() >= deadline) fail("test_gate_timeout");
      Atomics.wait(cell, 0, 0, 10);
    }
  };
  fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\n");
  if (group === "--version") console.log("herdr 0.9.1");
  else if (group === "pane" && action === "current") {
    if (process.env.TEST_CURRENT_FAIL === "1") fail("pane_not_found");
    const currentFile = path.join(root, "current.json");
    const current = fs.existsSync(currentFile) ? JSON.parse(fs.readFileSync(currentFile, "utf8")) : { pane_id: "w1:p0", workspace_id: "w1" };
    ok({ pane: current });
  } else if (group === "tab" && action === "create") {
    const pane_id = newPane(args[1]);
    record({ action: "tab", workspace: args[1], focus: args[2], label: args[4], cwd: args[6] });
    if (process.env.TEST_TAB_GATE === args[4]) waitForRelease("release-tab");
    ok({ root_pane: { pane_id }, tab: {} });
  } else if (group === "pane" && action === "process-info") {
    if (process.env.TEST_PROBE_FAIL === "1") fail("unknown_command");
    const foreground_processes = [{ pid: 7 }];
    if (probe("process-info", args[1]) <= Number(process.env.TEST_SHELL_BUSY_CHECKS || 0)) foreground_processes.push({ pid: 8 });
    ok({ process_info: { shell_pid: 7, foreground_processes } });
  } else if (group === "pane" && action === "read") {
    if (probe("screen", args[0]) > Number(process.env.TEST_EMPTY_SCREEN_CHECKS || 0)) console.log("$ ");
  } else if ((group === "pane" || group === "agent") && action === "rename") {
    if (!fs.existsSync(file(args[0]))) fail("pane_not_found");
    if (group === "agent" && process.env.TEST_NAME_TAKEN === "1") fail("agent_name_taken");
    const saved = JSON.parse(fs.readFileSync(file(args[0]), "utf8"));
    fs.writeFileSync(file(args[0]), JSON.stringify({ ...saved, [group === "pane" ? "label" : "agent"]: args[1] }));
    ok({});
  } else if (group === "pane" && action === "run") {
    if (process.env.TEST_RUN_FAIL === "1") fail("pane_not_found");
    const saved = JSON.parse(fs.readFileSync(file(args[0]), "utf8"));
    if (process.env.TEST_RUN_NOOP === "1") record({ action: "run", pane: args[0] });
    else {
      // The shell would run `'node' 'launcher' 'launch.json'`; check it is quoted literal argv.
      const command = [...args[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map(m => m[1].replace(/'\\''/g, "'"));
      const assert = require("node:assert/strict");
      assert.equal(command.length, 3);
      assert.equal(command[0], process.execPath);
      assert.equal(path.basename(command[1]), "launch-worker.cjs");
      record({ action: "run", pane: args[0], args: JSON.parse(fs.readFileSync(command[2], "utf8")).args });
      const child = spawn(process.execPath, [__filename, "--child", command[2]], { detached: true, stdio: "ignore" });
      child.unref();
      fs.writeFileSync(file(args[0]), JSON.stringify({ ...saved, pid: child.pid }));
    }
    if (process.env.TEST_RUN_GATE && ["1", saved.label].includes(process.env.TEST_RUN_GATE)) waitForRelease("release-run");
    ok({});
  } else if (group === "agent" && action === "get") {
    // A pane moved to another workspace: the agent keeps its name, the pane gets a new id.
    const moved = path.join(root, "moved.json");
    if (!fs.existsSync(moved)) fail("agent_not_found");
    ok({ agent: { name: args[0], pane_id: JSON.parse(fs.readFileSync(moved, "utf8"))[args[0]] } });
  } else if (group === "pane" && action === "close") {
    try { process.kill(JSON.parse(fs.readFileSync(file(args[0]), "utf8")).pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(file(args[0])); } catch {}
    ok({ type: "ok" });
  } else process.exitCode = 1;
}
