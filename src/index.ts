import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { acquireLock, inspectLock, loadAllowlist, loadConfig, loadPushTarget, prepareState, saveAllowlist, savePushTarget, writePrivateJson } from "./storage.ts";
import type { BotController } from "./controller.ts";
import { registerPushTools } from "./push-tools.ts";
import { requireZellij } from "./zellij.ts";
import { missingBotPermissions, permissionInstructions } from "./registration.ts";

const commands = ["link", "on", "off", "allow", "deny", "push", "help"];
const help = [
  "/lark-bot — Show project configuration, listener, sessions and push target",
  "/lark-bot link — Register a bot or enter existing app credentials",
  "/lark-bot on — Enable listening manually (requires Zellij 0.44+)",
  "/lark-bot off — Stop listening and close panes, preserving history",
  "/lark-bot allow [open_id|code] — Allowlist a sender; with no argument, pick from recent rejections",
  "/lark-bot deny <open_id> — Remove a sender from the allowlist",
  "/lark-bot push [off] — Show or clear the global push target",
].join("\n");

const PUSH_TOOL = "lark_push";
const OPEN_ID = /^o[a-z]_[A-Za-z0-9_-]{6,120}$/;

/** Without a listener there is no rejection history, so only a full open_id can be resolved. */
async function editAllowlistOffline(stateDir: string, appId: string, command: "allow" | "deny", input: string): Promise<{ ok: boolean; text: string }> {
  const value = input.trim();
  if (!OPEN_ID.test(value)) {
    return { ok: false, text: `Not a valid open_id: ${value}. Start the listener with /lark-bot on to resolve a short code.` };
  }
  const unlock = await acquireLock(stateDir);
  try {
    const users = await loadAllowlist(stateDir, appId);
    if (command === "allow") {
      if (users.has(value)) return { ok: true, text: `${value} is already allowlisted.` };
      users.add(value);
    } else if (!users.delete(value)) return { ok: false, text: `${value} is not allowlisted.` };
    await saveAllowlist(stateDir, appId, users);
    return { ok: true, text: command === "allow" ? `Allowlisted ${value}.` : `Removed ${value} from the allowlist.` };
  } finally { await unlock(); }
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** Loading only registers a command: no sockets, timers, subprocesses or auth. */
export default function larkBot(pi: ExtensionAPI): void {
  if (process.env.PI_LARK_BOT_WORKER === "1") return;
  let controller: BotController | undefined;
  let release: (() => Promise<void>) | undefined;
  let operation = false;
  let shuttingDown = false;
  const setupAbort = new AbortController();
  async function stop(): Promise<void> {
    // Never let tool bookkeeping block teardown: the lock and the panes matter more.
    try { disablePushTool(); } catch { /* the session may already be tearing down */ }
    const old = controller; controller = undefined;
    try { await old?.stop(); }
    finally { const unlock = release; release = undefined; await unlock?.(); }
  }
  // /new, /resume, /fork and /clone reload the extension, so the listener cannot
  // survive them: session_shutdown tears it down and this instance is discarded.
  // Warn while the action can still be cancelled instead of letting the bot
  // disappear with nothing but the status bar going quiet.
  async function confirmReplacement(ctx: { ui: { confirm(title: string, body: string): Promise<boolean> } } | undefined) {
    if (shuttingDown || !controller?.status.active || !ctx) return undefined;
    const ok = await ctx.ui.confirm("Stop the Lark bot?",
      "Replacing this pi session stops the listener, closes every worker pane and drops queued messages. Chat history is preserved; run /lark-bot on afterwards to start listening again. Continue?");
    return ok ? undefined : { cancel: true as const };
  }
  pi.on("session_before_switch", (_event, ctx) => confirmReplacement(ctx));
  pi.on("session_before_fork", (_event, ctx) => confirmReplacement(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true; setupAbort.abort();
    ctx?.ui.setStatus("lark-bot", undefined);
    await stop();
  });
  // The same tool as in a worker pane; this pi hosts the controller, so it needs
  // no IPC hop. "set this chat" has no meaning here, so only lark_push is offered.
  // It exists only while this pi listens: loading the extension stays inert, and
  // stopping the listener takes the tool back out of the model's reach.
  let pushToolRegistered = false;
  function enablePushTool(): void {
    if (!pushToolRegistered) {
      registerPushTools(pi, {
        push: async (text) => controller
          ? controller.push(text)
          : { ok: false, text: "Lark bot is not listening in this pi session. Run /lark-bot on first." },
      });
      pushToolRegistered = true;
    }
    pi.setActiveTools([...new Set([...pi.getActiveTools(), PUSH_TOOL])]);
  }
  function disablePushTool(): void {
    // Registration cannot be undone, so deactivation is what removes it.
    if (pushToolRegistered) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== PUSH_TOOL));
  }
  pi.registerCommand("lark-bot", {
    description: "Project-local Feishu/Lark bot: link, on, off",
    getArgumentCompletions(prefix) {
      return commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/lark-bot requires an interactive pi TUI.", "error"); return; }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [command] = parts;
      const rest = parts.slice(1).join(" ");
      if (command === "help") { ctx.ui.notify(help, "info"); return; }
      if (command && !commands.includes(command)) { ctx.ui.notify(help, "warning"); return; }
      if (!ctx.isProjectTrusted()) { ctx.ui.notify("Trust this project first.", "error"); return; }
      if (operation || shuttingDown) { ctx.ui.notify("Another operation is still in progress. Try again later.", "warning"); return; }
      operation = true;
      try {
        const cwd = await realpath(ctx.cwd);
        const stateDir = join(cwd, CONFIG_DIR_NAME, "lark-bot");
        if (!command) {
          const config = await loadConfig(stateDir), status = controller?.status;
          const target = status?.pushTarget ?? (config ? await loadPushTarget(stateDir, config.appId) : undefined);
          const lock = await inspectLock(stateDir);
          const listener = status?.active ? "enabled in this pi"
            : lock.state === "running" ? `another pi holds the project lock (PID ${lock.pid})`
            : lock.state === "none" ? "stopped (never starts automatically)"
            : "stale or invalid project lock; verify old processes have exited before removal";
          ctx.ui.notify([
            `Project: ${cwd}`,
            `Credentials: ${config ? `${config.brand} / ${config.appId}` : "not connected; run /lark-bot link"}`,
            `Listener: ${listener} · Connection: ${status?.connection ?? "stopped"}`,
            `Allowlisted users: ${status?.allowlisted ?? 0} · Main sessions: ${status?.users ?? 0} · Running/queued: ${status?.queued ?? 0}`,
            `Push target: ${target ? `${target.chatType === "group" ? "group" : "direct chat"} ${target.chatId}` : "none (pushing disabled)"}`,
            ...(status?.denied ? [`Recent rejections awaiting review: ${status.denied} (run /lark-bot allow)`] : []),
            ...(status?.sessions.map((session) => `${session.userId} → pane ${session.paneId ?? "starting"} · ${session.connected ? "connected" : "disconnected"}`) ?? []),
            `Storage: ${stateDir}`,
          ].join("\n"), "info");
          return;
        }
        if (command === "off") {
          if (!controller && (await inspectLock(stateDir)).state === "running") throw new Error("Another pi holds the project lock. Run /lark-bot off in that pi session.");
          await stop(); ctx.ui.setStatus("lark-bot", undefined);
          ctx.ui.notify("Lark bot stopped. Session history preserved.", "info"); return;
        }
        if (command === "allow" || command === "deny" || command === "push") {
          const config = await loadConfig(stateDir);
          if (!config) throw new Error("Run /lark-bot link first.");
          // Allowlist and push target are controller state. Editing them from a
          // second pi while another one listens would be silently overwritten.
          if (!controller && (await inspectLock(stateDir)).state === "running") {
            throw new Error(`Another pi holds the project lock. Run /lark-bot ${command} in that pi session.`);
          }
          if (command === "push") {
            if (rest && rest !== "off") { ctx.ui.notify("Usage: /lark-bot push [off]", "warning"); return; }
            if (rest === "off") {
              // A running controller reports the change through onNotice.
              if (controller) await controller.setPushTarget(undefined);
              else {
                await savePushTarget(stateDir, undefined);
                ctx.ui.notify("Lark push target cleared.", "info");
              }
              return;
            }
            const current = controller?.status.pushTarget ?? await loadPushTarget(stateDir, config.appId);
            ctx.ui.notify(current
              ? `Push target: ${current.chatType === "group" ? "group" : "direct chat"} ${current.chatId}`
              : "No push target configured. In the destination chat, ask the bot to make that chat the push target.", "info");
            return;
          }
          let input = rest;
          if (command === "allow" && !input) {
            const recent = controller?.listDenied() ?? [];
            if (!recent.length) {
              ctx.ui.notify("No recent rejections to pick from. Pass an id directly: /lark-bot allow <open_id|code>", "info");
              return;
            }
            const labels = recent.map((entry) =>
              `${entry.chatType === "group" ? "group  " : "direct "} ${entry.userId}  code ${entry.code}  ${ago(entry.at)}  ${entry.excerpt || "(no text)"}`);
            const picked = await ctx.ui.select("Allowlist a recently rejected sender", labels, { signal: setupAbort.signal });
            const index = picked === undefined ? -1 : labels.indexOf(picked);
            if (index < 0) return;
            input = recent[index]!.userId;
          }
          if (!input) { ctx.ui.notify(`Usage: /lark-bot ${command} <open_id>`, "warning"); return; }
          const result = controller
            ? await (command === "allow" ? controller.allow(input) : controller.deny(input))
            : await editAllowlistOffline(stateDir, config.appId, command, input);
          ctx.ui.notify(result.text, result.ok ? "info" : "warning");
          return;
        }
        if (controller) { ctx.ui.notify("Run /lark-bot off before changing configuration or restarting.", "warning"); return; }
        await prepareState(cwd, CONFIG_DIR_NAME);
        if (command === "link") {
          const unlock = await acquireLock(stateDir);
          try {
            if (await loadConfig(stateDir) && !await ctx.ui.confirm("Replace this project's bot?", "Existing sessions will be preserved. Listening will not start automatically.", { signal: setupAbort.signal })) return;
            const { connectBot } = await import("./setup.ts");
            const config = await connectBot(ctx, setupAbort.signal);
            if (!config || shuttingDown) return;
            await writePrivateJson(join(stateDir, "config.json"), config);
            ctx.ui.notify("Credentials saved in project .pi/lark-bot/. Checking bot permissions…", "info");
            const missing = await missingBotPermissions(config, setupAbort.signal);
            if (shuttingDown) return;
            if (missing?.length === 0) {
              ctx.ui.notify("Required bot permissions are granted. Run /lark-bot on to start listening.", "info");
            } else {
              const title = missing ? "Missing bot permissions" : "Could not verify bot permissions";
              const note = permissionInstructions(config, missing);
              ctx.ui.notify(`${title}\n${note}`, "warning");
              await ctx.ui.confirm(title, `${note}\n\nClose this notice when finished (credentials are already saved).`, { signal: setupAbort.signal });
            }
          } finally { await unlock(); }
          return;
        }
        let config = await loadConfig(stateDir);
        if (!config) throw new Error("Run /lark-bot link first.");
        requireZellij();
        if (!await ctx.ui.confirm("Enable remote code execution?", "New users require local approval (10-second timeout; default choice is Confirm), whether they contact the bot directly or @mention it in a group. Sessions share project files, and group replies are visible to group members.", { signal: setupAbort.signal })) return;
        if (shuttingDown) return;
        release = await acquireLock(stateDir);
        try {
          // Configuration may have changed during the confirmation dialog.
          config = await loadConfig(stateDir);
          if (!config) throw new Error("Configuration changed. Check and retry.");
          const [{ LarkTransport }, { ZellijWorkers }, { BotController }] = await Promise.all([
            import("./lark.ts"), import("./panes.ts"), import("./controller.ts"),
          ]);
          if (shuttingDown) { await stop(); return; }
          let lastErrorAt = 0;
          const onError = (error: unknown) => {
            if (Date.now() - lastErrorAt < 5000 || shuttingDown) return;
            lastErrorAt = Date.now();
            // Never dump SDK errors, subprocess objects, payloads or credentials.
            const detail = error instanceof Error && /^(Lark (API|connection)|Pi worker|Timed out waiting for pi worker|Zellij did not|Unable to locate the pi CLI)/.test(error.message)
              ? ` (${error.message.slice(0, 240)})` : "";
            ctx.ui.notify(`Lark bot operation failed${detail}. Check connectivity, app permissions and the session pane. Generated history is preserved locally.`, "error");
          };
          const transport = new LarkTransport(config, onError, undefined, join(stateDir, "attachments"));
          // Worker panes hold no credentials: their push and push-target requests
          // are served here, and the chat is resolved from the worker's own key.
          let served: BotController | undefined;
          const workers = new ZellijWorkers({ cwd, stateDir, appId: config.appId,
            model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            thinkingLevel: pi.getThinkingLevel(),
            canCloseIdle: (key) => served?.canCloseIdle(key) ?? false,
            onRequest: (key, request) => served
              ? served.handleWorkerRequest(key, request)
              : Promise.resolve({ ok: false, text: "Lark 控制端尚未就绪。" }) });
          const instance = new BotController({ config, stateDir, transport, workers,
            defaultModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            availableModels: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
            authorizeUser: (userId, message, signal) => ctx.ui.confirm(
              "Allow new Feishu/Lark user?",
              `User ${userId} is not in this project's allowlist and sent ${message.chatType === "group" ? `an @mention in group ${message.chatId}` : "a direct message"}. Add this user and process the message? No response within 10 seconds is treated as Reject.`,
              { signal, timeout: 10_000 },
            ),
            onError,
            onNotice: (text) => { if (!shuttingDown) ctx.ui.notify(text, "info"); },
            onStatus: () => {
              if (shuttingDown) return;
              const jobs = controller?.status.active ? controller.status.queued : undefined;
              ctx.ui.setStatus("lark-bot", jobs === undefined ? undefined
                : ctx.ui.theme.fg("accent", jobs > 0 ? `Lark: ${jobs} job${jobs === 1 ? "" : "s"}` : "Lark: on"));
            },
          });
          transport.setCardActionHandler((messageId, chatId, operatorId, value) => instance.handleModelCardAction(messageId, chatId, operatorId, value));
          served = instance;
          controller = instance;
          await instance.start();
          if (shuttingDown) { await stop(); return; }
          enablePushTool();
          ctx.ui.notify("Lark bot enabled: only allowlisted users can use direct messages or group @mentions. Run /lark-bot off to disable.", "info");
        } catch (error) { await stop(); throw error; }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Lark bot operation failed", "error");
      } finally { operation = false; }
    },
  });
}
