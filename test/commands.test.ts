import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotController } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, WorkerFactory } from "../src/types.ts";

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
  const workers: WorkerFactory = {
    async open() { throw new Error("commands must not create a normal prompt worker"); },
    async reset(key) { resets.push(key); },
    async setModel(key, model) { models.push({ key, model: `${model.provider}/${model.id}` }); },
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

