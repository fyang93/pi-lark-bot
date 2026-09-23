import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LarkTransport, type LarkSdk } from "../src/lark.ts";
import type { BotConfig } from "../src/types.ts";

const config: BotConfig = { version: 1, brand: "lark", appId: "cli_123", appSecret: "secret" };

/**
 * The SDK channel owns the connection, mention matching and normalization, so
 * this double only has to behave like the channel: deliver normalized messages
 * and record what was sent.
 */
function fakeSdk() {
  let options: any;
  let handlers: Record<string, (...args: any[]) => any> = {};
  const calls: { sent: any[]; edited: any[]; cards: any[]; connect: number; disconnect: number; get: any[]; resource: any[] } = {
    sent: [], edited: [], cards: [], connect: 0, disconnect: 0, get: [], resource: [],
  };
  const api: any = {
    get: async (payload: unknown) => { calls.get.push(payload); return { code: 0, data: { items: [] } }; },
  };
  const messageResource = {
    get: async (payload: unknown) => { calls.resource.push(payload); return { headers: {}, getReadableStream: () => Readable.from([]) }; },
  };
  let failConnect: Error | undefined;
  const channel = {
    rawClient: { im: { v1: { message: api, messageResource } } },
    async connect() { calls.connect++; if (failConnect) throw failConnect; },
    async disconnect() { calls.disconnect++; },
    on(next: Record<string, (...args: any[]) => any>) { handlers = { ...handlers, ...next }; return () => {}; },
    async send(to: string, input: any, opts?: any) { calls.sent.push({ to, input, opts }); return { messageId: `out-${calls.sent.length}` }; },
    async editMessage(messageId: string, text: string) { calls.edited.push({ messageId, text }); },
    async updateCard(messageId: string, card: object) { calls.cards.push({ messageId, card }); },
  };
  return {
    sdk: { createLarkChannel: (value: any) => { options = value; return channel; },
      Domain: { Feishu: "feishu", Lark: "lark" }, LoggerLevel: { warn: 2 } } as unknown as LarkSdk,
    calls, api, messageResource, channel,
    options: () => options,
    emit: (message: unknown) => handlers.message?.(message),
    cardAction: (event: unknown) => handlers.cardAction?.(event),
    reject: (event: unknown) => handlers.reject?.(event),
    failConnect(error: Error) { failConnect = error; },
  };
}

const message = { messageId: "om_1", chatId: "oc_1", chatType: "p2p", senderId: "ou_1", content: "hello", rawContentType: "text" };

test("the channel is configured for mentions and otherwise left at its defaults", async () => {
  const fake = fakeSdk();
  new LarkTransport(config, undefined, fake.sdk);
  const options = fake.options();
  assert.equal(options.transport, "websocket");
  assert.deepEqual(options.policy, { dmMode: "open", requireMention: true });
  assert.equal(options.domain, "lark", "the brand picks the endpoint");
  assert.equal(options.safety, undefined, "the channel's own safety defaults are left alone");
  assert.equal(options.loggerLevel, undefined, "and so is its logging level");
});

test("connects, maps direct and group messages, then disconnects", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  assert.equal(transport.state, "stopped");
  await transport.start(async (value) => { received.push(value); });
  assert.equal(transport.state, "connected");
  assert.equal(fake.calls.connect, 1);

  await fake.emit(message);
  await fake.emit({ ...message, messageId: "om_2", chatType: "group", content: "build it", replyToMessageId: "om_parent" });
  assert.deepEqual(received, [
    { id: "om_1", userId: "ou_1", chatId: "oc_1", text: "hello" },
    { id: "om_2", userId: "ou_1", chatId: "oc_1", text: "build it",
      parentMessageId: "om_parent", chatType: "group", mentionedBot: true },
  ]);

  await transport.stop();
  assert.equal(transport.state, "stopped");
  assert.equal(fake.calls.disconnect, 1);
  await fake.emit({ ...message, messageId: "om_late" });
  assert.equal(received.length, 2, "a stopped transport ignores late deliveries");
});

test("an addressed message with nothing runnable travels on with its reason", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  const received: any[] = [];
  await transport.start(async (value) => { received.push(value); });
  try {
    await fake.emit({ ...message, messageId: "om_img", content: "", rawContentType: "image", resources: [{ type: "image" }] });
    await fake.emit({ ...message, messageId: "om_bare", content: "   ", rawContentType: "text" });
    assert.deepEqual(received.map((value) => [value.id, value.text, value.unsupported]), [
      ["om_img", "(image)", "message_type"],
      ["om_bare", "(text)", "empty_text"],
    ]);
  } finally { await transport.stop(); }
});

test("sends markdown, edits in place, and passes cards through", async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, undefined, fake.sdk);
  await transport.start(async () => {});
  try {
    assert.equal(await transport.send("oc_1", "hi"), "out-1");
    assert.equal(await transport.send("oc_1", "quoted", "om_1"), "out-2");
    assert.equal(await transport.sendCard("oc_1", { tag: "picker" }), "out-3");
    await transport.update("out-1", "updated");
    await transport.updateCard("out-3", { tag: "chosen" });
    assert.deepEqual(fake.calls.sent, [
      { to: "oc_1", input: { markdown: "hi" }, opts: undefined },
      { to: "oc_1", input: { markdown: "quoted" }, opts: { replyTo: "om_1" } },
      { to: "oc_1", input: { card: { tag: "picker" } }, opts: undefined },
    ]);
    assert.deepEqual(fake.calls.edited, [{ messageId: "out-1", text: "updated" }]);
    assert.deepEqual(fake.calls.cards, [{ messageId: "out-3", card: { tag: "chosen" } }]);
  } finally { await transport.stop(); }
});

test("card actions reach the handler; a refused connection leaves the transport stopped", async () => {
  const fake = fakeSdk();
  const errors: string[] = [];
  const transport = new LarkTransport(config, (error) => errors.push(error.message), fake.sdk);
  const actions: any[] = [];
  transport.setCardActionHandler(async (messageId, chatId, operatorId, value) => { actions.push({ messageId, chatId, operatorId, value }); });
  await transport.start(async () => {});
  await fake.cardAction({ messageId: "om_card", chatId: "oc_1", operator: { openId: "ou_9" }, action: { value: { key: "x" } } });
  assert.deepEqual(actions, [{ messageId: "om_card", chatId: "oc_1", operatorId: "ou_9", value: { key: "x" } }]);
  // A policy decision by the channel is reported, so silence never looks like loss.
  fake.reject({ reason: "not_mentioned" });
  assert(errors.some((text) => text.includes("not_mentioned")));
  await transport.stop();

  const refused = fakeSdk();
  refused.failConnect(new Error("handshake refused"));
  const failing = new LarkTransport(config, undefined, refused.sdk);
  await assert.rejects(failing.start(async () => {}), /handshake refused/);
  assert.equal(failing.state, "stopped");
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
    await transport.start(async (value) => { received.push(value); });
    await fake.emit({ ...message, replyToMessageId: "om_file" });
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
    const prepared = await transport.prepareMessage({ id: "request", userId: "ou_1", chatId: "oc_1",
      text: "analyze it", parentMessageId: "om_image" });
    assert.deepEqual(prepared.attachments, [{ status: "failed", type: "image", name: "image.bin",
      sourceMessageId: "om_image", error: "download_failed" }]);
    assert(!JSON.stringify(prepared).includes("secret SDK detail"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

