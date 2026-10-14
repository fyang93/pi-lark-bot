import { execFileSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { privateDir, writePrivateJson } from "./storage.ts";
import type { ConversationWorker, ModelSpec, WorkerEvent, WorkerFactory, WorkerRequest, WorkerResponse } from "./types.ts";

import { closeSurface } from "./zellij.ts";
import { measurePane, selectPlacement, type PaneGeometry } from "./zellij-layout.ts";

/** Split selection and tab reconciliation adapted from HazAT/pi-interactive-subagents (MIT). */
let creationQueue: Promise<unknown> = Promise.resolve();
function createWorkerSurface(name: string, command: string[]): Promise<string> {
  const result = creationQueue.then(() => createWorkerSurfaceUnlocked(name, command));
  creationQueue = result.catch(() => {});
  return result;
}
async function createWorkerSurfaceUnlocked(name: string, command: string[]): Promise<string> {
  const parent = process.env.ZELLIJ_PANE_ID;
  if (!process.env.ZELLIJ || !parent || !/^\d+$/.test(parent)) throw new Error("Start pi inside Zellij 0.44+ before running /lark-bot on.");
  const options = { encoding: "utf8" as const, timeout: 10_000 };
  let version: string;
  try { version = execFileSync("zellij", ["--version"], options); }
  catch { throw new Error("Zellij 0.44+ must be installed and available on PATH."); }
  const match = version.match(/zellij (\d+)\.(\d+)\.(\d+)/);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 44)) throw new Error("Zellij 0.44+ is required for pane-targeted CLI actions.");
  const noFocus = Number(match[1]) > 0 || Number(match[2]) >= 45;
  let panes: PaneGeometry[];
  try {
    const found: unknown = JSON.parse(execFileSync("zellij", ["action", "list-panes", "--json", "--geometry", "--state", "--tab"],
      { ...options, env: { ...process.env, ZELLIJ_PANE_ID: parent } }));
    if (!Array.isArray(found) || !found.every((p) => p && Number.isSafeInteger(p.id) && p.id >= 0 && typeof p.is_plugin === "boolean")) throw new Error("Invalid pane list");
    panes = found as PaneGeometry[];
  } catch { throw new Error("Cannot inspect Zellij layout; worker creation was not attempted."); }
  const owner = panes.find(p => !p.is_plugin && p.id === Number(parent));
  if (!owner || !Number.isSafeInteger(owner.tab_id) || owner.tab_id! < 0 || owner.is_floating || owner.is_suppressed || owner.is_selectable === false ||
      panes.some(p => p.tab_id === owner.tab_id && !p.is_plugin && !measurePane(p))) {
    throw new Error("Cannot verify parent pane and tab geometry; worker creation was not attempted.");
  }
  const placement = selectPlacement(panes, Number(parent));
  if (!placement && !noFocus) throw new Error("Zellij 0.45+ is required to create an unfocused worker tab when pane space runs out.");
  const marker = `pi-lark-create-${randomBytes(16).toString("hex")}`;
  let reply = "";
  const tab = !placement;
  try {
    reply = execFileSync("zellij", tab
      ? ["action", "new-tab", "--no-focus", "--name", marker, "--cwd", "/", "--layout-string", "layout { pane; }", "--", ...command]
      : ["action", "new-pane", noFocus ? "--no-focus" : "--near-current-pane",
        "--direction", placement.direction, "--name", marker, "--cwd", "/", "--", ...command],
      { ...options, env: { ...process.env, ZELLIJ_PANE_ID: String(placement?.paneId ?? parent) } }).trim();
  } catch { /* CLI failure can still mean creation succeeded; never retry the mutation. */ }
  let pane = tab ? "" : /^terminal_\d+$/.test(reply) ? reply : "";
  let tabId: number | undefined;
  if (tab || !pane) {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline && !pane) {
      try {
        const found: unknown = JSON.parse(execFileSync("zellij", ["action", "list-panes", "--json", "--all"], options));
        if (!Array.isArray(found)) throw new Error("Invalid pane list");
        if (tab) {
          const id = /^\d+$/.test(reply) && Number.isSafeInteger(Number(reply)) ? Number(reply) : undefined;
          const matches = found.filter(p => p && !p.is_plugin && Number.isSafeInteger(p.id) && p.id >= 0 &&
            Number.isSafeInteger(p.tab_id) && p.tab_id >= 0 && p.tab_name === marker && (id === undefined || p.tab_id === id));
          if (matches.length === 1 && found.filter(p => p && !p.is_plugin && p.tab_id === matches[0].tab_id).length === 1) {
            pane = `terminal_${matches[0].id}`; tabId = matches[0].tab_id;
          }
        } else {
          const matches = found.filter(p => p && !p.is_plugin && p.title === marker && Number.isSafeInteger(p.id) && p.id >= 0);
          if (matches.length === 1) pane = `terminal_${matches[0].id}`;
        }
      } catch { /* An unconfirmed creation is not safe to repeat. */ }
      if (!pane && performance.now() < deadline) await sleep(Math.min(50, deadline - performance.now()));
    }
  }
  if (!/^terminal_\d+$/.test(pane)) throw new Error(`Could not confirm Zellij ${tab ? "tab" : "pane"} creation (${marker}); not retried to avoid duplicate workers.`);
  try {
    if (tab) execFileSync("zellij", ["action", "rename-tab", "--tab-id", String(tabId), "--", name], options);
    execFileSync("zellij", ["action", "rename-pane", "--pane-id", pane, "--", name], options);
  } catch { /* An identified pane can still be owned/closed under its marker. */ }
  return pane;
}

const MAX_FRAME = 8 * 1024 * 1024;
export interface ZellijWorkersOptions {
  cwd: string;
  stateDir?: string;
  appId: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  startupTimeoutMs?: number;
  workerExtensionPath?: string;
  /** Explicit child environment overrides, useful for isolated tests. Not written to argv. */
  env?: NodeJS.ProcessEnv;
  /** Serve a worker-initiated request. The key is the worker's own conversation key. */
  onRequest?: (key: string, request: WorkerRequest) => Promise<WorkerResponse>;
}

/** A worker may only ask for these; it never supplies a chat ID of its own. */
const MAX_REQUEST_TEXT = 64_000;
function parseRequest(message: any): WorkerRequest | undefined {
  if (message.action === "push") {
    return typeof message.text === "string" && message.text && Buffer.byteLength(message.text) <= MAX_REQUEST_TEXT
      ? { action: "push", text: message.text } : undefined;
  }
  return ["set-target", "clear-target", "target-status"].includes(message.action)
    ? { action: message.action } as WorkerRequest : undefined;
}
export interface PaneSnapshot { userId: string; paneId?: string; sessionFile: string; connected: boolean }
function sessionKey(appId: string, userId: string): string {
  return createHash("sha256").update(`${appId}\0${userId}`).digest("hex");
}
function piCliPath(): string {
  const candidates = new Set<string>();
  // Pi extensions can be loaded through jiti, where import.meta.resolve is not
  // available. They can also live outside Pi's own node_modules tree, so retain
  // several ways of locating the exact CLI that launched this process.
  if (process.argv[1] && basename(process.argv[1]) === "cli.js") candidates.add(process.argv[1]);
  try {
    const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
    if (resolver) {
      const dist = dirname(fileURLToPath(resolver("@earendil-works/pi-coding-agent")));
      candidates.add(join(dist, "bundle", "cli.js"));
      candidates.add(join(dist, "cli.js"));
    }
  } catch { /* pi's jiti host may not implement import.meta.resolve */ }
  const require = createRequire(import.meta.url);
  for (const directory of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
    const dist = join(directory, "@earendil-works", "pi-coding-agent", "dist");
    candidates.add(join(dist, "bundle", "cli.js"));
    candidates.add(join(dist, "cli.js"));
  }
  // A package-installed extension's resolver may see only its own dependencies.
  // PATH is inherited from the active Pi session, so its `pi` command is a final
  // reliable fallback without recording it in shell input or a remote prompt.
  try { candidates.add(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { /* a descriptive error is emitted below */ }
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      if (existsSync(path)) return path;
    } catch { /* try the next candidate */ }
  }
  throw new Error("Unable to locate the pi CLI bundle");
}

class PaneWorker implements ConversationWorker {
  readonly sessionFile: string;
  private socket?: Socket;
  private server?: Server;
  private tempDir?: string;
  private paneId?: string;
  private readonly peers = new Set<Socket>();
  private readonly abort = new AbortController();
  private closed = false;
  private ready = false;
  private startTask?: Promise<void>;
  private resources?: Promise<void>;
  private closing?: Promise<void>;
  private rejectReady?: (error: Error) => void;
  private onEvent?: (event: WorkerEvent) => void;
  private readonly deliveries = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  constructor(private options: ZellijWorkersOptions, private userId: string) {
    this.sessionFile = resolve(options.stateDir ?? join(options.cwd, ".pi", "lark-bot"), "sessions", `${sessionKey(options.appId, userId)}.jsonl`);
  }
  snapshot(): PaneSnapshot { return { userId: this.userId, paneId: this.paneId, sessionFile: this.sessionFile, connected: this.isConnected() }; }
  isConnected(): boolean { return !this.closed && this.ready && !!this.socket && !this.socket.destroyed; }

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.closed) return Promise.reject(new Error("Pi worker is closed"));
    const runId = randomBytes(16).toString("hex"), token = randomBytes(32).toString("hex");
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
    // Start the deadline before any filesystem, Zellij, or pi startup operation.
    const timer = setTimeout(() => {
      this.rejectReady?.(new Error("Timed out waiting for pi worker startup"));
      void this.close();
    }, this.options.startupTimeoutMs ?? 30_000);
    this.resources = this.prepareAndLaunch(runId, token, resolveReady);
    this.startTask = Promise.all([this.resources, ready]).then(() => {
      if (this.closed) throw new Error("Pi worker closed during startup");
    }).catch(async (error) => { await this.close(); throw error; }).finally(() => {
      clearTimeout(timer); this.rejectReady = undefined;
    });
    return this.startTask;
  }

  private checkOpen(): void { if (this.closed) throw new Error("Pi worker is closed"); }
  private async prepareAndLaunch(runId: string, token: string, resolveReady: () => void): Promise<void> {
    try { if (!(await stat(this.options.cwd)).isDirectory()) throw new Error(); }
    catch { throw new Error("Pi worker project directory is unavailable"); }
    await privateDir(dirname(this.sessionFile)); this.checkOpen();
    this.tempDir = await mkdtemp(join(tmpdir(), "pi-lark-bot-")); this.checkOpen();
    const socketPath = join(this.tempDir, "controller.sock");
    this.server = createServer((socket) => this.accept(socket, runId, token, resolveReady));
    // Keep an error listener after listen too: server errors must not crash the controller.
    this.server.on("error", () => {
      this.rejectReady?.(new Error("Pi worker IPC server failed"));
      this.failActive(new Error("Pi worker IPC server failed"));
      void this.close();
    });
    await new Promise<void>((accept, reject) => {
      const abort = () => { cleanup(); reject(new Error("Pi worker startup cancelled")); };
      const error = () => { cleanup(); reject(new Error("Pi worker IPC listen failed")); };
      const cleanup = () => { this.abort.signal.removeEventListener("abort", abort); this.server?.removeListener("error", error); };
      this.abort.signal.addEventListener("abort", abort, { once: true });
      this.server!.once("error", error);
      this.server!.listen(socketPath, () => { cleanup(); accept(); });
      if (this.abort.signal.aborted) abort();
    });
    this.checkOpen();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_LARK_BOT_") || ["PI_SESSION_ID", "PI_SESSION_FILE"].includes(key)) delete childEnv[key];
    }
    Object.assign(childEnv, { PI_LARK_BOT_WORKER: "1", PI_LARK_BOT_SOCKET: socketPath, PI_LARK_BOT_RUN_ID: runId, PI_LARK_BOT_TOKEN: token });
    // A group session represents a chat, not one member. Pass its chat ID so
    // every model turn can identify the shared conversation after compaction.
    if (this.userId.startsWith("group:")) {
      childEnv.PI_LARK_BOT_GROUP_CHAT = "1";
      childEnv.PI_LARK_BOT_GROUP_CHAT_ID = this.userId.slice("group:".length);
    } else childEnv.PI_LARK_BOT_DIRECT_USER_ID = this.userId;
    const extension = this.options.workerExtensionPath ?? fileURLToPath(new URL("./worker-extension.ts", import.meta.url));
    const args = ["--session", this.sessionFile, "-e", extension];
    if (this.options.model) args.push("--model", `${this.options.model.provider}/${this.options.model.id}`);
    if (this.options.thinkingLevel) args.push("--thinking", this.options.thinkingLevel);
    const launchFile = join(this.tempDir, "launch.json");
    await writePrivateJson(launchFile, { cli: piCliPath(), args, cwd: this.options.cwd, env: childEnv });
    this.checkOpen();
    // Pass the actual parent environment privately, preserving the new pane's
    // own Zellij identity in the launcher. Remote messages only use IPC.
    const launcher = fileURLToPath(new URL("./launch-worker.cjs", import.meta.url));
    this.paneId = await createWorkerSurface(`lark-${sessionKey(this.options.appId, this.userId).slice(0, 10)}`,
      [process.execPath, launcher, launchFile]);
    this.checkOpen();
  }

  private accept(socket: Socket, runId: string, token: string, resolveReady: () => void): void {
    this.peers.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => { clearTimeout(timer); this.peers.delete(socket); });
    socket.on("error", () => {});
    if (this.closed || this.socket) { socket.destroy(); return; }
    socket.setEncoding("utf8");
    let authenticated = false, buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object") { socket.destroy(); return; }
        if (!authenticated) {
          if (this.socket || message.type !== "hello" || message.runId !== runId || message.token !== token) { socket.destroy(); return; }
          authenticated = true; clearTimeout(timer); this.socket = socket;
          socket.once("close", () => {
            this.socket = undefined; this.ready = false;
            this.rejectReady?.(new Error("Pi worker disconnected before startup completed"));
            this.failActive(new Error("Pi worker exited or lost its controller connection"));
            void this.close();
          });
          continue;
        }
        if (message.type === "ready") { this.ready = true; resolveReady(); }
        else this.handle(message);
      }
    });
  }

  async run(text: string, onEvent: (event: WorkerEvent) => void, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.onEvent = onEvent;
    await this.deliver({ type: "prompt", text });
  }
  interrupt(): Promise<void> { return this.deliver({ type: "abort" }); }
  private async deliver(payload: object): Promise<void> {
    if (!this.isConnected()) throw new Error("Pi worker is not connected");
    const id = randomBytes(12).toString("hex");
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.deliveries.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error("Pi worker handoff timed out; delivery is uncertain, not retried")), 10_000);
        this.socket!.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
          if (error) reject(new Error("Pi worker handoff failed; delivery is uncertain, not retried"));
        });
      });
    } finally { clearTimeout(timer); this.deliveries.delete(id); }
  }
  private handle(message: any): void {
    if (message.type === "request") { void this.respond(message); return; }
    if (message.type === "accepted" || message.type === "rejected") {
      const pending = this.deliveries.get(message.id);
      if (message.type === "accepted") pending?.resolve();
      else pending?.reject(new Error("Pi worker could not hand off the message; not retried"));
      return;
    }
    // Output belongs to this authenticated conversation, never an input ID.
    if (message.id !== undefined || typeof message.text !== "string" || !["progress", "text", "done"].includes(message.type)) return;
    const event: WorkerEvent = message.type === "done"
      ? { type: "done", text: message.text, error: message.error === true }
      : { type: message.type, text: message.text };
    try { this.onEvent?.(event); } catch { /* output failure cannot block input delivery */ }
  }
  /** Requests run outside the prompt lifecycle: a worker may push long after its turn ended. */
  private async respond(message: any): Promise<void> {
    if (typeof message.id !== "string" || !message.id) return;
    let response: WorkerResponse = { ok: false, text: "控制端不支持该请求。" };
    try {
      const request = parseRequest(message);
      if (request && this.options.onRequest) response = await this.options.onRequest(this.userId, request);
    } catch { response = { ok: false, text: "控制端处理请求失败。" }; }
    const socket = this.socket;
    if (socket && !socket.destroyed && !socket.writableEnded) {
      socket.write(`${JSON.stringify({ type: "response", id: message.id, ...response })}\n`, () => {});
    }
  }

  private failActive(error: Error): void {
    for (const pending of this.deliveries.values()) pending.reject(error);
    this.deliveries.clear();
    // A lost connection can occur long after handoff. Report it on the chat
    // channel, rather than leaving the last progress card looking busy forever.
    const sink = this.onEvent; this.onEvent = undefined;
    try { sink?.({ type: "done", text: "❌ Pi 会话连接已断开，未自动重发消息。下次消息会重新打开会话。", error: true }); } catch {}
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.ready = false; this.onEvent = undefined;
    this.rejectReady?.(new Error("Pi worker closed")); this.abort.abort();
    this.failActive(new Error("Pi worker closed"));
    for (const peer of this.peers) peer.destroy();
    this.closing = (async () => {
      // resources never waits for the hello/ready promise, so this cannot deadlock
      // with start()'s failure cleanup. It also captures a late spawn's pane ID.
      await this.resources?.catch(() => {});
      for (const peer of this.peers) peer.destroy();
      if (this.server) await new Promise<void>((done) => { this.server!.close(() => done()); });
      if (this.paneId) {
        try { closeSurface(this.paneId); }
        catch { /* An already-closed pane needs no cleanup. IPC loss also stops pi. */ }
      }
      if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true });
    })();
    return this.closing;
  }
}

export class ZellijWorkers implements WorkerFactory {
  private entries = new Map<string, { worker: PaneWorker; promise: Promise<PaneWorker>; started: boolean }>();
  private readonly models = new Map<string, ModelSpec>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private options: ZellijWorkersOptions) {
    if (!options.cwd || !options.appId) throw new Error("ZellijWorkers requires cwd and appId");
  }
  list(): PaneSnapshot[] { return [...this.entries.values()].filter((entry) => !entry.started || entry.worker.isConnected()).map((entry) => entry.worker.snapshot()); }
  open(userId: string): Promise<ConversationWorker> {
    if (this.closed) return Promise.reject(new Error("ZellijWorkers is closed"));
    const old = this.entries.get(userId);
    if (old && (old.worker.isConnected() || !old.started)) return old.promise;
    const worker = new PaneWorker({ ...this.options, model: this.models.get(userId) ?? this.options.model }, userId);
    const entry = { worker, promise: undefined as unknown as Promise<PaneWorker>, started: false };
    entry.promise = Promise.resolve().then(async () => {
      await old?.worker.close();
      if (this.closed) throw new Error("ZellijWorkers is closed");
      await worker.start();
      entry.started = true;
      if (this.closed) { await worker.close(); throw new Error("ZellijWorkers is closed"); }
      return worker;
    }).catch(async (error) => {
      await worker.close();
      if (this.entries.get(userId) === entry) this.entries.delete(userId);
      throw error;
    });
    this.entries.set(userId, entry);
    return entry.promise;
  }
  async reset(userId: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (entry) {
      await entry.worker.close();
      await entry.promise.catch(() => {});
      if (this.entries.get(userId) === entry) this.entries.delete(userId);
    }
    const sessionFile = new PaneWorker({ ...this.options, model: this.models.get(userId) ?? this.options.model }, userId).sessionFile;
    await rm(sessionFile, { force: true });
    this.models.delete(userId);
  }
  async setModel(userId: string, model: ModelSpec): Promise<void> {
    if (this.closed) throw new Error("ZellijWorkers is closed");
    this.models.set(userId, model);
    const entry = this.entries.get(userId);
    if (entry) {
      await entry.worker.close();
      await entry.promise.catch(() => {});
      if (this.entries.get(userId) === entry) this.entries.delete(userId);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.closing = (async () => {
      await Promise.allSettled(entries.map((entry) => entry.worker.close()));
      await Promise.allSettled(entries.map((entry) => entry.promise));
      this.entries.clear();
    })();
    return this.closing;
  }
}
export const __panesTest__ = { sessionKey, piCliPath };
