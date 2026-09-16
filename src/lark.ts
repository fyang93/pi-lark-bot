import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { BotConfig, BotTransport, IncomingMessage } from "./types.js";

/** The SDK surface used here; exported so integration tests can supply a real-shaped fake. */
export interface LarkSdk {
  Client: new (options: Record<string, unknown>) => any;
  EventDispatcher: new (options?: Record<string, unknown>) => {
    register(handles: Record<string, (event: unknown) => Promise<void> | void>): unknown;
  };
  WSClient: new (options: Record<string, unknown>) => {
    start(options: { eventDispatcher: unknown }): Promise<void>;
    close(options?: { force?: boolean }): void;
  };
  defaultHttpInstance?: { request(options: Record<string, unknown>): Promise<unknown> };
  Domain?: { Feishu: unknown; Lark: unknown };
}

export type LarkTransportState = "stopped" | "starting" | "connected" | "reconnecting";

const API_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set([90002, 90013, 99991400, 99991663]);
const silentLogger = Object.freeze({
  fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
});

type PendingStart = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Tenant-bot Lark/Feishu transport using the SDK's persistent WebSocket. */
export class LarkTransport implements BotTransport {
  private readonly client: any;
  private readonly dispatcher: InstanceType<LarkSdk["EventDispatcher"]>;
  private readonly ws: InstanceType<LarkSdk["WSClient"]>;
  private onMessage?: (message: IncomingMessage) => Promise<void>;
  private pendingStart?: PendingStart;
  private _state: LarkTransportState = "stopped";
  private botOpenId?: string;

  constructor(
    config: BotConfig,
    private readonly onError: (error: Error) => void = () => {},
    sdk: LarkSdk = Lark as unknown as LarkSdk,
  ) {
    if (!config.appId || !config.appSecret) throw new Error("Lark app credentials are required");
    const domain = config.brand === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu;
    // Generated endpoint methods' second parameter is IRequestOptions, not an
    // Axios config, so a timeout there is ignored. This wrapper bounds normal
    // API calls, tenant-token exchange, and WS endpoint discovery for real SDKs.
    const httpInstance = boundedHttp(sdk.defaultHttpInstance);
    const common = { appId: config.appId, appSecret: config.appSecret, domain, httpInstance, logger: silentLogger, loggerLevel: 0 };
    this.client = new sdk.Client(common);
    this.dispatcher = new sdk.EventDispatcher({ logger: silentLogger, loggerLevel: 0 });
    this.dispatcher.register({ "im.message.receive_v1": (event) => this.receive(event) });
    this.ws = new sdk.WSClient({
      ...common,
      handshakeTimeoutMs: API_TIMEOUT_MS,
      onReady: () => this.ready(),
      onReconnecting: () => { if (this._state === "connected") this._state = "reconnecting"; },
      onReconnected: () => {
        if (this._state === "starting") this.ready();
        else if (this._state !== "stopped") this._state = "connected";
      },
      onError: () => this.connectionFailed(),
    });
  }

  get state(): LarkTransportState { return this._state; }

  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this._state !== "stopped") return Promise.reject(new Error("Lark transport is already started"));
    this.onMessage = onMessage;
    this._state = "starting";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failStart("Lark connection timed out"), START_TIMEOUT_MS);
      this.pendingStart = { resolve, reject, timer };
    });
    try {
      // Do not await WSClient.start: it can itself hang while endpoint discovery
      // is in flight. `ready` remains bounded by START_TIMEOUT_MS instead.
      void (async () => {
        const info = await this.request(() => this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" }));
        if (typeof info?.bot?.open_id !== "string" || !info.bot.open_id) throw new Error("Missing bot identity");
        this.botOpenId = info.bot.open_id;
        if (this._state === "starting") await this.ws.start({ eventDispatcher: this.dispatcher });
      })().catch(() => this.failStart("Lark connection could not be started"));
    } catch (_error) {
      this.failStart("Lark connection could not be started");
    }
    return ready;
  }

  async stop(): Promise<void> {
    if (this._state === "starting") {
      this.failStart("Lark connection was stopped"); // also force-closes exactly once
      return;
    }
    this._state = "stopped"; // ignores late SDK callbacks and prevents reconnect resurrection
    this.onMessage = undefined;
    this.close();
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<string> {
    // Lark uses uuid for idempotency. Keep it stable across retries of this one send.
    const data = { msg_type: "interactive", content: JSON.stringify(card(text)), uuid: randomUUID() };
    const response = replyTo
      ? await this.request(() => this.client.im.v1.message.reply({ data, path: { message_id: replyTo } }))
      : await this.request(() => this.client.im.v1.message.create({
        data: { ...data, receive_id: chatId }, params: { receive_id_type: "chat_id" },
      }));
    const messageId = response?.data?.message_id;
    if (typeof messageId !== "string" || !messageId) throw this.failure();
    return messageId;
  }

  async update(messageId: string, text: string): Promise<void> {
    await this.request(() => this.client.im.v1.message.patch({
      path: { message_id: messageId }, data: { content: JSON.stringify(card(text)) },
    }));
  }

  private ready(): void {
    if (this._state !== "starting") return;
    this._state = "connected";
    this.settleStart();
  }

  private connectionFailed(): void {
    if (this._state === "stopped") return;
    if (this._state === "starting") this.failStart("Lark connection failed");
    else {
      this._state = "stopped";
      this.close();
      this.report("Lark connection failed");
    }
  }

  private failStart(message: string): void {
    if (this._state !== "starting") return;
    this._state = "stopped";
    this.onMessage = undefined;
    const pending = this.pendingStart;
    this.pendingStart = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.close();
    this.report(message);
  }

  private settleStart(): void {
    const pending = this.pendingStart;
    this.pendingStart = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
  }

  private close(): void {
    try { this.ws.close({ force: true }); }
    catch (_error) { this.report("Lark connection could not be stopped"); }
  }

  private async receive(value: unknown): Promise<void> {
    const event = value as any;
    const message = event?.message;
    if (
      event?.sender?.sender_type !== "user" || !["p2p", "group"].includes(message?.chat_type) ||
      message?.message_type !== "text" || typeof message?.message_id !== "string" ||
      typeof message?.chat_id !== "string"
    ) return;
    const userId = event.sender.sender_id?.open_id;
    if (typeof userId !== "string" || !userId) return;
    let content: unknown;
    try { content = JSON.parse(message.content); } catch { return; }
    if (!content || typeof (content as { text?: unknown }).text !== "string") return;
    let text = (content as { text: string }).text;
    const group = message.chat_type === "group";
    if (group) {
      if (!this.botOpenId || !Array.isArray(message.mentions)) return;
      const mentions = message.mentions.filter((mention: any) => mention?.id?.open_id === this.botOpenId &&
        typeof mention.key === "string" && mention.key.length > 0 && text.includes(mention.key));
      if (!mentions.length) return; // @all or mentioning somebody else is not a bot command
      for (const mention of mentions) text = text.split(mention.key).join("");
      text = text.trim();
    }
    if (!text.trim() || !this.onMessage || this._state !== "connected") return;
    try { await this.onMessage({ id: message.message_id, userId, chatId: message.chat_id, text,
      ...(group ? { chatType: "group" as const, mentionedBot: true } : {}) }); }
    catch (_error) { this.report("Lark message handler failed"); }
  }

  private async request(operation: () => Promise<any>): Promise<any> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response: any;
      try { response = await operation(); }
      catch (_error) {
        if (attempt === MAX_ATTEMPTS - 1) throw this.failure();
        await delay(attempt);
        continue;
      }
      if (response?.code === 0) return response;
      // Generated SDK methods may swallow an HTTP exception and return undefined.
      // Treat that as a transport failure rather than a non-retryable business code.
      if ((response != null && !RETRYABLE_CODES.has(response.code)) || attempt === MAX_ATTEMPTS - 1) throw this.failure();
      await delay(attempt);
    }
    throw this.failure();
  }

  private failure(): Error {
    this.report("Lark API request failed");
    return new Error("Lark API request failed");
  }

  private report(message: string): void {
    // Never expose SDK errors: they may include request details or credentials.
    try { this.onError(new Error(message)); } catch { /* reporting must not break transport */ }
  }
}

function boundedHttp(http: LarkSdk["defaultHttpInstance"]): LarkSdk["defaultHttpInstance"] | undefined {
  if (!http) return undefined; // enables minimal SDK test doubles
  const options = (value: Record<string, unknown> = {}) => ({
    ...value, timeout: Math.min(Number(value.timeout) || API_TIMEOUT_MS, API_TIMEOUT_MS),
  });
  // Tenant token exchange calls HttpInstance.post(), whereas generated OpenAPI
  // methods call request(). Proxy both forms without changing SDK internals.
  return new Proxy(http, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function") return method;
      if (key === "request") return (value: Record<string, unknown>) => method.call(target, options(value));
      if (key === "get" || key === "delete" || key === "head" || key === "options") {
        return (url: string, value?: Record<string, unknown>) => method.call(target, url, options(value));
      }
      if (key === "post" || key === "put" || key === "patch") {
        return (url: string, data?: unknown, value?: Record<string, unknown>) => method.call(target, url, data, options(value));
      }
      return method.bind(target);
    },
  }) as LarkSdk["defaultHttpInstance"];
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
}

function card(text: string): object {
  return { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] };
}
