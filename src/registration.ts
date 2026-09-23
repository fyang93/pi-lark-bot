/** Project-local one-click Lark/Feishu app registration.
 *
 * This intentionally mirrors the official node SDK's device flow, but uses
 * fetch so the initial request is abortable too (the SDK's axios wrapper does
 * not expose a request signal for `begin`). No credential is logged.
 */

import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

export type RegistrationBrand = "feishu" | "lark";

export interface RegisterBotOptions {
  brand: RegistrationBrand;
  /** Let the official confirmation page select an existing app after scanning. */
  allowExistingApp?: boolean;
  signal: AbortSignal;
  onUrl: (url: string, expiresIn: number) => void;
}

export interface RegisteredBot {
  appId: string;
  appSecret: string;
  brand: RegistrationBrand;
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

/** Official CLI's scope-apply page; the administrator still confirms the grants. */
export function permissionInstructions(config: Pick<RegisteredBot, "brand" | "appId">, scopes = addons.scopes.tenant): string {
  const host = config.brand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
  const params = new URLSearchParams({ clientID: config.appId, scopes: scopes.join(",") });
  return [
    "Open this official page to apply for the required bot permissions (sign in as an app administrator):",
    `https://${host}/page/scope-apply?${params}`,
    "Confirm the requested permissions and complete any required approval/publication. This link does not grant permissions automatically.",
    `Enable the bot, long-connection event im.message.receive_v1 and callback card.action.trigger in https://${host}/app/${encodeURIComponent(config.appId)}/event`,
    "No user OAuth login is needed. Listening starts only with /lark-bot on.",
  ].join("\n");
}

/** Read only: undefined means the check failed, never that permissions are granted. */
export async function missingBotPermissions(config: RegisteredBot, signal: AbortSignal): Promise<string[] | undefined> {
  const host = config.brand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
  const combined = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const get = async (path: string, init: RequestInit) => {
    const response = await fetch(`https://${host}/open-apis/${path}`, { ...init, signal: combined });
    const body = await response.json();
    if (!response.ok || body?.code !== 0) throw new Error("Permission check failed");
    return body;
  };
  try {
    const auth = await get("auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    if (typeof auth.tenant_access_token !== "string" || !auth.tenant_access_token) return undefined;
    const result = await get("application/v6/scopes", {
      headers: { authorization: `Bearer ${auth.tenant_access_token}` },
    });
    const scopes: unknown = result.data?.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => !scope || typeof scope.scope_name !== "string" ||
      !Number.isInteger(scope.grant_status) || !["tenant", "user"].includes(scope.scope_type))) return undefined;
    const granted = new Set(scopes.filter((scope) => scope.scope_type === "tenant" && scope.grant_status === 1)
      .map((scope) => scope.scope_name));
    return addons.scopes.tenant.filter((scope) => !granted.has(scope));
  } catch { return undefined; } // Never expose token responses, credentials or SDK errors.
}

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
  return gzipSync(JSON.stringify(addons)).toString("base64url");
}

async function request(baseUrl: string, values: Record<string, string>, signal: AbortSignal, deadlineSignal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) throw abortError();
  if (deadlineSignal?.aborted) throw new Error("Bot registration expired");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout, ...(deadlineSignal ? [deadlineSignal] : [])]);
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
    if (timeout.aborted) throw new Error("Bot registration request timed out");
    if (error instanceof DOMException && error.name === "AbortError") throw abortError();
    throw new Error("Bot registration returned invalid data");
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

async function wait(ms: number, signal: AbortSignal, deadlineSignal: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) throw new Error("Bot registration polling interval is invalid");
  try {
    await delay(Math.min(ms, 2_147_483_647), undefined, { signal: AbortSignal.any([signal, deadlineSignal]) });
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (deadlineSignal.aborted) throw new Error("Bot registration expired");
    throw error;
  }
}

/** Register a new bot app through the official Lark/Feishu device flow. */
export async function registerBot(options: RegisterBotOptions): Promise<RegisteredBot> {
  const { brand, allowExistingApp, signal, onUrl } = options;
  if (brand !== "feishu" && brand !== "lark") throw new Error("Unsupported registration brand");
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
  // Omitting createOnly lets the official page select an existing app.
  if (!allowExistingApp) url.searchParams.set("createOnly", "true");
  onUrl(url.toString(), expiresIn);

  const deadline = Date.now() + expiresIn * 1000;
  const deadlineSignal = AbortSignal.timeout(Math.ceil(expiresIn * 1000));
  let pollInterval = interval;
  while (Date.now() < deadline) {
    await wait(Math.min(pollInterval, Math.max(0, deadline - Date.now())), signal, deadlineSignal);
    const result = await request(baseUrl, { action: "poll", device_code: deviceCode }, signal, deadlineSignal);
    const info = result.user_info as Record<string, unknown> | undefined;
    if (info?.tenant_brand === "lark" && baseUrl !== `https://${DOMAINS.lark}`) {
      baseUrl = `https://${DOMAINS.lark}`;
      continue;
    }
    const appId = stringField(result.client_id);
    const appSecret = stringField(result.client_secret);
    if (appId && appSecret) return { appId, appSecret, brand: info?.tenant_brand === "lark" ? "lark" : brand };
    const errorCode = typeof result.error === "string" ? result.error : undefined;
    if (errorCode === "slow_down") pollInterval += 5000;
    else if (errorCode && errorCode !== "authorization_pending") throw safeError(errorCode);
  }
  throw new Error("Bot registration expired");
}
