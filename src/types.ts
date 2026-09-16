export interface BotConfig {
  version: 1;
  brand: "feishu" | "lark";
  appId: string;
  appSecret: string;
}

export interface IncomingMessage {
  id: string;
  userId: string;
  chatId: string;
  text: string;
  chatType?: "p2p" | "group";
  mentionedBot?: boolean;
}

/** Keep existing private-session keys; group IDs occupy a distinct namespace. */
export function conversationKey(message: IncomingMessage): string {
  return message.chatType === "group" ? `group:${message.chatId}` : message.userId;
}

export type WorkerEvent =
  | { type: "progress"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; text: string; error?: boolean };

export interface ConversationWorker {
  run(text: string, onEvent: (event: WorkerEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerFactory {
  list?(): Array<{ userId: string; paneId?: string; sessionFile: string; connected: boolean }>;
  open(userId: string): Promise<ConversationWorker>;
  close(): Promise<void>;
}

export interface BotTransport {
  readonly state?: string;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, replyTo?: string): Promise<string>;
  update(messageId: string, text: string): Promise<void>;
}
