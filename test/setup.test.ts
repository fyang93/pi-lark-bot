import test from "node:test";
import assert from "node:assert/strict";
import { connectBot } from "../src/setup.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

function context(custom: (factory: any) => Promise<unknown>) {
  let selected = 0;
  return { ui: {
    async select() { return selected++ === 0 ? "Enter existing App ID / App Secret" : "Feishu"; },
    async input() { return "cli_test"; },
    custom,
  } } as unknown as ExtensionCommandContext;
}

test("manual secret input is masked and never dispatched as a pi message", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: { URL: "wss://redacted.invalid" } }))) as typeof fetch;
  const controller = new AbortController();
  const ctx = context((factory) => new Promise((resolve) => {
    const component = factory({ requestRender() {} }, {}, {}, resolve);
    component.handleInput("very-private-secret");
    const rendered = component.render(80).join("\n");
    assert(!rendered.includes("very-private-secret"));
    assert(rendered.includes("•"));
    component.handleInput("\r");
    component.dispose();
  }));
  const result = await connectBot(ctx, controller.signal);
  assert.equal(result?.appSecret, "very-private-secret");
  assert.equal(result?.appId, "cli_test");
  assert.equal(result?.domain, "feishu");
});

test("shutdown aborts manual secret dialog and discards the configuration", async () => {
  const controller = new AbortController();
  const ctx = context((factory) => new Promise((resolve) => {
    const component = factory({ requestRender() {} }, {}, {}, resolve);
    component.handleInput("private");
    controller.abort();
    component.dispose();
  }));
  assert.equal(await connectBot(ctx, controller.signal), undefined);
});
