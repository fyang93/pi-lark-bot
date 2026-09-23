import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { BotConfig, BotTransport, IncomingMessage } from "./types.js";
import { AttachmentCache, MAX_ATTACHMENT_BYTES } from "./attachment-cache.js";

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
/** The event trace is always on, so it rewrites itself rather than growing without end. */
const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
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
  private onCardAction?: (messageId: string, chatId: string, operatorId: string | undefined, value: unknown) => Promise<void>;
  private pendingStart?: PendingStart;
  private _state: LarkTransportState = "stopped";
  private botOpenId?: string;
  private readonly attachmentCache?: AttachmentCache;
  private readonly eventLogPath?: string;
  private eventLogBytes = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly onError: (error: Error) => void = () => {},
    sdk: LarkSdk = Lark as unknown as LarkSdk,
    attachmentCacheDir?: string,
    /** Opt-in metadata log for diagnosing dropped events. Never records message text. */
    eventLogPath?: string,
  ) {
    if (!config.appId || !config.appSecret) throw new Error("Lark app credentials are required");
    const domain = config.brand === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu;
    // Generated endpoint methods' second parameter is IRequestOptions, not an
    // Axios config, so a timeout there is ignored. This wrapper bounds normal
    // API calls, tenant-token exchange, and WS endpoint discovery for real SDKs.
    const httpInstance = boundedHttp(sdk.defaultHttpInstance);
    const common = { appId: config.appId, appSecret: config.appSecret, domain, httpInstance, logger: silentLogger, loggerLevel: 0 };
    this.client = new sdk.Client(common);
    this.attachmentCache = attachmentCacheDir ? new AttachmentCache(attachmentCacheDir) : undefined;
    this.eventLogPath = eventLogPath;
    this.dispatcher = new sdk.EventDispatcher({ logger: silentLogger, loggerLevel: 0 });
    this.dispatcher.register({ "im.message.receive_v1": (event) => this.receive(event), "card.action.trigger": (event) => this.cardAction(event) });
    this.ws = new sdk.WSClient({
      ...common,
      handshakeTimeoutMs: API_TIMEOUT_MS,
      onReady: () => { this.trace("ws_ready"); this.ready(); },
      onReconnecting: () => {
        this.trace("ws_reconnecting");
        if (this._state === "connected") this._state = "reconnecting";
      },
      onReconnected: () => {
        this.trace("ws_reconnected");
        if (this._state === "starting") this.ready();
        else if (this._state !== "stopped") this._state = "connected";
      },
      onError: () => { this.trace("ws_error"); this.connectionFailed(); },
    });
  }

  /**
   * Append one line of event metadata. Message text, sender names and file keys
   * are never written: this exists to explain why an event was or was not
   * handled, not to mirror the conversation.
   */
  private trace(disposition: string, event?: any): void {
    if (!this.eventLogPath) return;
    const message = event?.message;
    const line = `${JSON.stringify({
      at: new Date().toISOString(), disposition, state: this._state,
      ...(event ? {
        senderType: event?.sender?.sender_type, chatType: message?.chat_type,
        messageType: message?.message_type, messageId: message?.message_id,
        mentions: Array.isArray(message?.mentions) ? message.mentions.length : undefined,
        hasParent: typeof message?.parent_id === "string" || undefined,
      } : {}),
    })}\n`;
    // Bounded: the trace must never be the reason a disk fills up.
    this.eventLogBytes += Buffer.byteLength(line);
    const path = this.eventLogPath;
    if (this.eventLogBytes > EVENT_LOG_MAX_BYTES) {
      this.eventLogBytes = Buffer.byteLength(line);
      writeFile(path, line, { mode: 0o600 }).catch(() => {});
      return;
    }
    appendFile(path, line, { mode: 0o600 }).catch(() => {});
  }

  get state(): LarkTransportState { return this._state; }

  setCardActionHandler(handler: (messageId: string, chatId: string, operatorId: string | undefined, value: unknown) => Promise<void>): void { this.onCardAction = handler; }

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

  async update(messageId: string, text: string): Promise<void> { await this.updateCard(messageId, card(text)); }

  /** Resolve directly quoted resources after authorization; one failed resource never drops the text request. */
  async prepareMessage(message: IncomingMessage): Promise<IncomingMessage> {
    if (!message.parentMessageId || !this.attachmentCache) return message;
    let item: any;
    try {
      const response = await this.request(() => this.client.im.v1.message.get({ path: { message_id: message.parentMessageId } }));
      item = response?.data?.items?.find((candidate: any) => candidate?.message_id === message.parentMessageId);
    } catch {
      return { ...message, preparationWarning: "referenced_message_unavailable" };
    }
    if (!item || item.chat_id !== message.chatId || typeof item.body?.content !== "string") return message;
    let content: unknown;
    try { content = JSON.parse(item.body.content); } catch { return message; }
    const candidates = referencedResources(item.msg_type, content);
    if (!candidates.length) return message;
    const attachments: NonNullable<IncomingMessage["attachments"]> = [];
    for (const candidate of candidates) {
      try {
        const cached = await this.attachmentCache.get(
          `${this.config.appId}\0${message.parentMessageId}\0${candidate.key}`,
          candidate.name,
          async () => {
            const resource = await this.downloadResource(message.parentMessageId!, candidate.key, candidate.apiType);
            const length = Number(resource.headers?.["content-length"] ?? resource.headers?.["Content-Length"]);
            if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) throw new Error("Referenced resource is larger than 100 MB");
            return resource.getReadableStream() as AsyncIterable<Uint8Array | string>;
          },
        );
        attachments.push({ status: "ready", type: candidate.type, ...cached, sourceMessageId: message.parentMessageId });
      } catch {
        attachments.push({ status: "failed", type: candidate.type, name: candidate.name,
          sourceMessageId: message.parentMessageId, error: "download_failed" });
      }
    }
    return { ...message, attachments };
  }

  async sendCard(chatId: string, value: object, replyTo?: string): Promise<string> {
    const data = { msg_type: "interactive", content: JSON.stringify(value), uuid: randomUUID() };
    const response = replyTo
      ? await this.request(() => this.client.im.v1.message.reply({ data, path: { message_id: replyTo } }))
      : await this.request(() => this.client.im.v1.message.create({ data: { ...data, receive_id: chatId }, params: { receive_id_type: "chat_id" } }));
    const messageId = response?.data?.message_id;
    if (typeof messageId !== "string" || !messageId) throw this.failure();
    return messageId;
  }

  async updateCard(messageId: string, value: object): Promise<void> {
    await this.request(() => this.client.im.v1.message.patch({
      path: { message_id: messageId }, data: { content: JSON.stringify(value) },
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

  private async cardAction(value: unknown): Promise<void> {
    const event = value as any;
    const messageId = event?.context?.open_message_id ?? event?.open_message_id ?? event?.message_id;
    const chatId = event?.context?.open_chat_id ?? event?.open_chat_id ?? event?.chat_id;
    const operatorId = event?.operator?.open_id;
    if (typeof messageId !== "string" || typeof chatId !== "string" || !this.onCardAction) return;
    try { await this.onCardAction(messageId, chatId, typeof operatorId === "string" ? operatorId : undefined, event?.action?.value); }
    catch { this.report("Lark card action handler failed"); }
  }

  private async receive(value: unknown): Promise<void> {
    const event = value as any;
    const message = event?.message;
    const drop = (reason: string): undefined => { this.trace(reason, event); return undefined; };
    if (event?.sender?.sender_type !== "user") return drop("skip_non_user_sender");
    if (!["p2p", "group"].includes(message?.chat_type)) return drop("skip_chat_type");
    if (typeof message?.message_id !== "string" || typeof message?.chat_id !== "string") return drop("skip_malformed_ids");
    const userId = event.sender.sender_id?.open_id;
    if (typeof userId !== "string" || !userId) return drop("skip_no_sender_open_id");
    const group = message.chat_type === "group";

    // Decide whether the message is addressed to this bot before judging its
    // content: an unsupported message in a group we merely sit in stays silent,
    // but one aimed at us must never disappear without an answer.
    let mentionKeys: string[] = [];
    if (group) {
      if (!this.botOpenId) {
        this.report("Lark bot identity is unknown, so group mentions cannot be matched");
        return drop("skip_bot_identity_unknown");
      }
      if (!Array.isArray(message.mentions)) return drop("skip_no_mentions");
      const mentions = message.mentions.filter((mention: any) => mention?.id?.open_id === this.botOpenId);
      if (!mentions.length) return drop("skip_bot_not_mentioned"); // @all or mentioning somebody else is not a bot command
      mentionKeys = mentions.map((mention: any) => mention.key).filter((key: any) => typeof key === "string" && key.length > 0);
    }

    // Addressed but unusable: hand it on anyway, carrying the reason. The
    // controller answers it after the allowlist check, so an unauthorized
    // sender still gets no more than the usual refusal.
    const deliver = (text: string, unsupported?: IncomingMessage["unsupported"]) => this.dispatch(message, userId, text, group, unsupported);
    if (message.message_type !== "text") return deliver(`(${message.message_type})`, "message_type");
    let content: unknown;
    try { content = JSON.parse(message.content); } catch { return deliver("(unparsable)", "content"); }
    if (!content || typeof (content as { text?: unknown }).text !== "string") return deliver("(no text)", "content");
    let text = (content as { text: string }).text;
    for (const key of mentionKeys) if (text.includes(key)) text = text.split(key).join("");
    text = text.trim();
    if (!text) return deliver("(empty)", "empty_text");
    return deliver(text);
  }

  private async dispatch(message: any, userId: string, text: string, group: boolean, unsupported?: IncomingMessage["unsupported"]): Promise<void> {
    if (this._state === "stopped") return void this.trace("skip_stopped", { message });
    if (!this.onMessage) return void this.trace("skip_no_handler", { message });
    this.trace(unsupported ? `accepted_${unsupported}` : "accepted", { message });
    try {
      await this.onMessage({ id: message.message_id, userId, chatId: message.chat_id, text,
        ...(unsupported ? { unsupported } : {}),
        ...(typeof message.parent_id === "string" && message.parent_id ? { parentMessageId: message.parent_id } : {}),
        ...(group ? { chatType: "group" as const, mentionedBot: true } : {}) });
    } catch (_error) { this.report("Lark message handler failed"); }
  }

  private async downloadResource(messageId: string, fileKey: string, type: "file" | "image"): Promise<any> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey }, params: { type },
        });
        if (response && typeof response.getReadableStream === "function") return response;
      } catch { /* bounded retry below */ }
      if (attempt < MAX_ATTEMPTS - 1) await delay(attempt);
    }
    throw this.failure();
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

interface ReferencedResource {
  key: string;
  name: string;
  type: "file" | "image" | "audio" | "video";
  apiType: "file" | "image";
}

function referencedResources(messageType: unknown, value: unknown): ReferencedResource[] {
  const content = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const validKey = (key: unknown): key is string => typeof key === "string" && key.length > 0 && key.length <= 4096;
  const suppliedName = typeof content.file_name === "string" && content.file_name ? content.file_name : undefined;
  switch (messageType) {
    case "file":
      return validKey(content.file_key) ? [{ key: content.file_key, name: suppliedName ?? "attachment.bin", type: "file", apiType: "file" }] : [];
    case "image":
      return validKey(content.image_key) ? [{ key: content.image_key, name: "image.bin", type: "image", apiType: "image" }] : [];
    case "audio":
      return validKey(content.file_key) ? [{ key: content.file_key, name: suppliedName ?? "audio.opus", type: "audio", apiType: "file" }] : [];
    case "media":
    case "video":
      return validKey(content.file_key) ? [{ key: content.file_key, name: suppliedName ?? "video.mp4", type: "video", apiType: "file" }] : [];
    default:
      return [];
  }
}

function card(text: string): object {
  return { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] };
}
