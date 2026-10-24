/**
 * The judge's `orchestrate` answer must reach the verdict.
 *
 * The Judge prompt has required `orchestrate` since v1.1.0 (its contract: "for a
 * `fast` turn always false"), and `parseJudgeAnswer` has always parsed it — but
 * the result object never carried it, so `shouldOrchestrate()` silently fell
 * back to the tier default on every path. Found while wiring the native
 * classifier path (issue #54), which would otherwise have disagreed with the
 * HTTP paths on the same answer.
 */
import { describe, it, expect, vi } from "vitest";
import { classify } from "../src/judge.js";
import type { ProviderEndpoint } from "../src/types.js";

const llm: ProviderEndpoint = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiType: "openai-completions",
  apiKey: "k",
  modelId: "deepseek-chat",
};

function stub(content: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("judge orchestrate signal", () => {
  it("carries an explicit false through to the verdict", async () => {
    stub('{"tier":"smart","confidence":0.9,"orchestrate":false}');
    const result = await classify("x", [llm], 5000);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ tier: "smart", source: "llm", orchestrate: false });
  });

  it("carries an explicit true through to the verdict", async () => {
    stub('{"tier":"smart","confidence":0.9,"orchestrate":true}');
    const result = await classify("x", [llm], 5000);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ tier: "smart", orchestrate: true });
  });

  it("stays absent when the judge did not answer it", async () => {
    stub('{"tier":"fast","confidence":0.9}');
    const result = await classify("x", [llm], 5000);
    vi.unstubAllGlobals();
    expect(result.orchestrate).toBeUndefined();
  });
});
