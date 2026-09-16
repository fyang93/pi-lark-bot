import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { acquireLock, inspectLock, loadConfig, prepareState, writePrivateJson } from "./storage.ts";
import type { BotController } from "./controller.ts";

const commands = ["link", "on", "off", "help"];
const help = [
  "/lark-bot — Show project configuration, listener and sessions",
  "/lark-bot link — Register a bot or enter existing app credentials",
  "/lark-bot on — Enable listening manually (requires tmux)",
  "/lark-bot off — Stop listening and close panes, preserving history",
].join("\n");

/** Loading only registers a command: no sockets, timers, subprocesses or auth. */
export default function larkBot(pi: ExtensionAPI): void {
  if (process.env.PI_LARK_BOT_WORKER === "1") return;
  let controller: BotController | undefined;
  let release: (() => Promise<void>) | undefined;
  let operation = false;
  let shuttingDown = false;
  const setupAbort = new AbortController();
  async function stop(): Promise<void> {
    const old = controller; controller = undefined;
    try { await old?.stop(); }
    finally { const unlock = release; release = undefined; await unlock?.(); }
  }
  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true; setupAbort.abort();
    ctx?.ui.setStatus("lark-bot", undefined);
    await stop();
  });
  pi.registerCommand("lark-bot", {
    description: "Project-local Feishu/Lark bot: link, on, off",
    getArgumentCompletions(prefix) {
      return commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/lark-bot requires an interactive pi TUI.", "error"); return; }
      const [command] = args.trim().split(/\s+/).filter(Boolean);
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
          const lock = await inspectLock(stateDir);
          const listener = status?.active ? "enabled in this pi"
            : lock.state === "running" ? `another pi holds the project lock (PID ${lock.pid})`
            : lock.state === "none" ? "stopped (never starts automatically)"
            : "stale or invalid project lock; verify old processes have exited before removal";
          ctx.ui.notify([
            `Project: ${cwd}`,
            `Credentials: ${config ? `${config.brand} / ${config.appId}` : "not connected; run /lark-bot link"}`,
            `Listener: ${listener} · Connection: ${status?.connection ?? "stopped"}`,
            `Main sessions: ${status?.users ?? 0} · Running/queued: ${status?.queued ?? 0}`,
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
            ctx.ui.notify("Credentials saved in project .pi/lark-bot/. Enable the bot, long-connection events and required permissions, then run /lark-bot on.", "info");
          } finally { await unlock(); }
          return;
        }
        let config = await loadConfig(stateDir);
        if (!config) throw new Error("Run /lark-bot link first.");
        if (!process.env.TMUX || !/^%\d+$/.test(process.env.TMUX_PANE ?? "")) throw new Error("Start pi inside tmux before running /lark-bot on.");
        const tmux = await pi.exec("tmux", ["-V"], { timeout: 5000 });
        const version = tmux.stdout.match(/tmux\s+(\d+)\.(\d+)/);
        if (tmux.code !== 0 || !version || Number(version[1]) < 3 || Number(version[1]) === 3 && Number(version[2]) < 2) throw new Error("tmux 3.2 or newer is required.");
        if (!await ctx.ui.confirm("Enable remote code execution?", "Anyone who can message this bot or mention it in a group can use local pi tools. There is no allowlist. Sessions share project files, and group replies are visible to group members.", { signal: setupAbort.signal })) return;
        if (shuttingDown) return;
        release = await acquireLock(stateDir);
        try {
          // Configuration may have changed during the confirmation dialog.
          config = await loadConfig(stateDir);
          if (!config) throw new Error("Configuration changed. Check and retry.");
          const [{ LarkTransport }, { TmuxWorkers }, { BotController }] = await Promise.all([
            import("./lark.ts"), import("./panes.ts"), import("./controller.ts"),
          ]);
          if (shuttingDown) { await stop(); return; }
          let lastErrorAt = 0;
          const onError = (error: unknown) => {
            if (Date.now() - lastErrorAt < 5000 || shuttingDown) return;
            lastErrorAt = Date.now();
            // Never dump SDK errors, subprocess objects, payloads or credentials.
            const detail = error instanceof Error && /^(Lark (API|connection)|Pi worker|Timed out waiting for pi worker|Tmux did not|Unable to locate the pi CLI)/.test(error.message)
              ? ` (${error.message.slice(0, 240)})` : "";
            ctx.ui.notify(`Lark bot operation failed${detail}. Check connectivity, app permissions and the session pane. Generated history is preserved locally.`, "error");
          };
          const transport = new LarkTransport(config, onError);
          const instance = new BotController({ config, stateDir, transport,
            workers: new TmuxWorkers({ cwd, stateDir, appId: config.appId,
              model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
              thinkingLevel: pi.getThinkingLevel() }),
            defaultModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
            availableModels: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
            onError, onStatus: () => {
              if (!shuttingDown) ctx.ui.setStatus("lark-bot", controller?.status.active ? `Lark ● ${controller.status.queued} running/queued` : undefined);
            },
          });
          transport.setCardActionHandler((messageId, chatId, operatorId, value) => instance.handleModelCardAction(messageId, chatId, operatorId, value));
          controller = instance;
          await instance.start();
          if (shuttingDown) { await stop(); return; }
          ctx.ui.notify("Lark bot enabled: direct messages and group @mentions. Run /lark-bot off to disable.", "info");
        } catch (error) { await stop(); throw error; }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Lark bot operation failed", "error");
      } finally { operation = false; }
    },
  });
}
