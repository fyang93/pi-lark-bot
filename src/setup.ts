import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Text, matchesKey } from "@earendil-works/pi-tui";
import { registerBot } from "./registration.ts";
import type { BotConfig } from "./types.ts";
import { validateConfig } from "./storage.ts";

async function secretInput(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
    const input = new Input();
    let finished = false;
    const finish = (value: string | undefined) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); done(value);
    };
    const abort = () => finish(undefined);
    input.onSubmit = finish;
    input.onEscape = abort;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      render: (width: number) => new Text(`App Secret (hidden)\n${"•".repeat(Math.min(input.getValue().length, 48))}\nEnter to confirm · Esc to cancel`, 0, 0).render(width),
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "ctrl+c")) abort();
        else input.handleInput(data);
        tui.requestRender();
      },
      dispose() { signal.removeEventListener("abort", abort); },
    };
  });
}

export async function connectBot(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<BotConfig | undefined> {
  const brandChoice = await ctx.ui.select("Platform", ["Feishu", "Lark"], { signal });
  if (!brandChoice || signal.aborted) return;
  const brand = brandChoice === "Feishu" ? "feishu" : "lark";
  const mode = await ctx.ui.select("Connect bot (project-local; does not start listening)", [
    "Register a new bot (recommended)", "Enter existing App ID / App Secret",
  ], { signal });
  if (!mode || signal.aborted) return;
  if (mode.startsWith("Enter")) {
    const appId = await ctx.ui.input("App ID", "cli_…", { signal });
    if (!appId || signal.aborted) return;
    const appSecret = await secretInput(ctx, signal);
    if (!appSecret || signal.aborted) return;
    return validateConfig({ version: 1, brand, appId: appId.trim(), appSecret: appSecret.trim() });
  }

  return ctx.ui.custom<BotConfig | undefined>((tui, _theme, _keys, done) => {
    const controller = new AbortController();
    const abort = () => { controller.abort(); finish(undefined); };
    let finished = false;
    const finish = (value: BotConfig | undefined) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    let text = "Requesting authorization URL…\nEsc to cancel";
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); }
    else void registerBot({ brand, signal: controller.signal,
      onUrl(url, expiresIn) {
        if (finished) return;
        text = `Open this official URL in your browser (expires in ${expiresIn}s):\n\n${url}\n\nWaiting for authorization… · Esc to cancel\nCredentials are saved only in this project, not the system keychain.`;
        tui.requestRender();
      },
    }).then((result) => {
      if (finished) return;
      finish(validateConfig({ version: 1, brand: result.brand, appId: result.appId,
        appSecret: result.appSecret }));
    }).catch(() => {
      if (finished) return;
      text = "Authorization failed, was denied or expired. Press Esc to retry or enter existing credentials.";
      tui.requestRender();
    });
    return {
      render: (width: number) => new Text(text, 0, 0).render(width),
      invalidate() {},
      handleInput(data: string) { if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) abort(); },
      dispose() { controller.abort(); signal.removeEventListener("abort", abort); },
    };
  });
}
