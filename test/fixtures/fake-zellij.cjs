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
  const root = path.dirname(process.argv[1]);
  const action = process.argv[3];
  const records = () => fs.readdirSync(root).filter(name => /^pane-\d+\.json$/.test(name))
    .map(name => ({ id: Number(name.match(/\d+/)[0]), ...JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) }));
  if (process.argv[2] === "--version") {
    console.log(process.env.TEST_ZELLIJ_VERSION || "zellij 0.44.3");
  } else if (action === "list-panes") {
    if (process.env.TEST_LIST_FAIL === "1") process.exit(1);
    let saved = records();
    if (process.env.TEST_TAB_LIST_DELAY === "1" && process.argv.includes("--all") && saved.some(p => p.tabId)) {
      const counter = path.join(root, "list-attempts");
      const attempts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(attempts + 1));
      if (!attempts) saved = saved.filter(p => !p.tabId);
    }
    const panes = process.env.TEST_PANES ? JSON.parse(process.env.TEST_PANES) :
      [{ id: 0, is_plugin: false, tab_id: 1, pane_rows: 50, pane_columns: 160 }];
    panes.push(...saved.map(p => ({ id: p.id, is_plugin: false, tab_id: p.tabId || 1,
      tab_name: p.tabName, title: p.title, pane_rows: 50, pane_columns: 80 })));
    if (process.env.TEST_TAB_AMBIGUOUS === "1") {
      const tab = saved.find(p => p.tabId);
      if (tab) panes.push({ id: tab.id + 1000000, is_plugin: false, tab_id: tab.tabId, tab_name: tab.tabName });
    }
    console.log(JSON.stringify(panes));
  } else if (action === "new-pane") {
    const assert = require("node:assert/strict");
    const args = process.argv.slice(4), command = args.slice(args.indexOf("--") + 1);
    assert.equal(args[0], /^zellij 0\.45\./.test(process.env.TEST_ZELLIJ_VERSION || "") ? "--no-focus" : "--near-current-pane");
    assert.equal(args[1], "--direction");
    assert(["right", "down"].includes(args[2]));
    assert.equal(args[3], "--name");
    assert.equal(command[0], process.execPath);
    assert.equal(path.basename(command[1]), "launch-worker.cjs");
    assert.equal(command.length, 3);
    fs.appendFileSync(path.join(root, "creates.jsonl"), JSON.stringify({ action, target: process.env.ZELLIJ_PANE_ID, direction: args[2], focus: args[0] }) + "\n");
    if (process.env.TEST_CREATE === "missing") process.exit(1);
    const child = spawn(process.execPath, [__filename, "--child", command[2]], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(root, `pane-${process.pid}.json`), JSON.stringify({ pid: child.pid, title: args[4] }));
    if (process.env.TEST_CREATE !== "lost-reply") console.log(`terminal_${process.pid}`);
    else process.exit(1);
  } else if (action === "new-tab") {
    const assert = require("node:assert/strict");
    const args = process.argv.slice(4), command = args.slice(args.indexOf("--") + 1);
    assert.deepEqual(args.slice(0, 7), ["--no-focus", "--name", args[2], "--cwd", "/", "--layout-string", "layout { pane; }"]);
    assert.equal(command[0], process.execPath);
    assert.equal(path.basename(command[1]), "launch-worker.cjs");
    assert.equal(command.length, 3);
    fs.appendFileSync(path.join(root, "creates.jsonl"), JSON.stringify({ action, focus: args[0], parent: process.env.ZELLIJ_PANE_ID }) + "\n");
    if (process.env.TEST_TAB_CREATE === "missing") process.exit(1);
    const child = spawn(process.execPath, [__filename, "--child", command[2]], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(root, `pane-${process.pid}.json`), JSON.stringify({ pid: child.pid, tabId: process.pid, tabName: args[2] }));
    if (process.env.TEST_TAB_CREATE !== "lost-reply") console.log(process.pid);
    else process.exit(1);
  } else if (action === "rename-tab") {
    const id = Number(process.argv[5]);
    const record = records().find(p => p.tabId === id);
    if (!record) process.exit(1);
    const file = path.join(root, `pane-${record.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...record, tabName: process.argv.at(-1) }));
  } else if (action === "rename-pane") {
    const id = process.argv[5].replace(/^terminal_/, ""), file = path.join(root, `pane-${id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8")); record.title = process.argv.at(-1);
    fs.writeFileSync(file, JSON.stringify(record));
  } else if (action === "close-pane") {
    const id = process.argv.at(-1).replace(/^terminal_/, ""), file = path.join(root, `pane-${id}.json`);
    try { const { pid } = JSON.parse(fs.readFileSync(file, "utf8")); process.kill(pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(file); } catch {}
  } else process.exitCode = 1;
}
