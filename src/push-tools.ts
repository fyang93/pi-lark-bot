import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerResponse } from "./types.ts";

/**
 * How this session reaches the bot. A worker pane holds no credentials and asks
 * the controller over IPC; the pi that hosts the controller calls it directly.
 * The tools themselves are identical either way.
 */
export interface PushToolHandlers {
  push(text: string, ctx: ExtensionContext): Promise<WorkerResponse>;
  /** Only chat-bound workers supply this; the controller resolves the destination. */
  sendFile?(path: string, name?: string): Promise<WorkerResponse>;
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
    description: "Push to the project-wide Lark target (may differ from this chat). Each message supports at most 4 Markdown tables.",
    promptSnippet: "Post a message to the configured Lark push target chat",
    promptGuidelines: [
      "Use only for an explicit push request; split content exceeding 4 Markdown tables into multiple self-contained messages.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Plain text to post. Write it so it makes sense to readers who cannot see this conversation." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => result(await handlers.push(params.text, ctx)),
  });

  if (handlers.sendFile) pi.registerTool({
    name: "lark_send_file",
    label: "Send File to This Chat",
    description: "Send a user-selected file to this chat (max 30 MB). Use only on request; never for the global push target.",
    promptSnippet: "Send a user-selected local file to the current Feishu/Lark conversation",
    promptGuidelines: ["Send only the file the user selected; claim delivery only after success."],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path or workspace-relative path to the file the user selected." }),
      name: Type.Optional(Type.String({ description: "Optional filename shown to the recipient." })),
    }),
    execute: async (_toolCallId, params) => result(await handlers.sendFile!(params.path, params.name)),
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
