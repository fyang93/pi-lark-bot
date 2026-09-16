import { join } from "node:path";
import { isMissing, readPrivateJson, writePrivateJson } from "./storage.ts";
import { conversationKey, type BotConfig, type BotTransport, type IncomingMessage, type WorkerFactory, type WorkerEvent } from "./types.ts";

/** Conservative UTF-8 payload bound, including room for card JSON overhead. */
export function splitText(text: string, maxBytes = 12_000): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must be at least 4");
  const parts: string[] = [];
  let part = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { parts.push(part); part = ""; bytes = 0; }
    part += char; bytes += size;
  }
  if (part) parts.push(part);
  return parts.length ? parts : ["(No text response)"];
}

/** One in-flight edit and one coalesced pending snapshot, never an unbounded token queue. */
export class ProgressMessage {
  private latest = "⏳ Preparing session…";
  private sent = "";
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private ended = false;
  private editing = false;
  constructor(private transport: BotTransport, private id: string, private interval = 1000,
    private onError: (error: unknown) => void = () => {}) {}
  set(text: string): void {
    if (this.ended) return;
    this.latest = splitText(text)[0]!;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueue();
    }, this.interval);
  }
  private enqueue(): void {
    if (this.editing) return;
    this.editing = true;
    this.pending = (async () => {
      const text = this.latest;
      if (text === this.sent) return;
      try { await this.transport.update(this.id, text); this.sent = text; }
      catch (error) { this.onError(error); }
    })().finally(() => {
      this.editing = false;
      if (!this.ended && this.latest !== this.sent && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; this.enqueue(); }, this.interval);
      }
    });
  }
  async finish(text: string): Promise<void> {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = text;
    await this.pending;
    this.enqueue();
    await this.pending;
  }
}

interface UserQueue { tail: Promise<void>; count: number }
export interface ControllerOptions {
  config: BotConfig;
  stateDir: string;
  transport: BotTransport;
  workers: WorkerFactory;
  onError?: (error: unknown) => void;
  onStatus?: () => void;
  streamInterval?: number;
}

export class BotController {
  private active = false;
  private stopping?: Promise<void>;
  private users = new Map<string, UserQueue>();
  private seen = new Set<string>();
  private admission: Promise<void> = Promise.resolve();
  private readonly onError: (error: unknown) => void;
  constructor(private options: ControllerOptions) { this.onError = options.onError ?? (() => {}); }
  get status() { return { active: this.active, connection: this.options.transport.state ?? (this.active ? "connected" : "stopped"), users: this.users.size,
    sessions: this.options.workers.list?.() ?? [],
    queued: [...this.users.values()].reduce((n, u) => n + u.count, 0) }; }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.stopping) throw new Error("Controller is stopping.");
    try {
      const stored = await readPrivateJson(join(this.options.stateDir, "seen.json")) as { appId: string; ids: string[] };
      if (!stored || !Array.isArray(stored.ids) || stored.ids.some((x) => typeof x !== "string")) throw new Error("Invalid seen.json");
      if (stored.appId === this.options.config.appId) this.seen = new Set(stored.ids.slice(-10_000));
    } catch (error) { if (!isMissing(error)) throw error; }
    if (this.stopping) throw new Error("Controller was stopped during startup.");
    this.active = true;
    try {
      await this.options.transport.start((message) => this.receive(message));
      if (!this.active || this.stopping) {
        // A non-cancellable transport may have completed its handshake after stop.
        await this.options.transport.stop();
        throw new Error("Controller was stopped during connection startup.");
      }
    } catch (error) { await this.stop(); throw error; }
    this.options.onStatus?.();
  }

  /** Return promptly to acknowledge WebSocket delivery; jobs run outside the event handler. */
  receive(message: IncomingMessage): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (message.chatType !== undefined && message.chatType !== "p2p" && message.chatType !== "group") return Promise.resolve();
    if (message.chatType === "group" && !message.mentionedBot) return Promise.resolve();
    const admission = this.admission.then(async () => {
      if (!this.active || this.seen.has(message.id)) return;
      this.seen.add(message.id);
      while (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
      await writePrivateJson(join(this.options.stateDir, "seen.json"), {
        appId: this.options.config.appId, ids: [...this.seen],
      });
      if (!this.active) return;
      const key = conversationKey(message);
      let queue = this.users.get(key);
      if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; this.users.set(key, queue); }
      if (queue.count >= 20 || Buffer.byteLength(message.text) + (message.chatType === "group" ? Buffer.byteLength(message.userId) + 2 : 0) > 64_000) {
        void this.options.transport.send(message.chatId, "Message too long or queue full (maximum 20). Please retry later.", message.id).catch(this.onError);
        return;
      }
      const wasBusy = queue.count > 0;
      queue.count++;
      if (wasBusy) void this.options.transport.send(message.chatId, `Queued behind ${queue.count - 1} message(s).`, message.id).catch(this.onError);
      const current = queue;
      current.tail = current.tail.then(async () => {
        if (!this.active) return;
        await this.execute(message);
      }).catch(this.onError).finally(() => { current.count--; this.options.onStatus?.(); });
      this.options.onStatus?.();
    });
    this.admission = admission.catch(this.onError);
    // Do not make the SDK's event acknowledgement wait for disk or model work.
    return Promise.resolve();
  }

  private async execute(message: IncomingMessage): Promise<void> {
    const { transport, workers } = this.options;
    let progress: ProgressMessage | undefined;
    let answer = "", status = "⏳ Working…", final: Extract<WorkerEvent, { type: "done" }> | undefined;
    try {
      const id = await transport.send(message.chatId, "⏳ Preparing session…", message.id);
      progress = new ProgressMessage(transport, id, this.options.streamInterval, this.onError);
      if (!this.active) { await progress.finish("⏹ Stopped. Message was not executed."); return; }
      const worker = await workers.open(conversationKey(message));
      if (!this.active) { await progress.finish("⏹ Stopped. Message was not executed."); return; }
      const prompt = message.chatType === "group" ? `${message.userId}: ${message.text}` : message.text;
      await worker.run(prompt, (event) => {
        if (event.type === "done") { final = event; return; }
        if (event.type === "text") answer = event.text;
        else status = event.text;
        progress?.set(`${status}\n\n${answer}`);
      });
      const cancelled = async () => {
        if (this.active) return false;
        await progress!.finish("⏹ Stopped. Execution interrupted; local history preserved.");
        return true;
      };
      if (await cancelled()) return;
      const result = final as Extract<WorkerEvent, { type: "done" }> | undefined;
      if (!result) throw new Error("Worker ended without a final result.");
      await progress.finish(result.error ? "❌ Failed. See the response below." : "✅ Completed");
      for (const part of splitText(result.text || (result.error ? "Execution failed. Check the session pane." : "(No text response)"))) {
        if (await cancelled()) return;
        await transport.send(message.chatId, part, message.id);
      }
    } catch (error) {
      this.onError(error);
      await progress?.finish(this.active ? "❌ Execution or reply failed; history preserved locally." : "⏹ Stopped. Execution interrupted.");
      try { await transport.send(message.chatId, this.active
        ? "Execution or reply failed. Check pi and the session pane. Send another message to continue the saved conversation."
        : "Bot stopped and execution interrupted. Restart to continue the saved conversation.", message.id); }
      catch (sendError) { this.onError(sendError); }
    }
  }

  /** Used by tests and shutdown; includes asynchronous admission and all queued jobs. */
  async drain(): Promise<void> {
    await this.admission;
    await Promise.all([...this.users.values()].map((user) => user.tail));
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.stopping = (async () => {
      // Stop inbound WS first. REST remains usable for final interruption notifications.
      await this.options.transport.stop().catch(this.onError);
      await this.admission;
      await this.options.workers.close().catch(this.onError);
      await this.drain();
      this.options.onStatus?.();
    })();
    return this.stopping;
  }
}
