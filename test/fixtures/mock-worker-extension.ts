import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import worker from "../../src/worker-extension.ts";

/** Test-only local OpenAI-compatible provider; its HTTP server is owned by integration.test.ts. */
export default function mockWorkerExtension(pi: ExtensionAPI): void {
  pi.registerProvider("mock", {
    baseUrl: process.env.LARK_BOT_MOCK_URL!,
    apiKey: "test-key",
    api: "openai-completions",
    models: [{
      id: "echo",
      name: "Local echo",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 1_024,
    }],
  });
  worker(pi);
}
