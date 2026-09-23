import * as Lark from "@larksuiteoapi/node-sdk";
import type { BotConfig, BotTransport, IncomingMessage } from "./types.js";
import { AttachmentCache, MAX_ATTACHMENT_BYTES } from "./attachment-cache.js";

/** An inbound message, already normalized by the SDK channel. */
interface ChannelMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  content: string;
  rawContentType?: string;
  resources?: unknown[];
  replyToMessageId?: string;
}

interface Channel {
  botIdentity?: { openId: string; name: string };
  rawClient: any;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(handlers: Record<string, (...args: any[]) => unknown>): unknown;
  send(to: string, input: object, options?: { replyTo?: string }): Promise<{ messageId: string }>;
  editMessage(messageId: string, text: string): Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
}

/** The SDK surface used here; exported so tests can supply a real-shaped fake. */
export interface LarkSdk {
  createLarkChannel(options: Record<string, unknown>): Channel;
  Domain?: { Feishu: unknown; Lark: unknown };
  LoggerLevel?: Record<string, number>;
}

export type LarkTransportState = "stopped" | "starting" | "connected";

const MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set([90002, 90013, 99991400, 99991663]);

/**
 * Tenant-bot Lark/Feishu transport.
 *
 * Connection lifecycle, reconnection, mention matching and message
 * normalization belong to the SDK's channel. Reimplementing them here is how
 * messages went missing: a hand-rolled connection flag discarded events that
 * arrived outside it, and a silenced logger hid what the SDK had to say. This
 * class maps between the channel's shapes and the controller's, and little else.
 */
export class LarkTransport implements BotTransport {
  private readonly channel: Channel;
  private onMessage?: (message: IncomingMessage) => Promise<void>;
  private onCardAction?: (messageId: string, chatId: string, operatorId: string | undefined, value: unknown) => Promise<void>;
  private _state: LarkTransportState = "stopped";
  private readonly attachmentCache?: AttachmentCache;

  constructor(
    private readonly config: BotConfig,
    private readonly onError: (error: Error) => void = () => {},
    sdk: LarkSdk = Lark as unknown as LarkSdk,
    attachmentCacheDir?: string,
  ) {
    if (!config.appId || !config.appSecret) throw new Error("Lark app credentials are required");
    this.attachmentCache = attachmentCacheDir ? new AttachmentCache(attachmentCacheDir) : undefined;
    this.channel = sdk.createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.brand === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu,
      transport: "websocket",
      source: "pi-lark-bot",
      // A direct message is always addressed to the bot; a group message only
      // when it really mentions it. The channel enforces both, so nothing here
      // parses mentions or compares open_ids.
      policy: { dmMode: "open", requireMention: true },
      // Nothing else is overridden. The channel's defaults for deduplication,
      // staleness, batching and per-chat queueing are what the bots that never
      // lost a message ran on; tuning them from here is how messages go missing.
      logger: {
        // A console logger would write through the pi TUI, so failures are
        // reported to the extension instead. This changes no delivery decision.
        fatal: () => this.report("Lark SDK reported a fatal error"),
        error: () => this.report("Lark SDK reported an error"),
        warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
      },
    });
  }

  get state(): LarkTransportState { return this._state; }

  setCardActionHandler(handler: (messageId: string, chatId: string, operatorId: string | undefined, value: unknown) => Promise<void>): void {
    this.onCardAction = handler;
  }

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this._state !== "stopped") throw new Error("Lark transport is already started");
    this.onMessage = onMessage;
    this._state = "starting";
    this.channel.on({
      message: (message: ChannelMessage) => this.receive(message),
      cardAction: (event: any) => this.cardAction(event),
      // The channel's account of what it chose not to deliver. Surfacing it
      // keeps a policy decision from looking like a lost message.
      reject: (event: any) => this.report(`Lark channel rejected a message (${String(event?.reason ?? "unknown").slice(0, 60)})`),
      error: () => this.report("Lark connection error"),
    });
    try { await this.channel.connect(); }
    catch (error) {
      this._state = "stopped";
      this.report("Lark connection failed");
      throw error instanceof Error ? error : new Error("Lark connection failed");
    }
    this._state = "connected";
  }

  async stop(): Promise<void> {
    if (this._state === "stopped") return;
    this._state = "stopped";
    this.onMessage = undefined;
    try { await this.channel.disconnect(); } catch { /* an already closed connection needs no teardown */ }
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<string> {
    const result = await this.channel.send(chatId, { markdown: text }, replyTo ? { replyTo } : undefined);
    if (!result?.messageId) throw this.failure();
    return result.messageId;
  }

  async update(messageId: string, text: string): Promise<void> {
    await this.channel.editMessage(messageId, text);
  }

  /**
   * Map the channel's message onto the controller's, deciding nothing the
   * channel already decided. An addressed message with nothing runnable still
   * travels on, carrying the reason, so it is answered rather than dropped.
   */
  private async receive(message: ChannelMessage): Promise<void> {
    const handler = this.onMessage;
    if (!handler || this._state === "stopped") return;
    if (!message?.messageId || !message.chatId || !message.senderId) return;
    const group = message.chatType !== "p2p";
    const text = typeof message.content === "string" ? message.content.trim() : "";
    const unsupported = text ? undefined : message.resources?.length ? "message_type" as const : "empty_text" as const;
    try {
      await handler({
        id: message.messageId, userId: message.senderId, chatId: message.chatId,
        text: text || `(${message.rawContentType ?? "empty"})`,
        ...(unsupported ? { unsupported } : {}),
        ...(message.replyToMessageId ? { parentMessageId: message.replyToMessageId } : {}),
        ...(group ? { chatType: "group" as const, mentionedBot: true } : {}),
      });
    } catch { this.report("Lark message handler failed"); }
  }

  private async cardAction(event: any): Promise<void> {
    const messageId = event?.messageId, chatId = event?.chatId;
    if (typeof messageId !== "string" || typeof chatId !== "string" || !this.onCardAction) return;
    try { await this.onCardAction(messageId, chatId, event?.operator?.openId, event?.action?.value); }
    catch { this.report("Lark card action handler failed"); }
  }

  /** Resolve directly quoted resources after authorization; one failed resource never drops the text request. */
  async prepareMessage(message: IncomingMessage): Promise<IncomingMessage> {
    if (!message.parentMessageId || !this.attachmentCache) return message;
    let item: any;
    try {
      const response = await this.request(() => this.channel.rawClient.im.v1.message.get({ path: { message_id: message.parentMessageId } }));
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
    const result = await this.channel.send(chatId, { card: value }, replyTo ? { replyTo } : undefined);
    if (!result?.messageId) throw this.failure();
    return result.messageId;
  }

  async updateCard(messageId: string, value: object): Promise<void> {
    await this.channel.updateCard(messageId, value);
  }

  private async downloadResource(messageId: string, fileKey: string, type: "file" | "image"): Promise<any> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.channel.rawClient.im.v1.messageResource.get({
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

