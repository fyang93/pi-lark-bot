import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as ActualLark from "@larksuiteoapi/node-sdk";
import { LarkTransport, type LarkSdk } from "../src/lark.ts";
import type { BotConfig } from "../src/types.ts";

const config: BotConfig = { version: 1, brand: "lark", appId: "cli_123", appSecret: "secret" };

function fakeSdk() {
  let handler: ((event: unknown) => Promise<void>) | undefined;
  let clientOptions: any;
  const calls: { create: any[]; reply: any[]; patch: any[]; get: any[]; resource: any[]; start: number; close: any[]; http: any[] } = {
    create: [], reply: [], patch: [], get: [], resource: [], start: 0, close: [], http: [],
  };
  let callbacks: Record<string, (() => void) | undefined> = {};
  let started!: () => void;
  const startEvent = new Promise<void>((resolve) => { started = resolve; });
  const api: any = {
    create: async (payload: unknown) => { calls.create.push(payload); return { code: 0, data: { message_id: "out-1" } }; },
    reply: async (payload: unknown) => { calls.reply.push(payload); return { code: 0, data: { message_id: "out-2" } }; },
    patch: async (payload: unknown) => { calls.patch.push(payload); return { code: 0, data: {} }; },
    get: async (payload: unknown) => { calls.get.push(payload); return { code: 0, data: { items: [] } }; },
  };
  const messageResource = {
    get: async (payload: unknown) => { calls.resource.push(payload); return { headers: {}, getReadableStream: () => Readable.from([]) }; },
  };
  class Client {
    constructor(options: any) { clientOptions = options; }
    im = { v1: { message: api, messageResource } };
    async request(payload: any) { assert.equal(payload.url, "/open-apis/bot/v3/info"); return { code: 0, bot: { open_id: "ou_bot" } }; }
  }
  class EventDispatcher { constructor(_options?: any) {} register(handles: any) { handler = handles["im.message.receive_v1"]; } }
  class WSClient {
    constructor(options: any) { callbacks = options; }
    async start(_options: any) { calls.start++; started(); }
    close(options?: any) { calls.close.push(options); }
  }
  const defaultHttpInstance = {
    request: async (options: any) => { calls.http.push(options); return {}; },
    post: async (url: string, data: any, options: any) => { calls.http.push({ url, data, ...options }); return {}; },
  };
  return {
    sdk: { Client, EventDispatcher, WSClient, defaultHttpInstance, Domain: { Feishu: "feishu", Lark: "lark" } } as unknown as LarkSdk,
    calls, api, messageResource, clientOptions: () => clientOptions, emit: async (event: unknown) => handler?.(event),
    ready: async () => { await startEvent; callbacks.onReady?.(); }, error: () => callbacks.onError?.(),
    reconnecting: () => callbacks.onReconnecting?.(), reconnected: () => callbacks.onReconnected?.(),
  };
}

const textEvent = { sender: { sender_type: "user", sender_id: { open_id: "ou_1" } }, message: {
  message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: '{"text":"hello"}',
} };

test("waits for readiness, filters messages, handles reconnect, and force-closes", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  assert.equal(transport.state, "starting");
  await fake.ready();
  await starting;
  assert.equal(transport.state, "connected");
  fake.reconnecting();
  assert.equal(transport.state, "reconnecting");
  fake.reconnected();
  assert.equal(transport.state, "connected");
  await fake.emit(textEvent);
  await fake.emit({ ...textEvent, sender: { sender_type: "bot", sender_id: { open_id: "ou_2" } } });
  await fake.emit({ ...textEvent, message: { ...textEvent.message, content: "not json" } });
  await fake.emit({ ...textEvent, message: { ...textEvent.message, chat_type: "group" } });
  assert.deepEqual(received, [
    { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "hello" },
    // Unreadable content in a direct chat is still addressed to the bot.
    { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "(unparsable)", unsupported: "content" },
  ], "only a group message with no bot mention is dropped outright");
  await transport.stop();
  assert.deepEqual(fake.calls.close, [{ force: true }]);
  assert.equal(transport.state, "stopped");
});

test("groups require a real bot mention; an addressed but empty prompt is answered, not ignored", async () => {
  const fake = fakeSdk(); const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  await fake.ready(); await starting;
  try {
    const event = { ...textEvent, message: { ...textEvent.message, chat_type: "group",
      content: JSON.stringify({ text: "@_user_1 hello" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } };
    await fake.emit(event);
    await fake.emit({ ...event, message: { ...event.message, mentions: [] } });
    await fake.emit({ ...event, message: { ...event.message, mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }] } });
    await fake.emit({ ...event, message: { ...event.message, content: JSON.stringify({ text: "@_user_1" }) } });
    assert.deepEqual(received, [
      { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "hello", chatType: "group", mentionedBot: true },
      // A bare mention reaches the controller so it can say what is missing.
      { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "(empty)", unsupported: "empty_text", chatType: "group", mentionedBot: true },
    ]);
  } finally { await transport.stop(); }
});

test("captures a reply parent and caches its file resource for the authorized controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-file-cache-"));
  const fake = fakeSdk();
  fake.api.get = async (payload: any) => {
    fake.calls.get.push(payload);
    return { code: 0, data: { items: [{ message_id: "om_file", chat_id: "oc_1", msg_type: "file",
      body: { content: JSON.stringify({ file_key: "file-key", file_name: "../report.csv" }) } }] } };
  };
  fake.messageResource.get = async (payload: any) => {
    fake.calls.resource.push(payload);
    return { headers: { "content-length": "7" }, getReadableStream: () => Readable.from([Buffer.from("a,b\n1,2")]) };
  };
  const transport = new LarkTransport(config, undefined, fake.sdk, root);
  const received: any[] = [];
  try {
    const starting = transport.start(async (message) => { received.push(message); });
    await fake.ready(); await starting;
    await fake.emit({ ...textEvent, message: { ...textEvent.message, parent_id: "om_file" } });
    assert.equal(received[0].parentMessageId, "om_file");
    const prepared = await transport.prepareMessage(received[0]);
    const attachment = prepared.attachments?.[0];
    assert.equal(attachment?.name, "report.csv");
    assert(attachment?.status === "ready");
    assert.equal(await readFile(attachment.path, "utf8"), "a,b\n1,2");
    assert.deepEqual(fake.calls.resource[0], { path: { message_id: "om_file", file_key: "file-key" }, params: { type: "file" } });
    await transport.prepareMessage(received[0]);
    assert.equal(fake.calls.resource.length, 1, "the second reference reuses the persistent cache");
  } finally { await transport.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a quoted attachment download failure is isolated from the text request", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-file-failure-"));
  const fake = fakeSdk();
  fake.api.get = async () => ({ code: 0, data: { items: [{ message_id: "om_image", chat_id: "oc_1", msg_type: "image",
    body: { content: JSON.stringify({ image_key: "img-key" }) } }] } });
  fake.messageResource.get = async () => { throw new Error("secret SDK detail"); };
  const transport = new LarkTransport(config, undefined, fake.sdk, root);
  try {
    const prepared = await transport.prepareMessage({ ...textEvent.message, id: "request", userId: "ou_1", chatId: "oc_1",
      text: "analyze it", parentMessageId: "om_image" });
    assert.deepEqual(prepared.attachments, [{ status: "failed", type: "image", name: "image.bin",
      sourceMessageId: "om_image", error: "download_failed" }]);
    assert(!JSON.stringify(prepared).includes("secret SDK detail"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a pending start on SDK failure or explicit stop and cleans up", async () => {
  const failed = fakeSdk();
  const failedTransport = new LarkTransport(config, undefined, failed.sdk);
  const failedStart = failedTransport.start(async () => {});
  failed.error();
  await assert.rejects(failedStart, /Lark connection failed/);
  assert.equal(failedTransport.state, "stopped");
  assert.deepEqual(failed.calls.close, [{ force: true }]);

  const stopped = fakeSdk();
  const stoppedTransport = new LarkTransport(config, undefined, stopped.sdk);
  const stoppedStart = stoppedTransport.start(async () => {});
  await stoppedTransport.stop();
  await assert.rejects(stoppedStart, /Lark connection was stopped/);
  assert.equal(stoppedTransport.state, "stopped");
  assert.deepEqual(stopped.calls.close, [{ force: true }]);
});

test("times out an initial handshake and force-closes", async (t) => {
  (t.mock.timers as any).enable({ apis: ["setTimeout"] });
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const starting = transport.start(async () => {});
  (t.mock.timers as any).tick(30_000);
  await assert.rejects(starting, /Lark connection timed out/);
  assert.equal(transport.state, "stopped");
  assert.deepEqual(fake.calls.close, [{ force: true }]);
});

test("uses idempotent create/reply/patch cards and bounded HTTP/retries", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  assert.equal(await transport.send("oc_1", "progress"), "out-1");
  assert.equal(await transport.send("oc_1", "reply", "om_1"), "out-2");
  await transport.update("out-1", "updated");
  const create = fake.calls.create[0];
  assert.deepEqual(create.params, { receive_id_type: "chat_id" });
  assert.equal(create.data.receive_id, "oc_1");
  assert.equal(create.data.msg_type, "interactive");
  assert.match(create.data.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(create.data.content).elements[0].content, "progress");
  assert.equal(fake.calls.reply[0].path.message_id, "om_1");
  assert.equal(fake.calls.reply[0].data.uuid, fake.calls.reply[0].data.uuid);
  assert.equal(fake.calls.patch[0].path.message_id, "out-1");
  await fake.clientOptions().httpInstance.request({ timeout: 50_000, url: "token" });
  assert.equal(fake.calls.http[0].timeout, 10_000);

  let attempts = 0;
  const retriedUuids: string[] = [];
  (transport as any).client.im.v1.message.create = async (payload: any) => {
    retriedUuids.push(payload.data.uuid);
    return ++attempts < 3 ? { code: 90002 } : { code: 0, data: { message_id: "retried" } };
  };
  assert.equal(await transport.send("oc_1", "x"), "retried");
  assert.equal(attempts, 3);
  assert.equal(new Set(retriedUuids).size, 1);

  attempts = 0;
  (transport as any).client.im.v1.message.create = async () => { attempts++; return { code: 12345, data: { message_id: "bad" } }; };
  await assert.rejects(transport.send("oc_1", "x"), /Lark API request failed/);
  assert.equal(attempts, 1);
});

test("real SDK Client sends tenant-token and message HTTP through the timeout wrapper", async () => {
  const fake = fakeSdk();
  const rawCalls: any[] = [];
  let messageRequests = 0;
  (fake.sdk as any).defaultHttpInstance = {
    request: async (options: any) => {
      rawCalls.push(options);
      if (++messageRequests === 1) throw new Error("temporary HTTP failure, secret details must not leak");
      return { code: 0, data: { message_id: "from-real-sdk" } };
    },
    post: async (url: string, data: any, options: any) => {
      rawCalls.push({ url, data, ...options });
      return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
    },
  };
  const sdk = { ...fake.sdk, Client: ActualLark.Client } as unknown as LarkSdk;
  const transport = new LarkTransport(config, undefined, sdk);
  assert.equal(await transport.send("oc_1", "hello"), "from-real-sdk");
  assert.ok(rawCalls.some((call) => String(call.url).includes("tenant_access_token")));
  assert.ok(rawCalls.some((call) => String(call.url).includes("/im/v1/messages")));
  assert.ok(rawCalls.every((call) => call.timeout === 10_000));
  assert.equal(messageRequests, 2);
  const sends = rawCalls.filter((call) => String(call.url).includes("/im/v1/messages"));
  assert.equal(sends[0].data.uuid, sends[1].data.uuid);
});

test("the WebSocket client is constructed exactly as the shipping version did", async () => {
  let wsOptions: any, clientOptions: any;
  const fake = fakeSdk();
  const sdk = {
    ...fake.sdk,
    Client: class { constructor(options: any) { clientOptions = options; } im = {} as any;
      async request() { return { code: 0, bot: { open_id: "ou_bot" } }; } },
    WSClient: class { constructor(options: any) { wsOptions = options; } async start() {} close() {} },
  } as unknown as LarkSdk;
  new LarkTransport(config, undefined, sdk);

  // Every option the SDK sees matches v0.1.0. Messages went missing each time
  // this construction was "improved", so it is pinned rather than reasoned about.
  assert.equal(wsOptions.httpInstance, clientOptions.httpInstance);
  assert.equal(wsOptions.loggerLevel, 0);
  assert.equal(wsOptions.logger, clientOptions.logger);
  assert.equal(typeof wsOptions.handshakeTimeoutMs, "number");
});

test("a mention of the bot is stripped in a direct chat too, so commands survive it", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  await fake.ready(); await starting;
  try {
    // Tapping the bot's avatar in a direct chat puts a placeholder key in the
    // text. Left in place it hides "/new" from the command parser, and the
    // model answers instead of the session being reset.
    await fake.emit({ ...textEvent, message: { ...textEvent.message,
      content: JSON.stringify({ text: "@_user_1 /new" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } });
    // Someone else's mention is the sender's own text and stays untouched.
    await fake.emit({ ...textEvent, message: { ...textEvent.message, message_id: "om_2",
      content: JSON.stringify({ text: "@_user_1 看看" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }] } });
    assert.deepEqual(received.map((m) => m.text), ["/new", "@_user_1 看看"]);
  } finally { await transport.stop(); }
});
