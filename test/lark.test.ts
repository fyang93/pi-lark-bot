import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const calls: { create: any[]; reply: any[]; patch: any[]; get: any[]; resource: any[]; uploads: any[]; start: number; close: any[]; http: any[] } = {
    create: [], reply: [], patch: [], get: [], resource: [], uploads: [], start: 0, close: [], http: [],
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
  const file = { create: async (payload: unknown) => { calls.uploads.push(payload); return { file_key: "uploaded-file-key" }; } };
  class Client {
    constructor(options: any) { clientOptions = options; }
    im = { v1: { message: api, messageResource, file } };
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
    calls, api, messageResource, file, clientOptions: () => clientOptions, emit: async (event: unknown) => handler?.(event),
    ready: async () => { await startEvent; callbacks.onReady?.(); }, error: () => callbacks.onError?.(),
    reconnecting: () => callbacks.onReconnecting?.(), reconnected: () => callbacks.onReconnected?.(),
  };
}

const textEvent = { sender: { sender_type: "user", sender_id: { open_id: "ou_1" } }, message: {
  message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: '{"text":"hello"}',
} };

test("uploads and sends user-selected local files as native file messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-send-file-"));
  const outside = `${root}-outside.txt`;
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "out", "report.xlsx"), Buffer.from("workbook"));
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk, undefined, root);
  try {
    assert.equal(await transport.sendFile("oc_1", `sandbox:${join(root, "out", "report.xlsx")}`), "out-1");
    assert.deepEqual(fake.calls.uploads[0].data, {
      file_type: "xls", file_name: "report.xlsx", file: Buffer.from("workbook"),
    });
    assert.equal(fake.calls.create[0].data.msg_type, "file");
    assert.deepEqual(JSON.parse(fake.calls.create[0].data.content), { file_key: "uploaded-file-key" });
    await writeFile(outside, "user selected this file");
    assert.equal(await transport.sendFile("oc_1", outside), "out-1", "files outside the project are allowed when explicitly selected");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); }
});

test("waits for readiness, filters messages, handles reconnect, and force-closes", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  assert.equal(transport.state, "starting");
  await fake.ready();
  await starting;
  assert.equal(fake.clientOptions().domain, "https://open.larksuite.com");
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

test("accepts a standalone file and passes it as an attachment request", async () => {
  const fake = fakeSdk(); const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  await fake.ready(); await starting;
  try {
    await fake.emit({ ...textEvent, message: { ...textEvent.message, message_type: "file",
      content: JSON.stringify({ file_key: "file-key", file_name: "form.xlsx" }) } });
    assert.equal(received[0].text, "");
    assert.deepEqual(received[0].resourceReferences, [{ key: "file-key", name: "form.xlsx", type: "file", apiType: "file" }]);
  } finally { await transport.stop(); }
});

test("reports an unsupported post payload instead of treating it as an empty prompt", async () => {
  const fake = fakeSdk(); const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  await fake.ready(); await starting;
  try {
    await fake.emit({ ...textEvent, message: { ...textEvent.message, message_type: "post", content: JSON.stringify({ unknown: true }) } });
    assert.deepEqual(received[0], { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "(post content unavailable)", unsupported: "content" });
  } finally { await transport.stop(); }
});

test("parses Feishu flat posts with an uploaded file", async () => {
  const fake = fakeSdk(); const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  const starting = transport.start(async (message) => { received.push(message); });
  await fake.ready(); await starting;
  try {
    await fake.emit({ ...textEvent, message: { ...textEvent.message, message_type: "post", content: JSON.stringify({
      title: "", content: [[{ tag: "text", text: "帮我填一下", style: [] }]],
      files: [{ file_key: "file-key", file_name: "form.xlsx" }],
    }) } });
    assert.equal(received[0].text, "帮我填一下");
    assert.deepEqual(received[0].resourceReferences, [{ key: "file-key", name: "form.xlsx", type: "file", apiType: "file" }]);
  } finally { await transport.stop(); }
});

test("captures a reply parent and caches its file resource for the authorized controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-file-cache-"));
  const fake = fakeSdk();
  fake.api.get = async (payload: any) => {
    fake.calls.get.push(payload);
    return { code: 0, data: { items: [{ message_id: "om_file", chat_id: "oc_1", msg_type: "file",
      body: { content: JSON.stringify({ file_key: "file-key", file_name: "../report.csv", text: "quoted text" }) } }] } };
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
    assert.equal(prepared.quotedText, "quoted text");
    const attachment = prepared.attachments?.[0];
    assert.equal(attachment?.name, "report.csv");
    assert(attachment?.status === "ready");
    assert.equal(await readFile(attachment.path, "utf8"), "a,b\n1,2");
    assert.deepEqual(fake.calls.resource[0], { path: { message_id: "om_file", file_key: "file-key" }, params: { type: "file" } });
    await transport.prepareMessage(received[0]);
    assert.equal(fake.calls.resource.length, 1, "the second reference reuses the persistent cache");
  } finally { await transport.stop(); await rm(root, { recursive: true, force: true }); }
});

test("quoted posts reuse the normal parser for text and embedded resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-quoted-post-"));
  try {
    for (const wrapped of [false, true]) {
      const fake = fakeSdk();
      const post = { title: "Report", content: [[{ tag: "text", text: "Body" },
        { tag: "img", image_key: "quoted-image" }, { tag: "file", file_key: "quoted-file", file_name: "report.csv" }]] };
      fake.api.get = async () => ({ code: 0, data: { items: [{ message_id: "parent", chat_id: "oc_1", msg_type: "post",
        body: { content: JSON.stringify(wrapped ? { zh_cn: post } : post) } }] } });
      fake.messageResource.get = async (payload: any) => {
        fake.calls.resource.push(payload);
        return { headers: {}, getReadableStream: () => Readable.from([Buffer.from("data")]) };
      };
      const transport = new LarkTransport(config, undefined, fake.sdk, join(root, String(wrapped)));
      const prepared = await transport.prepareMessage({ id: "reply", userId: "ou_1", chatId: "oc_1", text: "explain", parentMessageId: "parent" });
      assert.match(prepared.quotedText!, /Report\nBody/);
      assert.equal(prepared.attachments?.length, 2);
      assert(prepared.attachments!.every((file) => file.status === "ready" && file.sourceMessageId === "parent"));
      assert.deepEqual(fake.calls.resource.map((call) => call.path.file_key), ["quoted-image", "quoted-file"]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reply attachments survive both quoted attachments and an unreadable parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-reply-attachments-"));
  try {
    for (const kind of ["text", "file", "missing", "invalid", "other-chat", "error"]) {
      const fake = fakeSdk();
      fake.api.get = async () => {
        if (kind === "error") throw new Error("private error");
        return { code: 0, data: { items: kind === "missing" ? [] : [{ message_id: "parent",
          chat_id: kind === "other-chat" ? "oc_other" : "oc_1", msg_type: kind,
          body: { content: kind === "invalid" ? "invalid json" : JSON.stringify({ text: "Old message", file_key: "old-file", file_name: "old.txt" }) } }] } };
      };
      fake.messageResource.get = async (payload: any) => {
        fake.calls.resource.push(payload);
        return { headers: {}, getReadableStream: () => Readable.from([Buffer.from("data")]) };
      };
      const transport = new LarkTransport(config, undefined, fake.sdk, join(root, kind));
      const prepared = await transport.prepareMessage({ id: "reply", userId: "ou_1", chatId: "oc_1", text: "analyze", parentMessageId: "parent",
        resourceReferences: [{ key: "new-image", name: "image.bin", type: "image", apiType: "image" }] });
      assert.equal(prepared.attachments?.[0]?.status, "ready");
      assert.equal(prepared.attachments?.[0]?.sourceMessageId, "reply");
      assert.deepEqual(fake.calls.resource[0].path, { message_id: "reply", file_key: "new-image" });
      if (kind === "file") {
        assert.equal(prepared.attachments?.length, 2);
        assert.deepEqual(fake.calls.resource[1].path, { message_id: "parent", file_key: "old-file" });
      } else assert.equal(prepared.attachments?.length, 1);
      if (!["text", "file"].includes(kind)) assert.equal(prepared.preparationWarning, "referenced_message_unavailable");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extracts quoted text from an interactive card reply", async () => {
  const fake = fakeSdk();
  const report = "美股持仓复核完成｜账户权益约$84.55k。邮轮主题集中度约18.2%。";
  fake.api.get = async () => ({ code: 0, data: { items: [{ message_id: "om_card", chat_id: "oc_1", msg_type: "interactive",
    body: { content: JSON.stringify({ config: {}, elements: [{ tag: "markdown", content: report }] }) } }] } });
  const transport = new LarkTransport(config, undefined, fake.sdk);
  try {
    const prepared = await transport.prepareMessage({ id: "reply", userId: "ou_1", chatId: "oc_1", text: "邮轮是什么？", parentMessageId: "om_card" });
    assert.equal(prepared.quotedText, report);
  } finally { await transport.stop(); }
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
  await assert.rejects(failedStart, /Lark 连接失败/);
  assert.equal(failedTransport.state, "stopped");
  assert.deepEqual(failed.calls.close, [{ force: true }]);

  const stopped = fakeSdk();
  const stoppedTransport = new LarkTransport(config, undefined, stopped.sdk);
  const stoppedStart = stoppedTransport.start(async () => {});
  await stoppedTransport.stop();
  await assert.rejects(stoppedStart, /Lark 连接已停止/);
  assert.equal(stoppedTransport.state, "stopped");
  assert.deepEqual(stopped.calls.close, [{ force: true }]);
});

test("times out an initial handshake and force-closes", async (t) => {
  (t.mock.timers as any).enable({ apis: ["setTimeout"] });
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const starting = transport.start(async () => {});
  (t.mock.timers as any).tick(30_000);
  await assert.rejects(starting, /Lark 连接超时/);
  assert.equal(transport.state, "stopped");
  assert.deepEqual(fake.calls.close, [{ force: true }]);
});

test("Markdown tables use JSON 2.0 cards for sends, replies and updates, and remain quotable", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const text = "| 项目 | 状态 |\n| --- | --- |\n| 表格 | 支持 |";
  const expected = { schema: "2.0", config: { width_mode: "fill" },
    body: { elements: [{ tag: "markdown", content: text }] } };
  await transport.send("oc_1", text);
  await transport.send("oc_1", text, "om_1");
  await transport.update("out-1", text);
  for (const payload of [fake.calls.create[0], fake.calls.reply[0], fake.calls.patch[0]]) {
    assert.deepEqual(JSON.parse(payload.data.content), expected);
  }
  // The real API's default response is not the JSON used to send the card.
  fake.api.get = async (payload: any) => {
    fake.calls.get.push(payload);
    return { code: 0, data: { items: [{ message_id: "out-1", chat_id: "oc_1", msg_type: "interactive",
      body: { content: payload.params?.card_msg_content_type === "user_card_content"
        ? fake.calls.patch[0].data.content
        : JSON.stringify({ elements: [{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }] }) } }] } };
  };
  const prepared = await transport.prepareMessage({ id: "reply", userId: "ou_1", chatId: "oc_1",
    text: "解释表格", parentMessageId: "out-1" });
  assert.equal(prepared.quotedText, text);
  assert.deepEqual(fake.calls.get[0], { path: { message_id: "out-1" },
    params: { card_msg_content_type: "user_card_content" } });
});

test("Markdown images without an image key degrade to text so the card is not rejected", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  await transport.update("out-1", [
    "![二维码](/home/u/auth.png)", "![](https://example.com/a.png \"t\")", "![ok](img_v3_02ad_abc-1)",
    "```md\n![raw](/keep.png)\n```",
  ].join("\n"));
  assert.equal(JSON.parse(fake.calls.patch[0].data.content).body.elements[0].content, [
    "🖼️ 二维码（/home/u/auth.png）", "[图片](https://example.com/a.png)", "![ok](img_v3_02ad_abc-1)",
    "```md\n![raw](/keep.png)\n```",
  ].join("\n"));
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
  assert.equal(JSON.parse(create.data.content).body.elements[0].content, "progress");
  assert.equal(fake.calls.reply[0].path.message_id, "om_1");
  assert.notEqual(fake.calls.reply[0].data.uuid, create.data.uuid);
  assert.equal(fake.calls.patch[0].path.message_id, "out-1");
  const customCard = { schema: "2.0", body: { elements: [] } };
  assert.equal(await transport.sendCard("oc_1", customCard), "out-1");
  assert.equal(await transport.sendCard("oc_1", customCard, "om_2"), "out-2");
  assert.deepEqual(JSON.parse(fake.calls.create[1].data.content), customCard);
  assert.deepEqual(JSON.parse(fake.calls.reply[1].data.content), customCard);
  assert.equal(fake.calls.reply[1].path.message_id, "om_2");
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
  await assert.rejects(transport.send("oc_1", "x"), /Lark 接口请求失败/);
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

test("real SDK discovers the alternate WS region and reuses it without changing the brand or REST domain", async () => {
  const fake = fakeSdk();
  const requests: any[] = [];
  (fake.sdk as any).defaultHttpInstance.request = async (options: any) => {
    requests.push(options);
    return options.url.startsWith("https://open.larksuite.com")
      ? { code: 1000040351, msg: "Incorrect domain name", data: {} }
      : { code: 0, data: { URL: "wss://example.invalid/ws?device_id=1&service_id=2", ClientConfig: {} } };
  };
  new LarkTransport(config, undefined, fake.sdk);
  const ws = new ActualLark.WSClient(fake.clientOptions());
  try {
    assert.equal((await (ws as any).pullConnectConfig()).ok, true);
    assert.equal((await (ws as any).pullConnectConfig()).ok, true);
    assert.deepEqual(requests.map((request) => request.url), [
      "https://open.larksuite.com/callback/ws/endpoint",
      "https://open.feishu.cn/callback/ws/endpoint",
      "https://open.feishu.cn/callback/ws/endpoint",
    ]);
    assert(requests.every((request) => request.data.AppID === config.appId && request.data.AppSecret === config.appSecret));
    assert(requests.every((request) => request.timeout === 10_000));
    assert.equal(config.brand, "lark");
    assert.equal(fake.clientOptions().domain, "https://open.larksuite.com");
  } finally { ws.close({ force: true }); }
});

test("WS region fallback is bidirectional, bounded, and excludes other errors and REST calls", async () => {
  const fake = fakeSdk();
  const urls: string[] = [];
  let code = 1000040351;
  let networkFailure = false;
  (fake.sdk as any).defaultHttpInstance.request = async (options: any) => {
    urls.push(options.url);
    if (networkFailure) throw new Error("network failure");
    return { code };
  };
  new LarkTransport({ ...config, brand: "feishu" }, undefined, fake.sdk);
  const http = fake.clientOptions().httpInstance;
  const endpoint = "https://open.feishu.cn/callback/ws/endpoint";
  assert.deepEqual(await http.request({ url: endpoint }), { code });
  assert.deepEqual(urls.splice(0), [endpoint, "https://open.larksuite.com/callback/ws/endpoint"], "both domains fail: only one retry");
  code = 1000040343;
  assert.deepEqual(await http.request({ url: endpoint }), { code });
  assert.deepEqual(urls.splice(0), [endpoint], "do not retry credentials/permission errors");
  networkFailure = true;
  await assert.rejects(http.request({ url: endpoint }), /network failure/);
  assert.deepEqual(urls.splice(0), [endpoint]);
  networkFailure = false;
  code = 1000040351;
  const rest = "https://open.feishu.cn/open-apis/bot/v3/info";
  await http.request({ url: rest });
  assert.deepEqual(urls.splice(0), [rest], "do not reroute REST calls");
  code = 0;
  await http.request({ url: endpoint });
  assert.deepEqual(urls.splice(0), [endpoint], "normal Feishu connections are unchanged");
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
