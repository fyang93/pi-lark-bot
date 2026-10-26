import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotController } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, ModelSpec, WorkerFactory } from "../src/types.ts";

class Transport implements BotTransport {
  sent: string[] = [];
  async start() {}
  async stop() {}
  async send(_chat: string, text: string) { this.sent.push(text); return `m_${this.sent.length}`; }
  async update() {}
}

function message(id: string, text: string, userId = "ou_user", chatId = `chat_${userId}`): IncomingMessage {
  return { id, text, userId, chatId };
}

test("/new and /model are scoped to the sender's DM or the current group", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lark-commands-"));
  const resets: string[] = [], models: Array<{ key: string; model: string }> = [];
  const selections = new Map<string, ModelSpec>();
  const workers: WorkerFactory = {
    async open() { throw new Error("commands must not create a normal prompt worker"); },
    async reset(key) { resets.push(key); selections.delete(key); },
    async getModel(key) { return selections.get(key); },
    async setModel(key, model) { selections.set(key, model); models.push({ key, model: `${model.provider}/${model.id}` }); },
    async close() {},
  };
  const transport = new Transport();
  const bot = new BotController({
    config: { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" }, stateDir, transport, workers,
    defaultModel: { provider: "openai", id: "default" },
    availableModels: [{ provider: "openai", id: "default" }, { provider: "openai", id: "fast" }],
  });
  try {
    await bot.start();
    await bot.receive(message("dm-new", "/new", "ou_alice"));
    await bot.receive({ ...message("group-new", "/new", "ou_bob", "oc_team"), chatType: "group", mentionedBot: true });
    await bot.receive(message("model", "/model openai/fast", "ou_alice"));
    await bot.receive(message("models", "/model", "ou_alice"));
    await bot.drain();
    assert.deepEqual(resets, ["ou_alice", "group:oc_team"]);
    assert.deepEqual(models, [{ key: "ou_alice", model: "openai/fast" }]);
    assert(transport.sent.includes("已开启新的 Pi 会话。"));
    assert(transport.sent.some((text) => text.includes("当前模型：openai/fast") && text.includes("openai/default")));
  } finally { await bot.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test("queued model callbacks wait for handoff and recheck revoked authorization", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lark-card-queue-"));
  let release!: () => void, began!: () => void, changes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { began = resolve; });
  const transport = Object.assign(new Transport(), { async sendCard() { return "picker"; }, async updateCard() {} });
  const bot = new BotController({
    config: { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" }, stateDir, transport,
    availableModels: [{ provider: "p", id: "fast" }], authorizeUser: async () => true,
    workers: {
      async open() { return { async run() { began(); await gate; }, async close() {} }; },
      async setModel() { changes++; }, async close() { release(); },
    },
  });
  try {
    await bot.start(); await bot.receive(message("picker", "/model", "ou_owner000")); await bot.drain();
    await bot.receive(message("busy", "work", "ou_owner000")); await started;
    const action = bot.handleModelCardAction("picker", "chat_ou_owner000", "ou_owner000", { action: "set_model", key: "p/fast" });
    await Promise.resolve();
    assert.equal(bot.status.queued, 2, "the callback shares the chat's handoff queue");
    await bot.deny("ou_owner000");
    assert.equal(changes, 0, "the callback must not close a worker during handoff");
    release(); await action; await bot.drain();
    assert.equal(changes, 0, "authorization is checked again when the queued callback runs");
  } finally { release(); await bot.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test("model cards require a live listener, an authorized operator and the correct private owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lark-card-auth-"));
  let cards = 0, updates = 0, changes = 0, approvals = 0;
  const transport = Object.assign(new Transport(), {
    async sendCard() { return `card_${++cards}`; },
    async updateCard() { updates++; },
  });
  const bot = new BotController({
    config: { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" }, stateDir, transport,
    availableModels: [{ provider: "p", id: "fast" }],
    authorizeUser: async () => { approvals++; return true; },
    workers: { async open() { throw new Error("unused"); }, async setModel() { changes++; }, async close() {} },
  });
  const choose = { action: "set_model", key: "p/fast" };
  try {
    await bot.start();
    await bot.receive({ ...message("group", "/model", "ou_owner000", "oc_group"), chatType: "group", mentionedBot: true });
    await bot.drain();
    await bot.receive(message("private", "/model", "ou_owner000"));
    await bot.drain();
    for (const operator of [undefined, "ou_unknown"]) {
      await bot.handleModelCardAction("card_1", "oc_group", operator, choose);
      await bot.handleModelCardAction("card_1", "oc_group", operator, { action: "providers" });
    }
    await bot.handleModelCardAction("card_1", "oc_other", "ou_owner000", choose);
    assert.equal(changes, 0); assert.equal(updates, 0); assert.equal(approvals, 1);
    assert.equal((await bot.allow("ou_member000")).ok, true);
    await bot.handleModelCardAction("card_2", "chat_ou_owner000", "ou_member000", choose);
    assert.equal(changes, 0, "authorized users still cannot change somebody else's private session");
    await bot.handleModelCardAction("card_1", "oc_group", "ou_member000", choose);
    assert.equal(changes, 1, "an authorized group member may change the shared model");
    await bot.deny("ou_owner000");
    await bot.handleModelCardAction("card_2", "chat_ou_owner000", "ou_owner000", choose);
    assert.equal(changes, 1, "revocation also applies to old cards");
    await bot.stop();
    await bot.handleModelCardAction("card_1", "oc_group", "ou_member000", choose);
    assert.equal(changes, 1, "a stopped listener cannot act on an old callback");
  } finally { await bot.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

