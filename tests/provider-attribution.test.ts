/**
 * pi-shift-router — provider session headers on our own outbound calls
 *
 * The router calls providers directly for judging and auditing. Some gateways
 * refuse those calls unless the request carries the same session attribution
 * pi attaches to its own requests — OpenCode Go / Zen returns
 * `400 MissingSessionID` without `x-opencode-session`, which makes the judge
 * fail on every turn (issue #48).
 *
 * The contract mirrored here is pi's `getSessionHeaders()`
 * (`pi-coding-agent/dist/core/provider-attribution.js`): the provider id is
 * `opencode` / `opencode-go`, or the baseUrl hostname is *exactly*
 * `opencode.ai`; the header pair is `x-opencode-session` + `x-opencode-client`.
 *
 * Guards the two ways this can regress:
 *   1. the predicate drifts (host suffix matching, or firing for other
 *      providers — the header must not leak to unrelated vendors);
 *   2. the headers are computed but never reach the fetch call.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { providerSessionHeaders } from "../src/provider-attribution.js";
import { classify } from "../src/judge.js";
import { callAuditLLM } from "../src/audit.js";
import type { ProviderEndpoint } from "../src/types.js";

const OPENCODE_HEADERS = {
  "x-opencode-session": "sess-1",
  "x-opencode-client": "pi",
};

function endpoint(over: Partial<ProviderEndpoint> = {}): ProviderEndpoint {
  return {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiType: "openai-completions",
    apiKey: "test-key",
    modelId: "test-model",
    ...over,
  };
}

function mockFetch(body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
  return (fn.mock.calls[call]?.[1] as { headers?: Record<string, string> })?.headers ?? {};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("providerSessionHeaders", () => {
  it("sends the session pair for the opencode provider", () => {
    expect(
      providerSessionHeaders(
        endpoint({ provider: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" }),
        "sess-1",
      ),
    ).toEqual(OPENCODE_HEADERS);
  });

  it("sends the session pair for opencode-go", () => {
    expect(
      providerSessionHeaders(
        endpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }),
        "sess-1",
      ),
    ).toEqual(OPENCODE_HEADERS);
  });

  it("keys off the host, so a custom provider id on opencode.ai is covered", () => {
    expect(
      providerSessionHeaders(
        endpoint({ provider: "my-gateway", baseUrl: "https://opencode.ai/zen/go/v1" }),
        "sess-1",
      ),
    ).toEqual(OPENCODE_HEADERS);
  });

  it("does not match a host that merely contains opencode.ai", () => {
    for (const baseUrl of [
      "https://opencode.ai.evil.com/v1",
      "https://evil.com/opencode.ai/v1",
      "https://opencode-ai.com/v1",
    ]) {
      expect(providerSessionHeaders(endpoint({ baseUrl }), "sess-1")).toEqual({});
    }
  });

  it("does not leak the headers to unrelated providers", () => {
    expect(providerSessionHeaders(endpoint(), "sess-1")).toEqual({});
    expect(
      providerSessionHeaders(
        endpoint({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
        "sess-1",
      ),
    ).toEqual({});
  });

  it("sends nothing without a session id — pi only attributes real sessions", () => {
    const ep = endpoint({ provider: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" });
    expect(providerSessionHeaders(ep, undefined)).toEqual({});
    expect(providerSessionHeaders(ep, "")).toEqual({});
  });

  it("treats an unparseable baseUrl as not-OpenCode instead of throwing", () => {
    expect(providerSessionHeaders(endpoint({ provider: "p", baseUrl: "not a url" }), "sess-1")).toEqual({});
  });
});

describe("judge call carries the session headers", () => {
  it("attributes a judge call to an OpenCode endpoint", async () => {
    const fn = mockFetch({ choices: [{ message: { content: '{"tier":"fast"}' } }] });
    await classify(
      "do something",
      [endpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" })],
      5000,
      false,
      undefined,
      undefined,
      "sess-1",
    );
    expect(sentHeaders(fn)["x-opencode-session"]).toBe("sess-1");
    expect(sentHeaders(fn)["x-opencode-client"]).toBe("pi");
    expect(sentHeaders(fn)["Content-Type"]).toBe("application/json");
  });

  it("leaves non-OpenCode judge calls untouched", async () => {
    const fn = mockFetch({ choices: [{ message: { content: '{"tier":"fast"}' } }] });
    await classify("do something", [endpoint()], 5000, false, undefined, undefined, "sess-1");
    expect(sentHeaders(fn)["x-opencode-session"]).toBeUndefined();
    expect(sentHeaders(fn)["Authorization"]).toBe("Bearer test-key");
  });

  it("keeps the Anthropic-style judge auth intact alongside the session pair", async () => {
    const fn = mockFetch({ content: [{ text: '{"tier":"smart"}' }] });
    await classify(
      "do something",
      [
        endpoint({
          provider: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiType: "anthropic-messages",
        }),
      ],
      5000,
      false,
      undefined,
      undefined,
      "sess-1",
    );
    expect(sentHeaders(fn)["x-api-key"]).toBe("test-key");
    expect(sentHeaders(fn)["anthropic-version"]).toBe("2023-06-01");
    expect(sentHeaders(fn)["x-opencode-session"]).toBe("sess-1");
  });
});

describe("audit call carries the session headers", () => {
  const opencode = () =>
    endpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" });

  it("attributes the OpenAI-style audit call", async () => {
    const fn = mockFetch({ choices: [{ message: { content: '{"verdict":"ok","issues":[]}' } }] });
    await callAuditLLM("goal", "summary", "workers", [opencode()], 5000, false, "sess-1");
    expect(sentHeaders(fn)["x-opencode-session"]).toBe("sess-1");
    expect(sentHeaders(fn)["x-opencode-client"]).toBe("pi");
  });

  it("attributes the Anthropic-style audit call", async () => {
    const fn = mockFetch({ content: [{ text: '{"verdict":"ok","issues":[]}' }] });
    await callAuditLLM(
      "goal",
      "summary",
      "workers",
      [{ ...opencode(), apiType: "anthropic-messages" }],
      5000,
      false,
      "sess-1",
    );
    expect(sentHeaders(fn)["x-opencode-session"]).toBe("sess-1");
    expect(sentHeaders(fn)["x-api-key"]).toBe("test-key");
  });

  it("leaves non-OpenCode audit calls untouched", async () => {
    const fn = mockFetch({ choices: [{ message: { content: '{"verdict":"ok","issues":[]}' } }] });
    await callAuditLLM("goal", "summary", "workers", [endpoint()], 5000, false, "sess-1");
    expect(sentHeaders(fn)["x-opencode-session"]).toBeUndefined();
  });
});
