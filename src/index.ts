import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { acquireLock, inspectLock, isMissing, loadAllowlist, loadConfig, loadPushTarget, prepareState, readPrivateJson, saveAllowlist, savePushTarget, writePrivateJson } from "./storage.ts";
import type { BotController } from "./controller.ts";
import { registerPushTools } from "./push-tools.ts";
import { pushViaOwner, servePush, type Endpoint } from "./push-ipc.ts";
import { requireHerdr } from "./herdr.ts";
import { missingBotPermissions, permissionInstructions, probeRegistrationDomain } from "./registration.ts";

const commands = ["link", "on", "off", "allow", "deny", "push", "help"];
const help = [
  "/lark-bot — Show project configuration, listener, sessions and push target",
  "/lark-bot link — Register a bot or enter existing app credentials",
  "/lark-bot on — Enable automatic listening for this project (requires herdr)",
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
    if (!value || typeof value.appId !== "string" || typeof value.enabled !== "boolean") throw new Error("enabled.json 格式无效，请检查自动监听配置。");
    return value.appId === appId && value.enabled;
  } catch (error) { if (isMissing(error)) return false; throw error; }
}

const OPEN_ID = /^o[a-z]_[A-Za-z0-9_-]{6,120}$/;

/** Without a listener there is no rejection history, so only a full open_id can be resolved. */
async function editAllowlistOffline(stateDir: string, appId: string, command: "allow" | "deny", input: string): Promise<{ ok: boolean; text: string }> {
  const value = input.trim();
  if (!OPEN_ID.test(value)) {
    return { ok: false, text: `open_id 无效：${value}。如需使用授权码，请先执行 /lark-bot on。` };
  }
  const unlock = await acquireLock(stateDir);
  try {
    const users = await loadAllowlist(stateDir, appId);
    if (command === "allow") {
      if (users.has(value)) return { ok: true, text: `${value} 已在白名单中。` };
      users.add(value);
    } else if (!users.delete(value)) return { ok: false, text: `${value} 不在白名单中。` };
    await saveAllowlist(stateDir, appId, users);
    return { ok: true, text: command === "allow" ? `已将 ${value} 加入白名单。` : `已将 ${value} 移出白名单。` };
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
  let statusTimer: NodeJS.Timeout | undefined;
  let statusCwd: string | undefined;
  let peerStatus: string | undefined;
  let checkingPeer = false;
  async function refreshPeer(ctx: ExtensionContext, cwd: string, stateDir: string): Promise<void> {
    if (checkingPeer || shuttingDown || controller) return;
    checkingPeer = true;
    try {
      let status: string | undefined;
      const endpoint = await readPrivateJson(join(stateDir, "push-endpoint.json"), false)
        .catch((error) => { if (isMissing(error)) return undefined; throw error; }) as Endpoint | undefined;
      if (endpoint?.cwd === cwd && typeof endpoint.appId === "string" && typeof endpoint.socket === "string" &&
        typeof endpoint.token === "string" && typeof endpoint.ownerToken === "string" &&
        await enabledFor(stateDir, endpoint.appId) && await verifiedOwner(stateDir, endpoint)) {
        const config = await loadConfig(stateDir);
        if (config?.appId === endpoint.appId) status = `🐤 ${config.brand === "lark" ? "Lark" : "Feishu"}`;
      }
      if (shuttingDown || controller || status === peerStatus) return;
      peerStatus = status;
      ctx.ui.setStatus("lark-bot", status);
    } finally { checkingPeer = false; }
  }
  let restoring = false;
  async function restore(ctx: ExtensionContext, cwd: string, stateDir: string): Promise<void> {
    if (restoring || operation || shuttingDown || (controller?.status.active && started?.cwd === cwd)) return;
    restoring = true;
    try {
      // Never read credentials while another Pi already owns the inbound listener.
      const lock = await inspectLock(stateDir);
      const config = lock.state === "none" || lock.state === "stale" ? await loadConfig(stateDir) : undefined;
      if (config && await enabledFor(stateDir, config.appId)) await run("on", ctx, config.appId, true);
      else await refreshPeer(ctx, cwd, stateDir);
    } finally { restoring = false; }
  }
  let lastAutomaticError: string | undefined;
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
    shuttingDown = true; setupAbort.abort(); clearInterval(statusTimer);
    ctx?.ui.setStatus("lark-bot", undefined);
    await stop();
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || shuttingDown) return;
    try {
      const cwd = await realpath(ctx.cwd);
      const stateDir = join(cwd, CONFIG_DIR_NAME, "lark-bot");
      if (statusCwd !== cwd) {
        clearInterval(statusTimer);
        if (peerStatus) ctx.ui.setStatus("lark-bot", undefined);
        statusCwd = cwd;
        peerStatus = undefined;
        // Non-owners may already be open when another Pi toggles listening, and
        // take over when the owner exits so listening lasts while any Pi runs.
        statusTimer = setInterval(() => { void restore(ctx, cwd, stateDir).catch(() => {}); }, 1500);
        statusTimer.unref();
      }
      await restore(ctx, cwd, stateDir);
    } catch {
      ctx.ui.notify("无法恢复 Lark 机器人，请执行 /lark-bot on 重试。", "error");
    }
  });
  // Every local Pi exposes the tool; non-owners send through the sole owner's
  // outbound endpoint, so the controller remains the authority for target and rate.
  registerPushTools(pi, { push: async (text, ctx) => {
    if (!ctx.isProjectTrusted()) return { ok: false, text: "请先信任当前项目，再使用 Lark 推送。" };
    const cwd = await realpath(ctx.cwd);
    if (controller && started?.cwd === cwd) return controller.push(text);
    const stateDir = join(cwd, CONFIG_DIR_NAME, "lark-bot");
    let preference: { appId?: unknown; enabled?: unknown };
    try { preference = await readPrivateJson(join(stateDir, "enabled.json")) as typeof preference; }
    catch (error) { if (isMissing(error)) return { ok: false, text: "此项目的 Lark 机器人当前未在监听。" }; throw error; }
    if (!preference || preference.enabled !== true || typeof preference.appId !== "string")
      return { ok: false, text: "此项目的 Lark 机器人当前未在监听。" };
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
      if (ctx.mode !== "tui") { ctx.ui.notify("/lark-bot 需要在交互式 Pi 终端中使用。", "error"); return; }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [command] = parts;
      const rest = parts.slice(1).join(" ");
      if (command === "help") { ctx.ui.notify(help, "info"); return; }
      if (command && !commands.includes(command)) { ctx.ui.notify(help, "warning"); return; }
      if (!ctx.isProjectTrusted()) { ctx.ui.notify("请先信任当前项目。", "error"); return; }
      if (operation || shuttingDown) { if (!automatic) ctx.ui.notify("另一个操作尚未完成，请稍后重试。", "warning"); return; }
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
          if (!controller && (await inspectLock(stateDir)).state === "running") throw new Error("另一个 Pi 持有项目锁，请在该会话执行 /lark-bot off。");
          // A non-owner cannot turn off somebody else's live controller.
          if (controller) await writePrivateJson(join(stateDir, "enabled.json"), { appId: started!.appId, enabled: false });
          else {
            const unlock = await acquireLock(stateDir);
            try {
              const config = await loadConfig(stateDir);
              if (config) await writePrivateJson(join(stateDir, "enabled.json"), { appId: config.appId, enabled: false });
            } finally { await unlock(); }
          }
          await stop(); peerStatus = undefined; ctx.ui.setStatus("lark-bot", undefined);
          ctx.ui.notify("Lark bot stopped. Automatic listening disabled; session history preserved.", "info"); return;
        }
        if (command === "allow" || command === "deny" || command === "push") {
          const config = await loadConfig(stateDir);
          if (!config) throw new Error("请先执行 /lark-bot link 连接机器人。");
          // Allowlist and push target are controller state. Editing them from a
          // second pi while another one listens would be silently overwritten.
          if (!controller && (await inspectLock(stateDir)).state === "running") {
            throw new Error(`另一个 Pi 持有项目锁，请在该会话执行 /lark-bot ${command}。`);
          }
          if (command === "push") {
            if (rest && rest !== "off") { ctx.ui.notify("用法：/lark-bot push [off]", "warning"); return; }
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
          if (!input) { ctx.ui.notify(`用法：/lark-bot ${command} <open_id>`, "warning"); return; }
          const result = controller
            ? await (command === "allow" ? controller.allow(input) : controller.deny(input))
            : await editAllowlistOffline(stateDir, config.appId, command, input);
          ctx.ui.notify(result.text, result.ok ? "info" : "warning");
          return;
        }
        if (controller) { ctx.ui.notify("请先执行 /lark-bot off，再修改配置或重启监听。", "warning"); return; }
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
              const title = missing ? "机器人缺少所需权限" : "无法确认机器人权限";
              const note = permissionInstructions(config, missing);
              ctx.ui.notify(`${title}\n${note}`, "warning");
              await ctx.ui.confirm(title, `${note}\n\nClose this notice when finished (credentials are already saved).`, { signal: setupAbort.signal });
            }
          } finally { await unlock(); }
          return;
        }
        let config = await loadConfig(stateDir);
        if (!config) throw new Error("请先执行 /lark-bot link 连接机器人。");
        requireHerdr();
        if (restoreAppId !== undefined && config.appId !== restoreAppId) throw new Error("机器人配置已变化，请重新执行 /lark-bot on。");
        if (restoreAppId === undefined && !await ctx.ui.confirm("Enable remote code execution?", "New users require local approval (10-second timeout; default choice is Confirm), whether they contact the bot directly or @mention it in a group. Sessions share project files, and group replies are visible to group members.", { signal: setupAbort.signal })) return;
        if (shuttingDown) return;
        release = await acquireLock(stateDir);
        try {
          // Configuration may have changed during the confirmation dialog.
          config = await loadConfig(stateDir);
          if (!config || (restoreAppId !== undefined && config.appId !== restoreAppId)) throw new Error("配置已变化，请检查后重试。");
          if (!config.domain) {
            const domain = await probeRegistrationDomain(config, config.brand);
            if (domain) {
              config = { ...config, domain };
              await writePrivateJson(join(stateDir, "config.json"), config);
            }
          }
          // A queued automatic start must not undo an off completed while it waited for the lock.
          if (automatic && !await enabledFor(stateDir, config.appId)) { await stop(); return; }
          const [{ LarkTransport }, { HerdrWorkers }, { BotController }] = await Promise.all([
            import("./lark.ts"), import("./panes.ts"), import("./controller.ts"),
          ]);
          if (shuttingDown) { await stop(); return; }
          let lastErrorAt = 0;
          const onError = (error: unknown) => {
            if (Date.now() - lastErrorAt < 5000 || shuttingDown) return;
            lastErrorAt = Date.now();
            // Only our sanitized transport and herdr errors may reach the UI.
            const detail = error instanceof Error && /^(Lark (接口|连接)|herdr |无法读取 herdr)/.test(error.message)
              ? `（${error.message.slice(0, 240)}）` : "";
            ctx.ui.notify(`Lark 机器人操作失败${detail}，请检查网络、应用权限和对应分屏。历史已保存在本机。`, "error");
          };
          const brand = config.brand === "lark" ? "Lark" : "Feishu";
          const transport = new LarkTransport(config, onError, undefined, join(stateDir, "attachments"), cwd);
          // Worker panes hold no credentials: their push and push-target requests
          // are served here, and the chat is resolved from the worker's own key.
          let served: BotController | undefined;
          const workers = new HerdrWorkers({ cwd, stateDir, appId: config.appId, brand: config.brand,
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
              ctx.ui.setStatus("lark-bot", controller?.status.active ? ctx.ui.theme.fg("accent", `🐤 ${brand}`) : undefined);
            },
          });
          transport.setCardActionHandler((messageId, chatId, operatorId, value) => instance.handleModelCardAction(messageId, chatId, operatorId, value));
          served = instance;
          controller = instance;
          peerStatus = undefined;
          await instance.start();
          if (shuttingDown) { await stop(); return; }
          closePush = await servePush(stateDir, cwd, config.appId, release!.token, (text) => instance.push(text));
          started = { cwd, appId: config.appId };
          if (!automatic) await writePrivateJson(join(stateDir, "enabled.json"), { appId: config.appId, enabled: true });
          lastAutomaticError = undefined;
          ctx.ui.notify("Lark bot enabled: only allowlisted users can use direct messages or group @mentions. Run /lark-bot off to disable.", "info");
        } catch (error) { await stop(); throw error; }
      } catch (error) {
        const text = error instanceof Error ? error.message : "Lark 机器人操作失败，请检查配置后重试。";
        // Automatic takeovers retry every poll: another Pi winning the lock is
        // expected, and a persistent failure is reported once.
        if (automatic && (/已有正在运行或身份未确认|正在恢复控制端/.test(text) || text === lastAutomaticError)) return;
        if (automatic) lastAutomaticError = text;
        ctx.ui.notify(text, "error");
      } finally { operation = false; }
  }
}
