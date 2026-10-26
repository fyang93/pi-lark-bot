import { randomUUID } from "node:crypto";
import { appendFileSync, constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { BotConfig, BotTransport, IncomingMessage } from "./types.js";
import { AttachmentCache, MAX_ATTACHMENT_BYTES, safeFilename } from "./attachment-cache.js";

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
const debugEnabled = process.env.PI_LARK_BOT_DEBUG === "1";

function debugLog(event: string, value: unknown): void {
  if (!debugEnabled) return;
  let line = `[pi-lark-bot debug] ${event}`;
  try { line += ` ${JSON.stringify(value)}`; } catch { /* keep the event name */ }
  try { console.error(line); } catch { /* diagnostics must not affect delivery */ }
  try { appendFileSync(`${process.cwd()}/.pi/lark-bot/debug.log`, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); }
  catch { /* the workspace may not have a writable state directory */ }
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
    private readonly projectDir = process.cwd(),
  ) {
    if (!config.appId || !config.appSecret) throw new Error("请先配置 Lark 应用凭据。");
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
      onError: () => this.connectionFailed(),
    });
  }

  get state(): LarkTransportState { return this._state; }

  setCardActionHandler(handler: (messageId: string, chatId: string, operatorId: string | undefined, value: unknown) => Promise<void>): void { this.onCardAction = handler; }

  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this._state !== "stopped") return Promise.reject(new Error("Lark 连接已启动，请勿重复启动。"));
    this.onMessage = onMessage;
    this._state = "starting";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failStart("Lark 连接超时，请检查网络后重试。"), START_TIMEOUT_MS);
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
      })().catch(() => this.failStart("无法启动 Lark 连接，请检查网络及应用凭据。"));
    } catch {
      this.failStart("无法启动 Lark 连接，请检查网络及应用凭据。");
    }
    return ready;
  }

  async stop(): Promise<void> {
    if (this._state === "starting") {
      this.failStart("Lark 连接已停止。"); // also force-closes exactly once
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

  /** Upload a user-selected local file and send it as a native Feishu/Lark file message. */
  async sendFile(chatId: string, inputPath: string, displayName?: string): Promise<string> {
    const root = await realpath(this.projectDir);
    // The user decides which readable local file to share. Relative paths are
    // resolved from the workspace; absolute paths are accepted as-is.
    const localPath = inputPath.startsWith("sandbox:") ? inputPath.slice("sandbox:".length) : inputPath;
    const path = await realpath(resolve(root, localPath));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size === 0 || info.size > 30 * 1024 * 1024) throw new Error("File must be non-empty and no larger than 30 MB.");
      bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
        if (!bytesRead) throw new Error("File changed while being read.");
        offset += bytesRead;
      }
    } finally { await handle.close(); }
    const fileName = safeFilename(displayName || basename(path));
    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    const fileType = ({ pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", ppt: "ppt", pptx: "ppt", mp4: "mp4", opus: "opus" } as Record<string, string>)[extension] ?? "stream";
    const uploaded = await this.request(async () => {
      const result = await this.client.im.v1.file.create({ data: { file_type: fileType, file_name: fileName, file: bytes } });
      return result?.file_key ? { code: 0, data: result } : result;
    });
    const fileKey = uploaded?.data?.file_key;
    if (typeof fileKey !== "string" || !fileKey) throw this.failure();
    const data = { msg_type: "file", content: JSON.stringify({ file_key: fileKey }), uuid: randomUUID() };
    const response = await this.request(() => this.client.im.v1.message.create({
      data: { ...data, receive_id: chatId }, params: { receive_id_type: "chat_id" },
    }));
    const id = response?.data?.message_id;
    if (typeof id !== "string" || !id) throw this.failure();
    return id;
  }

  /** Resolve directly quoted resources after authorization; one failed resource never drops the text request. */
  async prepareMessage(message: IncomingMessage): Promise<IncomingMessage> {
    if (!message.parentMessageId && !message.resourceReferences?.length) return message;
    const candidates: Array<ReferencedResource & { sourceMessageId: string }> =
      message.resourceReferences?.map((resource) => ({ ...resource, sourceMessageId: message.id })) ?? [];
    let base = message;
    if (message.parentMessageId) {
      try {
        const response = await this.request(() => this.client.im.v1.message.get({
          path: { message_id: message.parentMessageId }, params: { card_msg_content_type: "user_card_content" },
        }));
        const item = response?.data?.items?.find((candidate: any) => candidate?.message_id === message.parentMessageId);
        if (!item || item.chat_id !== message.chatId || typeof item.body?.content !== "string") throw new Error("Invalid quoted message");
        const content = JSON.parse(item.body.content);
        const quoted = item.msg_type === "post" ? parsePost(content)
          : { text: quotedMessageText(content), resources: referencedResources(item.msg_type, content) };
        if (quoted.text) base = { ...message, quotedText: quoted.text };
        candidates.push(...quoted.resources.map((resource) => ({ ...resource, sourceMessageId: message.parentMessageId! })));
      } catch { base = { ...message, preparationWarning: "referenced_message_unavailable" }; }
    }
    if (!this.attachmentCache || !candidates.length) return base;
    const attachments: NonNullable<IncomingMessage["attachments"]> = [];
    for (const candidate of candidates) {
      const { sourceMessageId } = candidate;
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

  private connectionFailed(): void {
    if (this._state === "stopped") return;
    const message = "Lark 连接失败，请检查网络与应用配置。";
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
    catch (_error) { this.report("无法关闭 Lark 连接，请检查监听会话。"); }
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
    debugLog("incoming", {
      messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type,
      messageType: message.message_type, parentId: message.parent_id, content: message.content,
    });
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
    let content: unknown;
    if (["file", "image"].includes(message.message_type)) {
      try { content = JSON.parse(message.content); } catch { return deliver("(unparsable)", "content"); }
      let resources: ReferencedResource[];
      try { resources = referencedResources(message.message_type, content); }
      catch (error) {
        debugLog("parse-error", { messageId: message.message_id, messageType: message.message_type,
          error: error instanceof Error ? error.message : String(error) });
        return deliver("(message content could not be parsed)", "content");
      }
      if (!resources.length) return deliver(`(${message.message_type})`, "message_type");
      // Keep the user's prompt empty; the attachment metadata is passed separately.
      return this.dispatch(message, userId, "", group, undefined, resources);
    }
    if (!["text", "post"].includes(message.message_type)) return deliver(`(${message.message_type})`, "message_type");
    try { content = JSON.parse(message.content); } catch { return deliver("(unparsable)", "content"); }
    let parsed: { text: string; resources: ReferencedResource[] };
    try {
      parsed = message.message_type === "post" ? parsePost(content) : parseText(content);
    } catch (error) {
      // Parsing must never turn a received event into a silent drop.
      debugLog("parse-error", { messageId: message.message_id, messageType: message.message_type,
        error: error instanceof Error ? error.message : String(error) });
      return deliver("(message content could not be parsed)", "content");
    }
    debugLog("parsed", { messageId: message.message_id, text: parsed.text, resources: parsed.resources });
    let text = parsed.text;
    for (const key of mentionKeys) if (text.includes(key)) text = text.split(key).join("");
    text = text.trim();
    if (!text && !parsed.resources.length) {
      // An addressed post was received, but its payload shape is unsupported.
      // Report that explicitly instead of misleading the user with the empty-mention hint.
      return message.message_type === "post"
        ? deliver("(post content unavailable)", "content")
        : deliver("(empty)", "empty_text");
    }
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
    const message = "Lark 接口请求失败，请检查网络与应用权限。";
    this.report(message);
    return new Error(message);
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
  const options = (value: Record<string, unknown> = {}) => {
    const maximum = typeof value.url === "string" && value.url.endsWith("/im/v1/files") && value.method === "POST" ? 60_000 : API_TIMEOUT_MS;
    return { ...value, timeout: Math.min(Number(value.timeout) || maximum, maximum) };
  };
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
  // Feishu sends either a locale wrapper (zh_cn/en_us) or a flat post object.
  const locale = root.zh_cn ?? root.en_us ?? root.ja_jp ?? (Array.isArray(root.content) ? root :
    Object.values(root).find((item: any) => item && typeof item === "object" && Array.isArray(item.content)));
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
  // Newer Feishu clients put uploaded files beside content rather than inside a
  // rich-text block. They are still part of this one post request.
  const files = Array.isArray(root.files) ? root.files : [];
  for (const file of files) {
    if (typeof file?.file_key !== "string" || !file.file_key) continue;
    const name = typeof file.file_name === "string" && file.file_name ? file.file_name : "attachment.bin";
    resources.push({ key: file.file_key, name, type: "file", apiType: "file" });
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
