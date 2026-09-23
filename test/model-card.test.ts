import assert from "node:assert/strict";
import test from "node:test";
import { modelPickerCard, parseModelCardAction } from "../src/model-card.ts";

test("model picker emits callback buttons and parses only valid actions", () => {
  const card = modelPickerCard([{ provider: "openai", id: "fast" }], { provider: "openai", id: "fast" }) as any;
  assert.equal(card.schema, "2.0");
  assert.equal(parseModelCardAction({ action: "set_model", key: "openai/fast" })?.action, "set_model");
  assert.equal(parseModelCardAction({ action: "models", provider: "openai", page: 0 })?.action, "models");
  assert.equal(parseModelCardAction({ action: "set_model" }), undefined);
});
