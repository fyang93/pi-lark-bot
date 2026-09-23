import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { missingBotPermissions, permissionInstructions, registerBot } from "../src/registration.ts";

const originalFetch = globalThis.fetch;
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test("registers with begin, addon URL, pending poll, and returns credentials", async () => {
  const calls: { url: string; body: string }[] = [];
  let n = 0;
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    return ++n === 1 ? response({ verification_uri_complete: "https://open.feishu.cn/verify", device_code: "device", expires_in: 60, interval: 0.001 })
      : n === 2 ? response({ error: "authorization_pending" }, 400)
      : response({ client_id: "cli_new", client_secret: "secret", user_info: { open_id: "ou_owner", tenant_brand: "feishu" } }, 200);
  }) as typeof fetch;
  let shown = "";
  const result = await registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: (url) => { shown = url; } });
  assert.deepEqual(result, { appId: "cli_new", appSecret: "secret", brand: "feishu" });
  assert.equal(calls[0]!.body, "action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id");
  assert.match(shown, /createOnly=true/);
  const addons = JSON.parse(gunzipSync(Buffer.from(new URL(shown).searchParams.get("addons")!, "base64url")).toString("utf8"));
  assert.equal(addons.preset, false);
  assert.deepEqual(addons.events.items.tenant, ["im.message.receive_v1"]);
  assert(addons.scopes.tenant.includes("im:message.p2p_msg:readonly"));
  assert.equal(new URL(shown).hostname, "open.feishu.cn");
  const permissionUrl = new URL(permissionInstructions(result).split("\n")[1]!);
  assert.equal(permissionUrl.hostname, "open.feishu.cn");
  assert.equal(permissionUrl.pathname, "/page/scope-apply");
  assert.equal(permissionUrl.searchParams.get("clientID"), result.appId);
  assert.deepEqual(permissionUrl.searchParams.get("scopes")!.split(","), addons.scopes.tenant);
  assert(!permissionUrl.href.includes(result.appSecret));
});

test("permission checks distinguish tenant grants, missing grants and an unavailable check", async () => {
  const config = { brand: "lark" as const, appId: "cli_existing", appSecret: "private-secret" };
  const required = new URL(permissionInstructions(config).split("\n")[1]!).searchParams.get("scopes")!.split(",");
  let scopes: unknown = required.map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 }));
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "open.larksuite.com");
    assert(init?.signal);
    if (url.pathname.endsWith("/tenant_access_token/internal")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { app_id: config.appId, app_secret: config.appSecret });
      return response({ code: 0, tenant_access_token: "private-token" });
    }
    assert.equal(url.pathname, "/open-apis/application/v6/scopes");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-token");
    return response({ code: 0, data: { scopes } });
  }) as typeof fetch;
  const signal = new AbortController().signal;
  assert.deepEqual(await missingBotPermissions(config, signal), []);
  scopes = required.map((scope_name, index) => ({ scope_name, scope_type: index === 0 ? "user" : "tenant", grant_status: index === 1 ? 0 : 1 }));
  const missing = await missingBotPermissions(config, signal);
  assert.deepEqual(missing, required.slice(0, 2));
  const url = new URL(permissionInstructions(config, missing).split("\n")[1]!);
  assert.deepEqual(url.searchParams.get("scopes")!.split(","), missing);
  scopes = undefined;
  assert.equal(await missingBotPermissions(config, signal), undefined);
  globalThis.fetch = (async () => { throw new Error("private-secret"); }) as typeof fetch;
  assert.equal(await missingBotPermissions(config, signal), undefined);
});

test("connects an existing app through its QR authorization", async () => {
  let shown = "";
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return n === 1
      ? response({ verification_uri_complete: "https://open.feishu.cn/verify", device_code: "device", expires_in: 60, interval: 0.001 })
      : response({ client_id: "cli_existing", client_secret: "secret", user_info: { tenant_brand: "feishu" } });
  }) as typeof fetch;
  const result = await registerBot({ brand: "feishu", allowExistingApp: true, signal: new AbortController().signal, onUrl: (url) => { shown = url; } });
  assert.equal(result.appId, "cli_existing");
  const qrUrl = new URL(shown);
  assert.equal(qrUrl.searchParams.has("clientID"), false);
  assert.equal(qrUrl.searchParams.has("createOnly"), false);
});

test("switches to Lark polling domain", async () => {
  const urls: string[] = [];
  let n = 0;
  globalThis.fetch = (async (input) => {
    urls.push(String(input)); n++;
    return n === 1 ? response({ verification_uri_complete: "https://open.feishu.cn/v", device_code: "d", expires_in: 60, interval: 0.001 })
      : response(n === 2 ? { user_info: { tenant_brand: "lark" }, error: "authorization_pending" } : { client_id: "cli_l", client_secret: "s", user_info: { tenant_brand: "lark" } }, n === 2 ? 400 : 200);
  }) as typeof fetch;
  const result = await registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: () => {} });
  assert.equal(result.brand, "lark");
  assert.equal(urls[2]!.startsWith("https://accounts.larksuite.com/"), true);
});

test("surfaces denial and expiry without leaking response text", async () => {
  globalThis.fetch = (async () => response({ error: "access_denied", error_description: "secret=do-not-leak" }, 400)) as typeof fetch;
  await assert.rejects(registerBot({ brand: "lark", signal: new AbortController().signal, onUrl: () => {} }), (error: Error) => error.message === "Bot registration was denied" && !error.message.includes("do-not-leak"));
});

test("cancels before begin and while polling", async () => {
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = (async () => { throw new Error("must not call"); }) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: controller.signal, onUrl: () => {} }), /aborted/);

  const duringPoll = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    if (calls === 1) return response({ verification_uri_complete: "https://accounts.feishu.cn/v", device_code: "d", expires_in: 60, interval: 0.001 });
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    throw new Error("unreachable");
  }) as typeof fetch;
  const pending = registerBot({ brand: "feishu", signal: duringPoll.signal, onUrl: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  duringPoll.abort();
  await assert.rejects(pending, /aborted/);
});

test("cancels the polling delay without making a poll request", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return response({ verification_uri_complete: "https://accounts.feishu.cn/v", device_code: "d", expires_in: 60, interval: 30 });
  }) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: controller.signal,
    onUrl: () => { setImmediate(() => controller.abort()); },
  }), /aborted/);
  assert.equal(calls, 1);
});

test("expires without polling when the server gives an expired device code", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response({ verification_uri_complete: "https://accounts.feishu.cn/v", device_code: "d", expires_in: 0, interval: 0 }); }) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: () => {} }), /expired/);
  assert.equal(calls, 1);
});

test("keeps timeout active while reading the initial response body", async () => {
  const controller = new AbortController();
  let bodyAborted = false;
  globalThis.fetch = (async (_input, init) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => { bodyAborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true })),
  })) as typeof fetch;
  const pending = registerBot({ brand: "feishu", signal: controller.signal, onUrl: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(bodyAborted, true);
});

test("backs off after slow_down and rejects malformed or untrusted begin responses", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? response({ verification_uri_complete: "https://accounts.feishu.cn/v", device_code: "d", expires_in: 0.01, interval: 0.001 })
      : response({ error: "slow_down" }, 400);
  }) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: () => {} }), /expired/);
  assert.ok(calls >= 2);

  globalThis.fetch = (async () => response({ verification_uri_complete: "javascript:alert(1)", device_code: "d" })) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: () => {} }), /untrusted authorization URL/);

  globalThis.fetch = (async () => response({ nope: true })) as typeof fetch;
  await assert.rejects(registerBot({ brand: "feishu", signal: new AbortController().signal, onUrl: () => {} }), /incomplete authorization request/);
});
