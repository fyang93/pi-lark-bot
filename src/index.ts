import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { acquireLock, inspectLock, isMissing, loadAllowlist, loadConfig, loadPushTarget, prepareState, readPrivateJson, saveAllowlist, savePushTarget, writePrivateJson } from "./storage.ts";
import type { BotController } from "./controller.ts";
import { registerPushTools } from "./push-tools.ts";
import { pushViaOwner, servePush, type Endpoint } from "./push-ipc.ts";
import { requireZellij } from "./zellij.ts";
import { missingBotPermissions, permissionInstructions } from "./registration.ts";

const commands = ["link", "on", "off", "allow", "deny", "push", "help"];
const help = [
  "/lark-bot — Show project configuration, listener, sessions and push target",
  "/lark-bot link — Register a bot or enter existing app credentials",
  "/lark-bot on — Enable automatic listening for this project (requires Zellij 0.44+)",
  "/lark-bot off — Disable automatic listening and close panes, preserving history",
  "/lark-bot allow [open_id|code] — Allowlist a sender; with no argument, pick from recent rejections",
  "/lark-bot deny <open_id> — Remove a sender from the allowlist",
  "/lark-bot push [off] — Show or clear the global push target",
].join("\n");

// inspectLock conservatively treats a live PID with a missing socket as "running"
// during startup. Status requires a responding owner, not that PID fallback.
async function verifiedOwner(stateDir: string, endpoint: { cwd: string; appId: string; socket: string; token: string; ownerToken: string }): Promise<boolean> {
  const lock = await readPrivateJson(join(stateDir, "controller.lock"), false) as { token?: unknown };
  if (lock?.token !== endpoint.ownerToken) return false;
  return new Promise((resolve) => {
    const socket = createConnection(endpoint.socket); let data = "", done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 1000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ type: "ping", token: endpoint.token, cwd: endpoint.cwd, appId: endpoint.appId }) + "\n"));
    socket.on("error", () => finish(false)); socket.on("close", () => finish(false));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) { finish(false); return; }
      const end = data.indexOf("\n"); if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        finish(response.ok === true && response.type === "status" && response.cwd === endpoint.cwd &&
          response.appId === endpoint.appId && response.socket === endpoint.socket && response.ownerToken === endpoint.ownerToken);
      } catch { finish(false); }
    });
  });
}

async function enabledFor(stateDir: string, appId: string): Promise<boolean> {
  try {
    const value = await readPrivateJson(join(stateDir, "enabled.json")) as { appId?: unknown; enabled?: unknown };
    if (!value || typeof value.appId !== "string" || typeof value.enabled !== "boolean") throw new Error("Invalid enabled.json");
    return value.appId === appId && value.enabled;
  } catch (error) { if (isMissing(error)) return false; throw error; }
}

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
  let release: ((() => Promise<void>) & { token: string }) | undefined;
  let closePush: (() => Promise<void>) | undefined;
  let started: { cwd: string; appId: string } | undefined;
  let operation = false;
  let shuttingDown = false;
  const setupAbort = new AbortController();
  async function stop(): Promise<void> {
    const old = controller; controller = undefined; started = undefined;
    const close = closePush; closePush = undefined;
    try { await close?.(); }
    finally {
      try { await old?.stop(); }
      finally { const unlock = release; release = undefined; await unlock?.(); }
    }
  }
  // Session replacement stops this listener; enabled projects can start again in the fresh runtime.
  async function confirmReplacement(ctx: { ui: { confirm(title: string, body: string): Promise<boolean> } } | undefined) {
    if (shuttingDown || !controller?.status.active || !ctx) return undefined;
    const ok = await ctx.ui.confirm("Stop the Lark bot?",
      "Replacing this pi session stops the listener, closes every worker pane and drops queued messages. Chat history is preserved; run /lark-bot on afterwards to start listening again. Continue?");
    return ok ? undefined : { cancel: true as const };
  }
  pi.on("session_before_switch", (event, ctx) => event.reason === "new" ? undefined : confirmReplacement(ctx));
  pi.on("session_before_fork", (_event, ctx) => confirmReplacement(ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    shuttingDown = true; setupAbort.abort();
    ctx?.ui.setStatus("lark-bot", undefined);
    await stop();
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || shuttingDown) return;
    try {
      const cwd = await realpath(ctx.cwd);
      const stateDir = join(cwd, CONFIG_DIR_NAME, "lark-bot");
      if (controller?.status.active && started?.cwd === cwd) return;
      // Never read credentials while another Pi already owns the inbound listener.
      const lock = await inspectLock(stateDir);
      if (lock.state === "running") {
        const endpoint = await readPrivateJson(join(stateDir, "push-endpoint.json"))
          .catch((error) => { if (isMissing(error)) return undefined; throw error; }) as Endpoint | undefined;
        if (endpoint?.cwd === cwd && typeof endpoint.appId === "string" && typeof endpoint.socket === "string" &&
          typeof endpoint.token === "string" && typeof endpoint.ownerToken === "string" &&
          await enabledFor(stateDir, endpoint.appId) && await verifiedOwner(stateDir, endpoint)) {
          const config = await loadConfig(stateDir);
          const brand = config?.brand === "lark" ? "Lark" : "Feishu";
          ctx.ui.setStatus("lark-bot", ctx.ui.theme.fg("accent", `🐤 ${brand}: push_only`));
        }
        return;
      }
      if (lock.state !== "none" && lock.state !== "stale") return;
      const config = await loadConfig(stateDir);
      if (!config || !await enabledFor(stateDir, config.appId)) return;
      await run("on", ctx, config.appId, true);
    } catch {
      ctx.ui.notify("Could not restore Lark bot. Run /lark-bot on to retry.", "error");
    }
  });
  // Every local Pi exposes the tool; non-owners send through the sole owner's
  // outbound endpoint, so the controller remains the authority for target and rate.
  registerPushTools(pi, { push: async (text, ctx) => {
    if (!ctx.isProjectTrusted()) return { ok: false, text: "Trust this project before using Lark push." };
    const cwd = await realpath(ctx.cwd);
    if (controller && started?.cwd === cwd) return controller.push(text);
    const stateDir = join(cwd, CONFIG_DIR_NAME, "lark-bot");
    let preference: { appId?: unknown; enabled?: unknown };
    try { preference = await readPrivateJson(join(stateDir, "enabled.json")) as typeof preference; }
    catch (error) { if (isMissing(error)) return { ok: false, text: "Lark bot is not listening in this project." }; throw error; }
    if (!preference || preference.enabled !== true || typeof preference.appId !== "string")
      return { ok: false, text: "Lark bot is not listening in this project." };
    return pushViaOwner(stateDir, cwd, preference.appId, text);
  } });
  pi.registerCommand("lark-bot", {
    description: "Project-local Feishu/Lark bot: link, on, off",
    getArgumentCompletions(prefix) {
      return commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: (args, ctx) => run(args, ctx),
  });
  async function run(args: string, ctx: ExtensionContext, restoreAppId?: string, automatic = false): Promise<void> {
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
            : lock.state === "none" ? "stopped"
            : lock.state === "stale" ? "dead owner; next start will verify and recover the lock"
            : "unverified project owner; inspect it manually before retrying";
          ctx.ui.notify([
            `Project: ${cwd}`,
            `Credentials: ${config ? `${config.brand} / ${config.appId}` : "not connected; run /lark-bot link"}`,
            `Listener: ${listener} · Connection: ${status?.connection ?? "stopped"}`,
            `Allowlisted users: ${status?.allowlisted ?? 0} · Chats: ${status?.users ?? 0} · Pending handoffs: ${status?.queued ?? 0}`,
            `Push target: ${target ? `${target.chatType === "group" ? "group" : "direct chat"} ${target.chatId}` : "none (pushing disabled)"}`,
            ...(status?.denied ? [`Recent rejections awaiting review: ${status.denied} (run /lark-bot allow)`] : []),
            ...(status?.sessions.map((session) => `${session.userId} → pane ${session.paneId ?? "starting"} · ${session.connected ? "connected" : "disconnected"}`) ?? []),
            `Storage: ${stateDir}`,
          ].join("\n"), "info");
          return;
        }
        if (command === "off") {
          if (!controller && (await inspectLock(stateDir)).state === "running") throw new Error("Another pi holds the project lock. Run /lark-bot off in that pi session.");
          // A non-owner cannot turn off somebody else's live controller.
          if (controller) await writePrivateJson(join(stateDir, "enabled.json"), { appId: started!.appId, enabled: false });
          else {
            const unlock = await acquireLock(stateDir);
            try {
              const config = await loadConfig(stateDir);
              if (config) await writePrivateJson(join(stateDir, "enabled.json"), { appId: config.appId, enabled: false });
            } finally { await unlock(); }
          }
          await stop(); ctx.ui.setStatus("lark-bot", undefined);
          ctx.ui.notify("Lark bot stopped. Automatic listening disabled; session history preserved.", "info"); return;
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
        if (restoreAppId !== undefined && config.appId !== restoreAppId) throw new Error("Bot configuration changed. Run /lark-bot on to enable it again.");
        if (restoreAppId === undefined && !await ctx.ui.confirm("Enable remote code execution?", "New users require local approval (10-second timeout; default choice is Confirm), whether they contact the bot directly or @mention it in a group. Sessions share project files, and group replies are visible to group members.", { signal: setupAbort.signal })) return;
        if (shuttingDown) return;
        release = await acquireLock(stateDir);
        try {
          // Configuration may have changed during the confirmation dialog.
          config = await loadConfig(stateDir);
          if (!config || (restoreAppId !== undefined && config.appId !== restoreAppId)) throw new Error("Configuration changed. Check and retry.");
          // A queued automatic start must not undo an off completed while it waited for the lock.
          if (automatic && !await enabledFor(stateDir, config.appId)) { await stop(); return; }
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
          const brand = config.brand === "lark" ? "Lark" : "Feishu";
          const transport = new LarkTransport(config, onError, undefined, join(stateDir, "attachments"));
          // Worker panes hold no credentials: their push and push-target requests
          // are served here, and the chat is resolved from the worker's own key.
          let served: BotController | undefined;
          const workers = new ZellijWorkers({ cwd, stateDir, appId: config.appId,
            model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            thinkingLevel: pi.getThinkingLevel(),
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
              const pending = controller?.status.active ? controller.status.queued : undefined;
              ctx.ui.setStatus("lark-bot", pending === undefined ? undefined
                : ctx.ui.theme.fg("accent", `🐤 ${brand}: listening${pending > 0 ? ` · ${pending} pending handoff${pending === 1 ? "" : "s"}` : ""}`));
            },
          });
          transport.setCardActionHandler((messageId, chatId, operatorId, value) => instance.handleModelCardAction(messageId, chatId, operatorId, value));
          served = instance;
          controller = instance;
          await instance.start();
          if (shuttingDown) { await stop(); return; }
          closePush = await servePush(stateDir, cwd, config.appId, release!.token, (text) => instance.push(text));
          started = { cwd, appId: config.appId };
          if (!automatic) await writePrivateJson(join(stateDir, "enabled.json"), { appId: config.appId, enabled: true });
          ctx.ui.notify("Lark bot enabled: only allowlisted users can use direct messages or group @mentions. Run /lark-bot off to disable.", "info");
        } catch (error) { await stop(); throw error; }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Lark bot operation failed", "error");
      } finally { operation = false; }
  }
}
