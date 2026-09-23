import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerResponse } from "./types.ts";

/**
 * How this session reaches the bot. A worker pane holds no credentials and asks
 * the controller over IPC; the pi that hosts the controller calls it directly.
 * The tools themselves are identical either way.
 */
export interface PushToolHandlers {
  push(text: string): Promise<WorkerResponse>;
  /** Omitted for a session that belongs to no chat, where "set this chat" has no meaning. */
  target?(action: "set" | "clear" | "status"): Promise<WorkerResponse>;
}

function result(response: WorkerResponse): { content: [{ type: "text"; text: string }]; details: object } {
  // Pi marks a tool result as failed only when execute throws.
  if (!response.ok) throw new Error(response.text);
  return { content: [{ type: "text", text: response.text }], details: {} };
}

export function registerPushTools(pi: ExtensionAPI, handlers: PushToolHandlers): void {
  pi.registerTool({
    name: "lark_push",
    label: "Lark Push",
    description: [
      "Send a message to this project's globally configured Feishu/Lark push target chat.",
      "The push target is a single project-wide chat. It is often NOT the chat you are currently talking to,",
      "and its readers may not see this conversation, so make the text self-contained.",
      "Fails when no push target is configured.",
    ].join(" "),
    promptSnippet: "Post a message to the configured Lark push target chat",
    promptGuidelines: [
      "Use lark_push only when the user or a skill explicitly asks for something to be pushed, posted or reported to the Lark push target. Never use lark_push to answer the current conversation: an ordinary reply already reaches it.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Plain text to post. Write it so it makes sense to readers who cannot see this conversation." }),
    }),
    execute: async (_toolCallId, params) => result(await handlers.push(params.text)),
  });

  if (!handlers.target) return;
  pi.registerTool({
    name: "lark_push_target",
    label: "Lark Push Target",
    description: [
      "Inspect or change this project's global Feishu/Lark push target.",
      "'set' always means the chat this conversation belongs to: it takes no chat ID, and the controller resolves it.",
      "'clear' removes the target and disables pushing. 'status' reports the current target.",
    ].join(" "),
    promptSnippet: "Set, clear or report the Lark push target chat",
    promptGuidelines: [
      "Use lark_push_target with action 'set' when a user in this chat asks for messages, notifications or reports to be pushed here from now on, and with 'clear' when they ask to stop.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("clear"), Type.Literal("status")], {
        description: "'set' makes this chat the push target, 'clear' removes it, 'status' reports it.",
      }),
    }),
    execute: async (_toolCallId, params) => result(await handlers.target!(params.action)),
  });
}
