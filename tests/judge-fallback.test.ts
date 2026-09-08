/**
 * pi-shift-router — Judge fast-model fallback tests
 *
 * The Judge classifies with the fast tier's model. When that model fails
 * (429 / 5xx / network), the Judge must fall back to the NEXT model in the
 * fast tier's priority list — not silently give up and return "fast".
 *
 * These tests mock global fetch to simulate provider responses.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { classify } from "../src/judge.js";
import type { ProviderEndpoint } from "../src/types.js";

function endpoint(modelId: string, baseUrl = "https://api.example.com"): ProviderEndpoint {
  return {
    provider: "p",
    baseUrl,
    apiType: "openai-completions",
    apiKey: "test-key",
    modelId,
  };
}

/** Mock fetch with a queue of responses per call. */
function mockFetch(
  handler: (url: string, init: any) => Promise<Response | Error>,
) {
  const fn = vi.fn(handler);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Extract the model id from a fetch request body. */
function modelFromRequest(init: any): string {
  try {
    const body = JSON.parse(init?.body ?? "{}");
    return body?.model ?? "";
  } catch {
    return "";
  }
}

function okResponse(modelId: string, tier: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ tier }) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "fail" } }), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Judge fallback across fast-tier models ────────────────────────
describe("classify falls back across fast-tier models", () => {
  it("uses the first endpoint when it succeeds", async () => {
    const fetchMock = mockFetch(async () => okResponse("M3", "fast"));

    const r = await classify("quick task", [endpoint("M3"), endpoint("deepseek-v4-flash")]);

    expect(r).toEqual({ tier: "fast", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries the second model when the first returns 429", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return errorResponse(429);
      return okResponse("model-b", "smart");
    });

    const r = await classify("complex design task", [
      endpoint("model-a"),
      endpoint("model-b"),
    ]);

    expect(r).toEqual({ tier: "smart", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries the second model when the first throws a network error", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") throw new Error("fetch failed: ECONNRESET");
      return okResponse("model-b", "fast");
    });

    const r = await classify("quick task", [
      endpoint("model-a"),
      endpoint("model-b"),
    ]);

    expect(r).toEqual({ tier: "fast", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries the second model when the first response is unparseable", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return okResponse("model-a", "garbage");
      return okResponse("model-b", "smart");
    });

    const r = await classify("design review", [
      endpoint("model-a"),
      endpoint("model-b"),
    ]);

    expect(r).toEqual({ tier: "smart", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns fallback fast when ALL fast-tier models fail", async () => {
    const fetchMock = mockFetch(async () => errorResponse(429));

    const r = await classify("quick task", [
      endpoint("model-a"),
      endpoint("model-b"),
    ]);

    expect(r).toEqual({ tier: "fast", source: "fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns fallback fast with no endpoints", async () => {
    const fetchMock = mockFetch(async () => errorResponse(429));
    const r = await classify("quick task", []);
    expect(r).toEqual({ tier: "fast", source: "fallback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns fallback fast when endpoints is null", async () => {
    const r = await classify("quick task", null);
    expect(r).toEqual({ tier: "fast", source: "fallback" });
  });

  it("skips models in cooldown via the predicate", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-b") return okResponse("model-b", "smart");
      throw new Error("should not be called");
    });
    const isCooldown = (p: string, m: string) => p === "p" && m === "model-a";

    const r = await classify("design task", [
      endpoint("model-a"),
      endpoint("model-b"),
    ], 5000, false, isCooldown);

    expect(r).toEqual({ tier: "smart", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries all models even when the first times out", async () => {
    // Simulate abort (timeout) on model-a, success on model-b
    const fetchMock = mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") {
        // Simulate timeout via abort signal
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
        throw new DOMException("Aborted", "AbortError");
      }
      return okResponse("model-b", "fast");
    });

    // 2s abort window: generous headroom under vitest's 5s per-test timeout —
    // this is the only test relying on a real millisecond timer, and a cold
    // CI/worktree start once starved the 100ms variant (flake, 2026-09-07).
    const r = await classify("quick task", [
      endpoint("model-a"),
      endpoint("model-b"),
    ], 2000);

    expect(r).toEqual({ tier: "fast", source: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── resolveFastEndpoints (config) ─────────────────────────────────
import { resolveFastEndpoints } from "../src/config.js";
import type { ModelsStore, AuthStore } from "../src/types.js";

describe("resolveFastEndpoints — Judge fast-chain fallback", () => {
  const store: ModelsStore = {
    minimax: {
      models: [
        { id: "MiniMax-M3", provider: "minimax", baseUrl: "https://api.minimax.example/", api: "openai-completions" },
      ],
    },
    deepseek: {
      models: [
        { id: "deepseek-v4-flash", provider: "deepseek", baseUrl: "https://api.deepseek.example", api: "openai-completions" },
      ],
    },
  };
  const auth: AuthStore = {
    minimax: { type: "apiKey", key: "mm-key" },
    deepseek: { type: "apiKey", key: "ds-key" },
  };
  const cfg = (fastModels: { provider: string; model: string; priority: number }[]) => ({
    tiers: { fast: { models: fastModels }, smart: { models: [] } },
  }) as any;

  it("returns the whole fast chain in priority order", async () => {
    const eps = await resolveFastEndpoints(
      cfg([
        { provider: "minimax", model: "MiniMax-M3", priority: 2 },
        { provider: "deepseek", model: "deepseek-v4-flash", priority: 1 },
      ]),
      store,
      auth,
    );
    expect(eps.map((e) => e.modelId)).toEqual(["deepseek-v4-flash", "MiniMax-M3"]);
    expect(eps[0].provider).toBe("deepseek");
    expect(eps[1].baseUrl).toBe("https://api.minimax.example"); // trailing slash trimmed
  });

  it("skips models without auth but keeps the rest", async () => {
    const eps = await resolveFastEndpoints(
      cfg([
        { provider: "minimax", model: "MiniMax-M3", priority: 1 },
        { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
      ]),
      store,
      { deepseek: { type: "apiKey", key: "ds-key" } }, // minimax has no auth
    );
    expect(eps.map((e) => e.modelId)).toEqual(["deepseek-v4-flash"]);
  });

  it("falls back to the cheapest global model when the fast chain is unresolvable", async () => {
    const eps = await resolveFastEndpoints(cfg([
      { provider: "ghost", model: "x", priority: 1 },
    ]), store, auth);
    // Fast chain empty → cheapest model with auth (minimax) is used
    expect(eps.map((e) => e.modelId)).toEqual(["MiniMax-M3"]);
  });

  it("returns empty when NO provider has auth (nothing to judge with)", async () => {
    const eps = await resolveFastEndpoints(cfg([
      { provider: "minimax", model: "MiniMax-M3", priority: 1 },
    ]), store, {});
    expect(eps).toEqual([]);
  });
});

// ─── Regression: JSON.stringify(undefined) safety ──────────────────
// Bug: when an LLM returns 200 but the body lacks `choices` (some
// providers return error-shaped JSON without choices[]), the verbose/warn
// log used to call content.slice(0, 100) on undefined and crash with
// "Cannot read properties of undefined (reading 'slice')". The fix:
// jsonStr() returns the literal "undefined" string for undefined input.

describe("classify handles error-shaped 200 responses without crashing", () => {
  it("does not throw when response is 200 but body lacks choices[]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "rate limit" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const r = await classify("test", [endpoint("M3")]);
    expect(r).toEqual({ tier: "fast", source: "fallback" });
    vi.unstubAllGlobals();
  });

  it("does not throw when response is 200 with empty choices", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const r = await classify("test", [endpoint("M3")]);
    expect(r).toEqual({ tier: "fast", source: "fallback" });
    vi.unstubAllGlobals();
  });
});

// ─── Judge-side cooldown writes (SPEC §8.5) ──────────────────────
// Without this, every judge call re-hits the first fast model even when
// it just 429'd the previous judge call — because the shared cooldown map
// was only written by `agent_end` turn failures. Now classify surfaces
// the failure signature via onFailure so the caller can cool the model.
describe("classify surfaces failover failures via onFailure", () => {
  function errorResponseWith(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("calls onFailure with '429' when the first model returns HTTP 429", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return errorResponse(429);
      return okResponse("model-b", "fast");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    expect(failures).toEqual([{ provider: "p", model: "model-a", code: "429" }]);
  });

  it("calls onFailure with the 5xx status when the model returns 503", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return errorResponse(503);
      return okResponse("model-b", "smart");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    expect(failures).toEqual([{ provider: "p", model: "model-a", code: "503" }]);
  });

  it("detects rate-limit signature in the body even when status is 400", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") {
        return errorResponseWith(400, { error: { message: "rate limit exceeded" } });
      }
      return okResponse("model-b", "fast");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    // Body signature takes precedence — "rate limit" → code "429".
    expect(failures).toEqual([{ provider: "p", model: "model-a", code: "429" }]);
  });

  it("does NOT call onFailure on an unparseable 200 response (model is responding)", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return okResponse("model-a", "garbage");
      return okResponse("model-b", "smart");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    expect(failures).toEqual([]);
  });

  it("does NOT call onFailure on a network throw (not a failover signature)", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") throw new Error("ECONNRESET");
      return okResponse("model-b", "fast");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    expect(failures).toEqual([]);
  });

  it("does NOT call onFailure on a 401 auth error (config, not transient)", async () => {
    mockFetch(async (_url, init) => {
      if (modelFromRequest(init) === "model-a") return errorResponse(401);
      return okResponse("model-b", "fast");
    });

    const failures: Array<{ provider: string; model: string; code: string }> = [];
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model, code) => failures.push({ provider, model, code }),
    );

    expect(failures).toEqual([]);
  });

  it("end-to-end: model cooled by an earlier call is skipped in the next call", async () => {
    // The exact UX bug: judge call N hits model-a → 429, marks it cooldown
    // via onFailure; judge call N+1 receives the shared cooldown predicate
    // and skips model-a without burning another 429.
    const { markModelFailed, isModelInCooldown, createCooldowns } = await import("../src/failover.js");
    const cooldowns = createCooldowns();

    let calls = 0;
    mockFetch(async (_url, init) => {
      calls++;
      const m = modelFromRequest(init);
      if (m === "model-a") return errorResponse(429);
      return okResponse("model-b", "smart");
    });

    const now = Date.now();
    // Call 1: model-a 429 → onFailure marks it; falls to model-b.
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      undefined,
      (provider, model) => markModelFailed(cooldowns, provider, model, now),
    );
    expect(calls).toBe(2);
    expect(isModelInCooldown(cooldowns, "p", "model-a", now)).toBe(true);

    // Call 2: model-a is cooled → only model-b is called (no wasted 429).
    await classify(
      "task",
      [endpoint("model-a"), endpoint("model-b")],
      5000,
      false,
      (provider, model) => isModelInCooldown(cooldowns, provider, model, now),
    );
    expect(calls).toBe(3); // +1 for model-b only
  });
});
