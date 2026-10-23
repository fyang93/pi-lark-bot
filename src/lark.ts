import { randomUUID } from "node:crypto";
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
const silentLogger = Object.freeze({
  fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
});

function withDetail(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 240) : "";
  return detail ? `${prefix}: ${detail}` : prefix;
}

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

  constructor(
    private readonly config: BotConfig,
    private readonly onError: (error: Error) => void = () => {},
    sdk: LarkSdk = Lark as unknown as LarkSdk,
    attachmentCacheDir?: string,
  ) {
    if (!config.appId || !config.appSecret) throw new Error("Lark app credentials are required");
    // Product brand and the app's long-connection region can differ.
    const domain = (config.domain ?? config.brand) === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
    // Generated endpoint methods' second parameter is IRequestOptions, not an
    // Axios config, so a timeout there is ignored. This wrapper bounds normal
    // API calls, tenant-token exchange, and WS endpoint discovery for real SDKs.
    const httpInstance = boundedHttp(sdk.defaultHttpInstance, domain);
    const common = { appId: config.appId, appSecret: config.appSecret, domain, httpInstance, logger: silentLogger, loggerLevel: 0 };
    this.client = new sdk.Client(common);
    this.attachmentCache = attachmentCacheDir ? new AttachmentCache(attachmentCacheDir) : undefined;
    this.dispatcher = new sdk.EventDispatcher({ logger: silentLogger, loggerLevel: 0 });
    this.dispatcher.register({
      "im.message.receive_v1": (event) => this.receive(event),
      "card.action.trigger": (event) => this.cardAction(event),
    });
    this.ws = new sdk.WSClient({
      ...common,
      handshakeTimeoutMs: API_TIMEOUT_MS,
      onReady: () => this.ready(),
      onReconnecting: () => { if (this._state === "connected") this._state = "reconnecting"; },
      onReconnected: () => {
        if (this._state === "starting") this.ready();
        else if (this._state !== "stopped") this._state = "connected";
      },
      onError: (error: Error) => this.connectionFailed(error),
    });
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
      })().catch((error) => this.failStart(withDetail("Lark connection could not be started", error)));
    } catch (error) {
      this.failStart(withDetail("Lark connection could not be started", error));
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
    return this.sendCard(chatId, card(text), replyTo);
  }

  async update(messageId: string, text: string): Promise<void> { await this.updateCard(messageId, card(text)); }

  /** Resolve directly quoted resources after authorization; one failed resource never drops the text request. */
  async prepareMessage(message: IncomingMessage): Promise<IncomingMessage> {
    if (!message.parentMessageId && !message.resourceReferences?.length) return message;
    let candidates: ReferencedResource[] = message.resourceReferences?.map((resource) => ({ ...resource })) ?? [];
    let sourceMessageId = message.id;
    let base = message;
    if (message.parentMessageId) {
      let item: any;
      try {
        const response = await this.request(() => this.client.im.v1.message.get({
          path: { message_id: message.parentMessageId }, params: { card_msg_content_type: "user_card_content" },
        }));
        item = response?.data?.items?.find((candidate: any) => candidate?.message_id === message.parentMessageId);
      } catch { return { ...message, preparationWarning: "referenced_message_unavailable" }; }
      if (!item || item.chat_id !== message.chatId || typeof item.body?.content !== "string") return message;
      let content: any;
      try { content = JSON.parse(item.body.content); } catch { return message; }
      const quotedText = quotedMessageText(content);
      base = quotedText ? { ...message, quotedText } : message;
      candidates = referencedResources(item.msg_type, content);
      sourceMessageId = message.parentMessageId;
    }
    if (!this.attachmentCache || !candidates.length) return base;
    const attachments: NonNullable<IncomingMessage["attachments"]> = [];
    for (const candidate of candidates) {
      try {
        const cached = await this.attachmentCache.get(`${this.config.appId}\0${sourceMessageId}\0${candidate.key}`, candidate.name, async () => {
          const resource = await this.downloadResource(sourceMessageId, candidate.key, candidate.apiType);
          const length = Number(resource.headers?.["content-length"] ?? resource.headers?.["Content-Length"]);
          if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) throw new Error("Referenced resource is larger than 100 MB");
          return resource.getReadableStream() as AsyncIterable<Uint8Array | string>;
        });
        attachments.push({ status: "ready", type: candidate.type, ...cached, sourceMessageId });
      } catch {
        attachments.push({ status: "failed", type: candidate.type, name: candidate.name, sourceMessageId, error: "download_failed" });
      }
    }
    return { ...base, attachments };
  }

  async sendCard(chatId: string, value: object, replyTo?: string): Promise<string> {
    // Lark uses uuid for idempotency. Keep it stable across retries of this one send.
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

  private connectionFailed(error?: Error): void {
    if (this._state === "stopped") return;
    const message = withDetail("Lark connection failed", error);
    if (this._state === "starting") this.failStart(message);
    else {
      this._state = "stopped";
      this.close();
      this.report(message);
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
    if (event?.sender?.sender_type !== "user") return undefined;
    if (!["p2p", "group"].includes(message?.chat_type)) return undefined;
    if (typeof message?.message_id !== "string" || typeof message?.chat_id !== "string") return undefined;
    const userId = event.sender.sender_id?.open_id;
    if (typeof userId !== "string" || !userId) return undefined;
    const group = message.chat_type === "group";

    // Decide whether the message is addressed to this bot before judging its
    // content: an unsupported message in a group we merely sit in stays silent,
    // but one aimed at us must never disappear without an answer.
    const mentioned = Array.isArray(message.mentions) && this.botOpenId
      ? message.mentions.filter((mention: any) => mention?.id?.open_id === this.botOpenId)
      : [];
    if (group) {
      if (!this.botOpenId) {
        this.report("Lark bot identity is unknown, so group mentions cannot be matched");
        return undefined;
      }
      if (!Array.isArray(message.mentions)) return undefined;
      if (!mentioned.length) return undefined; // @all or mentioning somebody else is not a bot command
    }
    // A mention placeholder is a key like "@_user_1", never the text the sender
    // typed. Leaving one in a direct message hid "/new" behind it, so the
    // command went to the model, which confirmed a reset that never happened.
    const mentionKeys: string[] = mentioned
      .map((mention: any) => mention.key)
      .filter((key: any) => typeof key === "string" && key.length > 0);

    // Addressed but unusable: hand it on anyway, carrying the reason. The
    // controller answers it after the allowlist check, so an unauthorized
    // sender still gets no more than the usual refusal.
    const deliver = (text: string, unsupported?: IncomingMessage["unsupported"]) => this.dispatch(message, userId, text, group, unsupported);
    if (!["text", "post"].includes(message.message_type)) return deliver(`(${message.message_type})`, "message_type");
    let content: unknown;
    try { content = JSON.parse(message.content); } catch { return deliver("(unparsable)", "content"); }
    const parsed = message.message_type === "post" ? parsePost(content) : parseText(content);
    let text = parsed.text;
    for (const key of mentionKeys) if (text.includes(key)) text = text.split(key).join("");
    text = text.trim();
    if (!text && !parsed.resources.length) return deliver("(empty)", "empty_text");
    return this.dispatch(message, userId, text, group, undefined, parsed.resources);
  }

  private async dispatch(message: any, userId: string, text: string, group: boolean, unsupported?: IncomingMessage["unsupported"], resources: ReferencedResource[] = []): Promise<void> {
    // The SDK only hands over an event across a live connection, so what
    // matters is whether this transport was stopped, not which phase of the
    // connection lifecycle a status flag happens to hold.
    if (this._state === "stopped" || !this.onMessage) return;
    try {
      await this.onMessage({ id: message.message_id, userId, chatId: message.chat_id, text,
        ...(resources.length ? { resourceReferences: resources.map((resource) => ({ key: resource.key, name: resource.name,
          type: resource.type === "image" ? "image" as const : "file" as const,
          apiType: resource.apiType === "image" ? "image" as const : "file" as const })) } : {}),
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

function boundedHttp(http: LarkSdk["defaultHttpInstance"], domain: string): LarkSdk["defaultHttpInstance"] | undefined {
  if (!http) return undefined; // enables minimal SDK test doubles
  const primaryEndpoint = `${domain}/callback/ws/endpoint`;
  const fallbackEndpoint = `${domain === "https://open.larksuite.com" ? "https://open.feishu.cn" : "https://open.larksuite.com"}/callback/ws/endpoint`;
  let wsEndpoint = primaryEndpoint;
  const options = (value: Record<string, unknown> = {}) => ({
    ...value, timeout: Math.min(Number(value.timeout) || API_TIMEOUT_MS, API_TIMEOUT_MS),
  });
  // Tenant token exchange calls HttpInstance.post(), whereas generated OpenAPI
  // methods call request(). Proxy both forms without changing SDK internals.
  return new Proxy(http, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function") return method;
      if (key === "request") return async (value: Record<string, unknown>) => {
        if (value.url !== primaryEndpoint) return method.call(target, options(value));
        const result = await method.call(target, options({ ...value, url: wsEndpoint }));
        // Retry only an explicit region mismatch, never auth/network errors or ordinary API calls.
        if (result?.code !== 1000040351 || wsEndpoint !== primaryEndpoint) return result;
        const fallback = await method.call(target, options({ ...value, url: fallbackEndpoint }));
        if (fallback?.code === 0) wsEndpoint = fallbackEndpoint;
        return fallback;
      };
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

function parseText(value: unknown): { text: string; resources: ReferencedResource[] } {
  const text = value && typeof value === "object" && typeof (value as any).text === "string" ? (value as any).text : "";
  return { text, resources: [] };
}

function parsePost(value: unknown): { text: string; resources: ReferencedResource[] } {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as any : {};
  const locale = root.zh_cn ?? root.en_us ?? root.ja_jp ?? Object.values(root).find((item: any) => item && typeof item === "object");
  const blocks = locale && Array.isArray(locale.content) ? locale.content : [];
  const lines: string[] = [], resources: ReferencedResource[] = [];
  if (typeof locale?.title === "string" && locale.title) lines.push(locale.title);
  for (const block of blocks) {
    if (!Array.isArray(block)) continue;
    const parts: string[] = [];
    for (const item of block) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") parts.push(item.text);
      else if (item.tag === "img" && typeof item.image_key === "string") {
        resources.push({ key: item.image_key, name: "image.bin", type: "image", apiType: "image" }); parts.push("[图片]");
      } else if ((item.tag === "media" || item.tag === "file") && typeof item.file_key === "string") {
        const name = typeof item.file_name === "string" && item.file_name ? item.file_name : "attachment.bin";
        resources.push({ key: item.file_key, name, type: "file", apiType: "file" }); parts.push(`[文件: ${name}]`);
      }
    }
    if (parts.join("")) lines.push(parts.join(""));
  }
  return { text: lines.join("\n"), resources };
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

function quotedMessageText(value: unknown): string | undefined {
  const text = (node: any): string[] => {
    if (Array.isArray(node)) return node.flatMap(text);
    if (!node || typeof node !== "object") return [];
    if (typeof node.text === "string") return [node.text];
    if (typeof node.content === "string") return [node.content];
    return Object.entries(node)
      .filter(([key]) => key === "elements" || key === "body" || key === "header")
      .flatMap(([, child]) => text(child));
  };
  const result = text(value).join("\n").trim();
  return result || undefined;
}

function card(text: string): object {
  return { schema: "2.0", config: { width_mode: "fill" }, body: { elements: [{ tag: "markdown", content: text }] } };
}
