export interface BotConfig {
  version: 1;
  brand: "feishu" | "lark";
  appId: string;
  appSecret: string;
}

export type IncomingAttachment =
  | { status: "ready"; type: "file" | "image" | "audio" | "video"; path: string; name: string; size: number; sourceMessageId: string }
  | { status: "failed"; type: "file" | "image" | "audio" | "video"; name: string; sourceMessageId: string; error: "download_failed" };

export interface IncomingMessage {
  id: string;
  userId: string;
  chatId: string;
  text: string;
  chatType?: "p2p" | "group";
  mentionedBot?: boolean;
  /** The directly quoted/replied-to message, if any. */
  parentMessageId?: string;
  attachments?: IncomingAttachment[];
  preparationWarning?: "referenced_message_unavailable";
  /**
   * Set when a message was addressed to the bot but carries nothing it can run.
   * It still travels the normal path so the allowlist decides who gets an answer:
   * an addressed message must never vanish without one.
   */
  unsupported?: "message_type" | "content" | "empty_text";
}

/** Keep existing private-session keys; group IDs occupy a distinct namespace. */
export function conversationKey(message: IncomingMessage): string {
  return message.chatType === "group" ? `group:${message.chatId}` : message.userId;
}

/** Global, single, optional push destination. Absent means pushing is disabled. */
export interface PushTarget {
  version: 1;
  appId: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** Conversation key that set it, for local diagnostics only. */
  setBy: string;
  setAt: string;
}

/** Worker-initiated request over the controller IPC socket. */
export type WorkerRequest =
  | { action: "push"; text: string }
  | { action: "set-target" }
  | { action: "clear-target" }
  | { action: "target-status" };
export interface WorkerResponse { ok: boolean; text: string }

export type WorkerEvent =
  | { type: "progress"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; text: string; error?: boolean };

export interface ConversationWorker {
  run(text: string, onEvent: (event: WorkerEvent) => void, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface ModelSpec { provider: string; id: string }

export interface WorkerFactory {
  list?(): Array<{ userId: string; paneId?: string; sessionFile: string; connected: boolean }>;
  open(userId: string): Promise<ConversationWorker>;
  /** Delete only this conversation's saved Pi history and close its pane. */
  reset?(userId: string): Promise<void>;
  /** Select the model used when this conversation's pane is next opened. */
  setModel?(userId: string, model: ModelSpec): Promise<void>;
  close(): Promise<void>;
}

export interface BotTransport {
  readonly state?: string;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, replyTo?: string): Promise<string>;
  update(messageId: string, text: string): Promise<void>;
  /** Resolve quoted resources only after sender authorization succeeds. */
  prepareMessage?(message: IncomingMessage): Promise<IncomingMessage>;
  sendCard?(chatId: string, card: object, replyTo?: string): Promise<string>;
  updateCard?(messageId: string, card: object): Promise<void>;
}
