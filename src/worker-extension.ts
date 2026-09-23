import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPushTools } from "./push-tools.ts";
import type { WorkerEvent, WorkerRequest, WorkerResponse } from "./types.ts";

type Prompt = { id: string; text: string; cancelled?: boolean };
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 64_000;
const REQUEST_TIMEOUT_MS = 30_000;
function textFrom(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
}

/** Private child extension: no keyboard injection and no bot credentials. */
export default function larkWorkerExtension(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_LARK_BOT_SOCKET;
  const runId = process.env.PI_LARK_BOT_RUN_ID;
  const token = process.env.PI_LARK_BOT_TOKEN;
  const directUserId = process.env.PI_LARK_BOT_DIRECT_USER_ID;
  const groupChatId = process.env.PI_LARK_BOT_GROUP_CHAT_ID;
  const isGroupChat = process.env.PI_LARK_BOT_GROUP_CHAT === "1" || !!groupChatId;
  let socket: Socket | undefined, ctx: ExtensionContext | undefined, buffer = "";
  let pending: Prompt | undefined, dispatching: Prompt | undefined;
  let active: { id: string; prompt: string; text: string; failed: boolean; started: boolean; cancelled?: boolean } | undefined;
  let lastRemoteId: string | undefined, localTurnPending = false;
  // pi-interactive-subagents returns from its tool immediately, then delivers
  // the completed result as a fresh, steered parent turn. Keep the remote turn
  // open across that idle gap so its final parent answer reaches Lark.
  let awaitingSubagent = false, spawnedSubagentThisTurn = false;
  let stopping = false, promptOpen = false, waiting = false;
  let handoffTimer: NodeJS.Timeout | undefined, textTimer: NodeJS.Timeout | undefined, retryTimer: NodeJS.Timeout | undefined;
  let queuedText: { id: string; text: string } | undefined;
  const requests = new Map<string, (response: WorkerResponse) => void>();

  const send = (message: object): void => {
    if (socket && !socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(message)}\n`);
  };
  /** Ask the controller to act. The worker holds no bot credentials, so it can only ask. */
  const request = (payload: WorkerRequest): Promise<WorkerResponse> => new Promise((resolve) => {
    if (stopping || !socket || socket.destroyed || socket.writableEnded) {
      resolve({ ok: false, text: "与 Lark 控制端的连接不可用。" }); return;
    }
    const id = randomBytes(12).toString("hex");
    const timer = setTimeout(() => {
      requests.delete(id);
      resolve({ ok: false, text: "Lark 控制端超时未响应。" });
    }, REQUEST_TIMEOUT_MS);
    requests.set(id, (response) => { clearTimeout(timer); resolve(response); });
    send({ type: "request", id, ...payload });
  });
  const setWaiting = (value: boolean): void => {
    waiting = value;
    ctx?.ui.setStatus("lark-bot", value ? ctx.ui.theme.fg("warning", "Lark: waiting") : undefined);
  };
  const cleanup = (): void => {
    stopping = true;
    clearTimeout(handoffTimer); clearTimeout(textTimer); clearTimeout(retryTimer);
    for (const resolve of requests.values()) resolve({ ok: false, text: "Lark 会话正在关闭。" });
    requests.clear();
    queuedText = undefined; pending = undefined; dispatching = undefined; active = undefined; lastRemoteId = undefined;
    awaitingSubagent = false; spawnedSubagentThisTurn = false;
    setWaiting(false);
  };
  const shutdown = (): void => {
    if (stopping) return;
    cleanup();
    // Parent pane close normally terminates us. This is a safety fallback for a
    // controller crash plus another extension that blocks graceful shutdown.
    if (process.env.PI_LARK_BOT_WORKER === "1") setTimeout(() => process.exit(0), 5000).unref();
    void Promise.resolve(ctx?.abort()).catch(() => {}).finally(() => ctx?.shutdown());
  };
  const flushText = (force = false): void => {
    clearTimeout(textTimer); textTimer = undefined;
    if (!queuedText || stopping) return;
    if (!force && socket && socket.writableLength > 256 * 1024) {
      textTimer = setTimeout(() => flushText(), 150); return;
    }
    const event = queuedText; queuedText = undefined;
    send({ type: "text", id: event.id, text: event.text });
  };
  const emit = (event: WorkerEvent): void => {
    if (!active?.started || stopping) return;
    if (event.type === "text") {
      queuedText = { id: active.id, text: event.text };
      if (!textTimer) textTimer = setTimeout(() => flushText(), 150);
    } else if (!socket || socket.writableLength <= 256 * 1024) send({ ...event, id: active.id });
  };
  const dispatch = (): void => {
    if (stopping || !ctx || active || dispatching || !pending) return;
    if (promptOpen || !ctx.isIdle()) {
      if (!waiting) {
        setWaiting(true);
        send({ type: "progress", id: pending.id, text: "正在等待本地 Pi 当前回合或确认操作结束…" });
      }
      // Covers manual compaction/dialog completion as well as agent_settled.
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = undefined; dispatch(); }, 250);
      return;
    }
    clearTimeout(retryTimer); retryTimer = undefined;
    const prompt = pending; dispatching = prompt; setWaiting(false);
    handoffTimer = setTimeout(() => {
      if (active?.started || stopping) return;
      send({ type: "done", id: prompt.id, text: "Pi 未能接收远程消息，请检查本地输入处理扩展。", error: true });
      socket?.end(); shutdown(); // never leave a latent prompt running after an apparent failure
    }, 10_000);
    try { pi.sendUserMessage(prompt.text, { expandPromptTemplates: false }); }
    catch {
      send({ type: "done", id: prompt.id, text: "Pi 无法接收远程消息。", error: true });
      socket?.end(); shutdown();
    }
  };
  const settled = (): void => {
    if (stopping || !ctx?.isIdle()) return;
    if (active?.started) {
      if (!active.cancelled) {
        if (spawnedSubagentThisTurn) {
          spawnedSubagentThisTurn = false; awaitingSubagent = true;
          emit({ type: "progress", text: "正在等待子代理完成…" });
          return;
        }
        if (awaitingSubagent) return;
      }
      const completed = active; flushText(true); active = undefined;
      lastRemoteId = completed.cancelled ? undefined : completed.id;
      awaitingSubagent = false; spawnedSubagentThisTurn = false;
      send({ type: "done", id: completed.id,
        text: completed.cancelled ? "⏹ 已停止当前消息。" : completed.text || (completed.failed ? "Pi 回合执行失败或已中止。" : ""),
        error: !completed.cancelled && completed.failed || undefined });
    }
    dispatch();
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
      if (message?.type === "abort" && typeof message.id === "string") {
        if (active && active.id === message.id) {
          active.cancelled = true;
          if (active.started && ctx?.isIdle()) settled();
          else ctx?.abort();
        } else if (pending && pending.id === message.id) {
          pending.cancelled = true;
          if (!dispatching) {
            clearTimeout(retryTimer); retryTimer = undefined;
            pending = undefined; setWaiting(false);
            send({ type: "done", id: message.id, text: "⏹ 已停止当前消息。" });
          }
        }
        continue;
      }
      if (message && message.type === "response" && typeof message.id === "string") {
        const resolve = requests.get(message.id);
        if (resolve) {
          requests.delete(message.id);
          resolve({ ok: message.ok === true, text: typeof message.text === "string" ? message.text : "" });
        }
        continue;
      }
      if (!message || message.type !== "prompt" || !ctx || typeof message.id !== "string" || !message.id ||
        typeof message.text !== "string" || Buffer.byteLength(message.text) > MAX_PROMPT_BYTES || pending || dispatching || active) {
        socket?.destroy(); return;
      }
      pending = { id: message.id, text: message.text };
      dispatch();
    }
  };

  if (socketPath) {
    registerPushTools(pi, {
      push: (text) => request({ action: "push", text }),
      target: (action) => request({ action: action === "set" ? "set-target" : action === "clear" ? "clear-target" : "target-status" }),
    });
  }

  pi.on("session_start", (_event, eventCtx) => {
    ctx = eventCtx;
    if (!socketPath || !runId || !token) {
      ctx.ui.notify("Lark worker IPC is not configured", "error"); ctx.shutdown(); return;
    }
    socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      send({ type: "hello", runId, token }); send({ type: "ready" });
    });
    socket.on("data", receive);
    socket.on("error", () => socket?.destroy());
    socket.on("close", shutdown);
  });
  pi.on("input", (event) => {
    if (stopping) return;
    if (event.source === "interactive") { localTurnPending = true; return; }
    if (event.source !== "extension" || !dispatching || event.text !== dispatching.text) return;
    const prompt = dispatching;
    dispatching = undefined; pending = undefined;
    if (prompt.cancelled) {
      clearTimeout(handoffTimer); handoffTimer = undefined;
      send({ type: "done", id: prompt.id, text: "⏹ 已停止当前消息。" });
      return { action: "handled" as const };
    }
    active = { id: prompt.id, prompt: prompt.text, text: "", failed: false, started: false };
  });
  pi.on("before_agent_start", (event) => {
    // Session metadata is supplied on every model turn, so it remains
    // available after compaction without adding a visible conversation entry.
    const sessionContext = directUserId
      ? `The user ID is \`${directUserId}\`.`
      : isGroupChat
        ? `${groupChatId ? `The group chat ID is \`${groupChatId}\`. ` : ""}In this group chat, each user message is formatted as \`user_id: message\`.`
        : undefined;
    const identity = sessionContext ? { systemPrompt: `${event.systemPrompt}\n\n${sessionContext}` } : undefined;
    // Any extension/background continuation in this pane belongs to the last
    // remote conversation. Local TUI input is explicitly excluded above.
    if (!active && lastRemoteId && !localTurnPending) {
      active = { id: lastRemoteId, prompt: "", text: "", failed: false, started: true };
      emit({ type: "progress", text: "正在处理会话后续消息…" });
      return identity;
    }
    localTurnPending = false;
    if (!active) return identity;
    if (active.started && awaitingSubagent) {
      // This is the steered continuation containing a subagent result.
      awaitingSubagent = false; spawnedSubagentThisTurn = false; active.text = "";
      emit({ type: "progress", text: "正在整理子代理结果…" });
      return identity;
    }
    if (active.started || event.prompt !== active.prompt) return identity;
    active.started = true;
    clearTimeout(handoffTimer); handoffTimer = undefined;
    emit({ type: "progress", text: "正在处理中…" });
    return identity;
  });
  // A stop can arrive after input was accepted but before the agent actually starts.
  pi.on("agent_start", (_event, eventCtx) => { if (active?.cancelled) eventCtx.abort(); });
  pi.on("message_start", (event) => {
    if (active?.started && event.message.role === "assistant") {
      active.text = ""; emit({ type: "text", text: "" });
    }
  });
  pi.on("message_update", (event) => {
    if (!active?.started || event.message.role !== "assistant") return;
    active.text = textFrom(event.message); emit({ type: "text", text: active.text });
  });
  pi.on("message_end", (event) => {
    if (!active?.started || event.message.role !== "assistant") return;
    active.text = textFrom(event.message); emit({ type: "text", text: active.text });
  });
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "subagent") spawnedSubagentThisTurn = true;
    emit({ type: "progress", text: `正在调用工具：${event.toolName}` });
  });
  pi.on("tool_execution_end", (event) => emit({ type: "progress", text: `${event.isError ? "工具执行失败" : "工具执行完成"}：${event.toolName}` }));
  pi.on("agent_end", (event) => {
    if (!active?.started) return;
    const messages = [...event.messages] as any[];
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    active.failed = last?.stopReason === "error" || last?.stopReason === "aborted";
    // Extension-provided tools do not consistently emit tool_execution_start in
    // every Pi runtime. The completed turn still contains its tool result.
    if (messages.some((message) => message?.role === "toolResult" && message?.toolName === "subagent")) spawnedSubagentThisTurn = true;
  });
  pi.on("agent_settled", settled);
  pi.on("ui_prompt_start", () => {
    promptOpen = true;
    if (active?.started) emit({ type: "progress", text: "正在等待本地确认…" });
    else if (pending) send({ type: "progress", id: pending.id, text: "正在等待本地确认…" });
  });
  pi.on("ui_prompt_end", () => {
    promptOpen = false;
    if (active?.started) emit({ type: "progress", text: "正在处理中…" });
    else queueMicrotask(dispatch);
  });
  const blockSwitch = () => {
    ctx?.ui.notify("This pane is bound to one Lark user. Stop the bot before managing its saved session separately.", "warning");
    return { cancel: true as const };
  };
  pi.on("session_before_switch", blockSwitch);
  pi.on("session_before_fork", blockSwitch);
  pi.on("session_shutdown", () => { cleanup(); socket?.end(); });
}
