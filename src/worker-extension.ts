import { createConnection, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerEvent } from "./types.ts";

type Prompt = { id: string; text: string };
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 64_000;
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
  let socket: Socket | undefined, ctx: ExtensionContext | undefined, buffer = "";
  let pending: Prompt | undefined, dispatching: Prompt | undefined;
  let active: { id: string; prompt: string; text: string; failed: boolean; started: boolean } | undefined;
  let stopping = false, promptOpen = false, waiting = false;
  let handoffTimer: NodeJS.Timeout | undefined, textTimer: NodeJS.Timeout | undefined, retryTimer: NodeJS.Timeout | undefined;
  let queuedText: { id: string; text: string } | undefined;

  const send = (message: object): void => {
    if (socket && !socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(message)}\n`);
  };
  const setWaiting = (value: boolean): void => {
    waiting = value;
    ctx?.ui.setStatus("lark-bot", value ? "Lark message waiting for local turn" : undefined);
  };
  const cleanup = (): void => {
    stopping = true;
    clearTimeout(handoffTimer); clearTimeout(textTimer); clearTimeout(retryTimer);
    queuedText = undefined; pending = undefined; dispatching = undefined; active = undefined;
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
        send({ type: "progress", id: pending.id, text: "Waiting for the local pi turn or confirmation to finish." });
      }
      // Covers manual compaction/dialog completion as well as agent_settled.
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = undefined; dispatch(); }, 250);
      return;
    }
    clearTimeout(retryTimer); retryTimer = undefined;
    const prompt = pending; dispatching = prompt; setWaiting(false);
    handoffTimer = setTimeout(() => {
      if (active?.started || stopping) return;
      send({ type: "done", id: prompt.id, text: "Pi did not accept the remote prompt. Check local input-handling extensions.", error: true });
      socket?.end(); shutdown(); // never leave a latent prompt running after an apparent failure
    }, 10_000);
    try { pi.sendUserMessage(prompt.text, { expandPromptTemplates: false }); }
    catch {
      send({ type: "done", id: prompt.id, text: "Pi could not accept the remote prompt.", error: true });
      socket?.end(); shutdown();
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
      if (!message || message.type !== "prompt" || !ctx || typeof message.id !== "string" || !message.id ||
        typeof message.text !== "string" || Buffer.byteLength(message.text) > MAX_PROMPT_BYTES || pending || dispatching || active) {
        socket?.destroy(); return;
      }
      pending = { id: message.id, text: message.text };
      dispatch();
    }
  };

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
    if (stopping || event.source !== "extension" || !dispatching || event.text !== dispatching.text) return;
    const prompt = dispatching;
    dispatching = undefined; pending = undefined;
    active = { id: prompt.id, prompt: prompt.text, text: "", failed: false, started: false };
  });
  pi.on("before_agent_start", (event) => {
    if (!active || active.started || event.prompt !== active.prompt) return;
    active.started = true;
    clearTimeout(handoffTimer); handoffTimer = undefined;
    emit({ type: "progress", text: "Working…" });
  });
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
  pi.on("tool_execution_start", (event) => emit({ type: "progress", text: `Using tool: ${event.toolName}` }));
  pi.on("tool_execution_end", (event) => emit({ type: "progress", text: `${event.isError ? "Tool failed" : "Finished tool"}: ${event.toolName}` }));
  pi.on("agent_end", (event) => {
    if (!active?.started) return;
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    active.failed = last?.stopReason === "error" || last?.stopReason === "aborted";
  });
  pi.on("agent_settled", () => {
    if (stopping || !ctx?.isIdle()) return;
    if (active?.started) {
      const completed = active; flushText(true); active = undefined;
      send({ type: "done", id: completed.id, text: completed.text || (completed.failed ? "The pi turn failed or was aborted." : ""), error: completed.failed || undefined });
    }
    dispatch();
  });
  pi.on("ui_prompt_start", () => {
    promptOpen = true;
    if (active?.started) emit({ type: "progress", text: "Waiting for local confirmation." });
    else if (pending) send({ type: "progress", id: pending.id, text: "Waiting for local confirmation." });
  });
  pi.on("ui_prompt_end", () => {
    promptOpen = false;
    if (active?.started) emit({ type: "progress", text: "Working…" });
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
