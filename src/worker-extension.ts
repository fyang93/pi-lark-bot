import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPushTools } from "./push-tools.ts";
import type { WorkerEvent, WorkerRequest, WorkerResponse } from "./types.ts";

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 64_000;
const REQUEST_TIMEOUT_MS = 30_000;
function textFrom(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
}

/** A chat-bound bridge, not a task scheduler. Pi owns execution and follow-up queuing. */
export default function larkWorkerExtension(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_LARK_BOT_SOCKET;
  const runId = process.env.PI_LARK_BOT_RUN_ID;
  const token = process.env.PI_LARK_BOT_TOKEN;
  let socket: Socket | undefined, ctx: ExtensionContext | undefined, buffer = "";
  let stopping = false, connectedChat = false, outputOpen = false, text = "";
  let textTimer: NodeJS.Timeout | undefined, queuedText: string | undefined;
  const requests = new Map<string, (response: WorkerResponse) => void>();
  const send = (message: object): void => {
    if (socket && !socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(message)}\n`);
  };
  const request = (payload: WorkerRequest): Promise<WorkerResponse> => new Promise((resolve) => {
    if (stopping || !socket || socket.destroyed || socket.writableEnded) {
      resolve({ ok: false, text: "与 Lark 控制端的连接不可用。" }); return;
    }
    const id = randomBytes(12).toString("hex");
    const timer = setTimeout(() => {
      requests.delete(id); resolve({ ok: false, text: "Lark 控制端超时未响应。" });
    }, REQUEST_TIMEOUT_MS);
    requests.set(id, (response) => { clearTimeout(timer); resolve(response); });
    send({ type: "request", id, ...payload });
  });
  const cleanup = (): void => {
    stopping = true; clearTimeout(textTimer); queuedText = undefined;
    for (const resolve of requests.values()) resolve({ ok: false, text: "Lark 会话正在关闭。" });
    requests.clear();
  };
  const shutdown = (): void => {
    if (stopping) return;
    cleanup();
    if (process.env.PI_LARK_BOT_WORKER === "1") setTimeout(() => process.exit(0), 5000).unref();
    void Promise.resolve(ctx?.abort()).catch(() => {}).finally(() => ctx?.shutdown());
  };
  const flushText = (): void => {
    clearTimeout(textTimer); textTimer = undefined;
    if (queuedText === undefined || stopping) return;
    if (socket && socket.writableLength > 256 * 1024) {
      textTimer = setTimeout(flushText, 150); return;
    }
    send({ type: "text", text: queuedText }); queuedText = undefined;
  };
  const emit = (event: WorkerEvent): void => {
    if (!connectedChat || stopping) return;
    outputOpen = event.type !== "done";
    if (event.type === "text") {
      queuedText = event.text;
      if (!textTimer) textTimer = setTimeout(flushText, 150);
    } else {
      if (event.type === "done") { clearTimeout(textTimer); textTimer = undefined; queuedText = undefined; }
      send(event);
    }
  };
  const receive = (chunk: string): void => {
    if (stopping) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket?.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: any;
      try { message = JSON.parse(line); } catch { socket?.destroy(); return; }
      if (message?.type === "response" && typeof message.id === "string") {
        const resolve = requests.get(message.id);
        if (resolve) {
          requests.delete(message.id);
          resolve({ ok: message.ok === true, text: typeof message.text === "string" ? message.text : "" });
        }
        continue;
      }
      if (!ctx || typeof message?.id !== "string" || !message.id) { socket?.destroy(); return; }
      if (message.type === "abort") {
        // This is Pi's abort, not cancellation of a Lark-owned job/queue.
        try { ctx.abort(); send({ type: "accepted", id: message.id }); }
        catch { send({ type: "rejected", id: message.id }); }
        continue;
      }
      if (message.type !== "prompt" || typeof message.text !== "string" || !message.text.trim() || Buffer.byteLength(message.text) > MAX_PROMPT_BYTES) {
        socket?.destroy(); return;
      }
      connectedChat = true;
      try {
        pi.sendUserMessage(message.text, { deliverAs: "followUp", expandPromptTemplates: false });
        // Only confirms handoff to Pi, never model completion. Do not retry an
        // uncertain delivery: Pi may have already queued or executed it.
        send({ type: "accepted", id: message.id });
      } catch { send({ type: "rejected", id: message.id }); }
    }
  };

  if (socketPath) registerPushTools(pi, {
    push: (value) => request({ action: "push", text: value }),
    target: (action) => request({ action: action === "set" ? "set-target" : action === "clear" ? "clear-target" : "target-status" }),
  });
  pi.on("session_start", (_event, eventCtx) => {
    ctx = eventCtx;
    if (!socketPath || !runId || !token) {
      ctx.ui.notify("Lark worker IPC is not configured", "error"); ctx.shutdown(); return;
    }
    socket = createConnection(socketPath); socket.setEncoding("utf8");
    socket.on("connect", () => { send({ type: "hello", runId, token }); send({ type: "ready" }); });
    socket.on("data", receive);
    socket.on("error", () => socket?.destroy()); socket.on("close", shutdown);
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") { text = ""; emit({ type: "text", text }); }
  });
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") { text = textFrom(event.message); emit({ type: "text", text }); }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    text = textFrom(event.message);
    const reason = event.message.stopReason;
    if (reason === "toolUse") { emit({ type: "text", text }); return; }
    emit({ type: "done", text: reason === "aborted" ? "⏹ 已停止当前回合。" : text || (reason === "error" ? "Pi 回合执行失败。" : "（没有文本回复）"), error: reason === "error" });
  });
  pi.on("tool_execution_start", (event) => emit({ type: "progress", text: `正在调用工具：${event.toolName}` }));
  pi.on("tool_execution_end", (event) => emit({ type: "progress", text: `${event.isError ? "工具执行失败" : "工具执行完成"}：${event.toolName}` }));
  pi.on("agent_settled", () => {
    if (outputOpen) emit({ type: "done", text: text || "当前回合已结束。" });
  });
  pi.on("ui_prompt_start", () => { if (outputOpen) emit({ type: "progress", text: "正在等待本地确认…" }); });
  const blockSwitch = () => {
    ctx?.ui.notify("This pane is bound to one Lark chat. Stop the bot before managing its saved session separately.", "warning");
    return { cancel: true as const };
  };
  pi.on("session_before_switch", blockSwitch); pi.on("session_before_fork", blockSwitch);
  pi.on("session_shutdown", () => { cleanup(); socket?.end(); });
}
