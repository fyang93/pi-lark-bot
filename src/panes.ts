import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { privateDir, writePrivateJson } from "./storage.ts";
import type { ConversationWorker, ModelSpec, WorkerEvent, WorkerFactory } from "./types.ts";

import { createSurface, closeSurface } from "./tmux.ts";
const execFile = promisify(execFileCallback);
const MAX_FRAME = 8 * 1024 * 1024;
export interface TmuxWorkersOptions {
  cwd: string;
  stateDir?: string;
  appId: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  startupTimeoutMs?: number;
  workerExtensionPath?: string;
  /** Explicit child environment overrides, useful for isolated tests. Not written to argv. */
  env?: NodeJS.ProcessEnv;
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
  private serial: Promise<void> = Promise.resolve();
  private active?: { id: string; onEvent: (event: WorkerEvent) => void; resolve: () => void; reject: (error: Error) => void };
  /** Keep the callback after a turn settles: extensions may trigger a later continuation in this same Pi session. */
  private readonly continuations = new Map<string, (event: WorkerEvent) => void>();
  constructor(private options: TmuxWorkersOptions, private userId: string) {
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
    // Start the deadline before any filesystem, tmux, or pi startup operation.
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
    // tmux's server environment can be stale. Pass the actual parent environment
    // privately, preserving the new pane's own TMUX_PANE in the launcher.
    const launcher = fileURLToPath(new URL("./launch-worker.cjs", import.meta.url));
    this.paneId = createSurface(`lark-${sessionKey(this.options.appId, this.userId).slice(0, 10)}`);
    this.checkOpen();
    // Reuse the copied pane primitives, but start pi directly instead of typing
    // commands into a potentially unready shell. Remote messages only use IPC.
    await execFile("tmux", ["respawn-pane", "-k", "-t", this.paneId, "-c", "/", "--",
      process.execPath, launcher, launchFile], { timeout: 10_000, signal: this.abort.signal });
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

  run(text: string, onEvent: (event: WorkerEvent) => void): Promise<void> {
    const result = this.serial.then(() => {
      if (!this.isConnected()) throw new Error("Pi worker is not connected");
      return new Promise<void>((resolve, reject) => {
        const id = randomBytes(12).toString("hex");
        this.active = { id, onEvent, resolve, reject };
        this.socket!.write(`${JSON.stringify({ type: "prompt", id, text })}\n`, (error) => { if (error) this.failActive(new Error("Pi worker prompt delivery failed")); });
      });
    });
    this.serial = result.catch(() => {});
    return result;
  }
  private handle(message: any): void {
    if (typeof message.text !== "string" || !["progress", "text", "done"].includes(message.type)) return;
    const event: WorkerEvent = message.type === "done"
      ? { type: "done", text: message.text, error: message.error === true }
      : { type: message.type, text: message.text };
    const active = this.active;
    if (!active || message.id !== active.id) {
      const continuation = typeof message.id === "string" ? this.continuations.get(message.id) : undefined;
      if (continuation) try { continuation(event); } catch { /* a late continuation must not kill the worker */ }
      return;
    }
    try { active.onEvent(event); }
    catch { this.failActive(new Error("Pi worker event handler failed")); return; }
    if (event.type === "done") {
      this.active = undefined;
      this.continuations.set(active.id, active.onEvent);
      active.resolve();
    }
  }
  private failActive(error: Error): void { const active = this.active; this.active = undefined; active?.reject(error); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.ready = false; this.continuations.clear();
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

export class TmuxWorkers implements WorkerFactory {
  private entries = new Map<string, { worker: PaneWorker; promise: Promise<PaneWorker>; started: boolean }>();
  private readonly models = new Map<string, ModelSpec>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private options: TmuxWorkersOptions) {
    if (!options.cwd || !options.appId) throw new Error("TmuxWorkers requires cwd and appId");
  }
  list(): PaneSnapshot[] { return [...this.entries.values()].map((entry) => entry.worker.snapshot()); }
  open(userId: string): Promise<ConversationWorker> {
    if (this.closed) return Promise.reject(new Error("TmuxWorkers is closed"));
    const old = this.entries.get(userId);
    if (old && (old.worker.isConnected() || !old.started)) return old.promise;
    const worker = new PaneWorker({ ...this.options, model: this.models.get(userId) ?? this.options.model }, userId);
    const entry = { worker, promise: undefined as unknown as Promise<PaneWorker>, started: false };
    entry.promise = Promise.resolve().then(async () => {
      await old?.worker.close();
      if (this.closed) throw new Error("TmuxWorkers is closed");
      await worker.start();
      entry.started = true;
      if (this.closed) { await worker.close(); throw new Error("TmuxWorkers is closed"); }
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
    if (this.closed) throw new Error("TmuxWorkers is closed");
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
