/** Project-local one-click Lark/Feishu app registration.
 *
 * This intentionally mirrors the official node SDK's device flow, but uses
 * fetch so the initial request is abortable too (the SDK's axios wrapper does
 * not expose a request signal for `begin`). No credential is logged.
 */

import { gzipSync } from "node:zlib";

export type RegistrationBrand = "feishu" | "lark";

export interface RegisterBotOptions {
  brand: RegistrationBrand;
  /** Existing `cli_…` app to update and retrieve credentials for. */
  appId?: string;
  /** Let the official confirmation page select an existing app after scanning. */
  allowExistingApp?: boolean;
  signal: AbortSignal;
  onUrl: (url: string, expiresIn: number) => void;
}

export interface RegisteredBot {
  appId: string;
  appSecret: string;
  brand: RegistrationBrand;
  ownerOpenId?: string;
}

const DOMAINS: Record<RegistrationBrand, string> = {
  feishu: "accounts.feishu.cn",
  lark: "accounts.larksuite.com",
};
const ENDPOINT = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 600;

const addons = {
  preset: false,
  scopes: {
    tenant: ["im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message:readonly", "im:message:update"],
  },
  events: { items: { tenant: ["im.message.receive_v1"] } },
  callbacks: { items: ["card.action.trigger"] },
};

function abortError(): Error {
  return new Error("Bot registration was aborted");
}

function safeError(code: string): Error {
  switch (code) {
    case "access_denied": return new Error("Bot registration was denied");
    case "expired_token": return new Error("Bot registration expired");
    case "authorization_pending": return new Error("Bot registration is still pending");
    case "slow_down": return new Error("Bot registration polling was rate limited");
    default: return new Error("Bot registration failed");
  }
}

function encodeAddons(): string {
  // Node 22 provides CompressionStream, but zlib is synchronous and available
  // in every supported runtime. This is the encoding used by the official SDK.
  return gzipSync(Buffer.from(JSON.stringify(addons), "utf8"))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function request(baseUrl: string, values: Record<string, string>, signal: AbortSignal, deadlineSignal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) throw abortError();
  if (deadlineSignal?.aborted) throw new Error("Bot registration expired");
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  const combined = AbortSignal.any([signal, timeoutController.signal, ...(deadlineSignal ? [deadlineSignal] : [])]);
  let response: Response;
  let body: unknown;
  try {
    // Keep the timeout active through response.json(): a connected server can
    // still stall while delivering the body.
    response = await fetch(`${baseUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      signal: combined,
    });
    body = await response.json();
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (deadlineSignal?.aborted) throw new Error("Bot registration expired");
    if (timeoutController.signal.aborted) throw new Error("Bot registration request timed out");
    if (error instanceof DOMException && error.name === "AbortError") throw abortError();
    throw new Error("Bot registration returned invalid data");
  } finally {
    clearTimeout(timeout);
  }
  if (!body || typeof body !== "object") throw new Error("Bot registration returned invalid data");
  const result = body as Record<string, unknown>;
  // RFC 8628 errors are intentionally returned in HTTP 400 bodies by Lark.
  if (typeof result.error === "string") {
    if (result.error !== "authorization_pending" && result.error !== "slow_down") throw safeError(result.error);
  } else if (!response!.ok) {
    throw new Error("Bot registration request failed");
  }
  return result;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function officialAuthorizationUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Bot registration returned an invalid authorization URL"); }
  const allowedHosts = new Set([...Object.values(DOMAINS), "open.feishu.cn", "open.larksuite.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
    throw new Error("Bot registration returned an untrusted authorization URL");
  }
  return url;
}

function wait(ms: number, signal: AbortSignal, deadlineSignal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new Error("Bot registration polling interval is invalid"));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    if (deadlineSignal?.aborted) return reject(new Error("Bot registration expired"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      deadlineSignal?.removeEventListener("abort", onDeadline);
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const onDeadline = () => { cleanup(); reject(new Error("Bot registration expired")); };
    timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(ms, 2_147_483_647));
    signal.addEventListener("abort", onAbort, { once: true });
    deadlineSignal?.addEventListener("abort", onDeadline, { once: true });
  });
}

/** Register a new bot app through the official Lark/Feishu device flow. */
export async function registerBot(options: RegisterBotOptions): Promise<RegisteredBot> {
  const { brand, appId, allowExistingApp, signal, onUrl } = options;
  if (brand !== "feishu" && brand !== "lark") throw new Error("Unsupported registration brand");
  if (appId !== undefined && !/^cli_[a-zA-Z0-9_-]+$/.test(appId)) throw new Error("Invalid existing bot App ID");
  if (signal.aborted) throw abortError();

  let baseUrl = `https://${DOMAINS[brand]}`;
  const begin = await request(baseUrl, {
    action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id",
  }, signal);
  const verification = stringField(begin.verification_uri_complete);
  const deviceCode = stringField(begin.device_code);
  if (!verification || !deviceCode) throw new Error("Bot registration returned an incomplete authorization request");
  const rawExpires = typeof begin.expires_in === "number" && Number.isFinite(begin.expires_in) && begin.expires_in >= 0 ? begin.expires_in : DEFAULT_EXPIRES_SECONDS;
  const expiresIn = Math.min(rawExpires, 86_400);
  const rawInterval = typeof begin.interval === "number" && Number.isFinite(begin.interval) && begin.interval >= 0 ? begin.interval : DEFAULT_INTERVAL_SECONDS;
  const interval = Math.min(rawInterval, 60) * 1000;
  const url = officialAuthorizationUrl(verification);
  url.searchParams.set("from", "sdk");
  url.searchParams.set("source", "pi-lark-bot");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("addons", encodeAddons());
  // Omitting createOnly lets the official page select an existing app; a
  // supplied clientID makes that selection explicit and returns its secret.
  if (appId) url.searchParams.set("clientID", appId);
  else if (!allowExistingApp) url.searchParams.set("createOnly", "true");
  onUrl(url.toString(), expiresIn);

  const deadline = Date.now() + expiresIn * 1000;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), Math.max(0, expiresIn * 1000));
  deadlineTimer.unref();
  let pollInterval = interval;
  let ownerOpenId: string | undefined;
  try {
    while (Date.now() < deadline) {
      await wait(Math.min(pollInterval, Math.max(0, deadline - Date.now())), signal, deadlineController.signal);
      const result = await request(baseUrl, { action: "poll", device_code: deviceCode }, signal, deadlineController.signal);
      const info = result.user_info as Record<string, unknown> | undefined;
      if (info?.tenant_brand === "lark" && baseUrl !== `https://${DOMAINS.lark}`) {
        baseUrl = `https://${DOMAINS.lark}`;
        continue;
      }
      const appId = stringField(result.client_id);
      const appSecret = stringField(result.client_secret);
      if (appId && appSecret) {
        ownerOpenId = stringField(info?.open_id);
        return { appId, appSecret, brand: info?.tenant_brand === "lark" ? "lark" : brand, ...(ownerOpenId ? { ownerOpenId } : {}) };
      }
      const errorCode = typeof result.error === "string" ? result.error : undefined;
      if (errorCode === "slow_down") pollInterval += 5000;
      else if (errorCode && errorCode !== "authorization_pending") throw safeError(errorCode);
    }
    throw new Error("Bot registration expired");
  } finally {
    clearTimeout(deadlineTimer);
  }
}
