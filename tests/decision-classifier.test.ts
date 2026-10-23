/**
 * Decision judges through pi's classifier layer (issue #54).
 *
 * Two things are being pinned here:
 *  1. the mapping from pi's `ClassifierResult` onto the router's verdict — a
 *     missing/refused/out-of-set answer must hold, never become a tier;
 *  2. the dispatch — a classifier endpoint is judged by `registry.classify()`
 *     with the protocol floor and no retry amplification, and a failure falls
 *     through to the next rung instead of ending the walk.
 *
 * The legacy System One transport is covered by the pre-existing tests; the
 * regression assertion at the bottom only checks it still takes the old path.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildClassifierContext,
  classifierTimeoutFloor,
  decisionTimeoutFor,
  findClassifierModel,
  listDecisionChoices,
  mapClassifierResult,
  normalizeClassifierModel,
  statusFromClassifierError,
} from "../src/decision.js";
import { classify } from "../src/judge.js";
import { resolveJudgeEndpoints } from "../src/config.js";
import { ensureDecisionJudgeTimeout } from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { ProviderEndpoint, RegistryClassifierResultLike, RegistryModelLike } from "../src/types.js";

const RUBRIC = "You are the router's judge.";

function endpointWithClassifier(overrides: Partial<ProviderEndpoint> = {}): ProviderEndpoint {
  return {
    provider: "typesafe",
    baseUrl: "https://api.typesafe.ai",
    apiType: "typesafe-system-one",
    apiKey: "",
    modelId: "jev-latest",
    classifier: { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" },
    ...overrides,
  };
}

function classifierResult(overrides: Partial<RegistryClassifierResultLike> = {}): RegistryClassifierResultLike {
  return {
    answers: {
      tier: { type: "choice", choice: "fast", probabilities: { fast: 0.99, smart: 0.01 }, confidence: 0.99 },
      orchestrate: { type: "bool", probability: 0.13 },
    },
    stopReason: "stop",
    model: "jev-latest",
    api: "typesafe-system-one",
    ...overrides,
  };
}

describe("mapClassifierResult", () => {
  it("maps a choice answer and a bool answer onto the verdict", () => {
    expect(mapClassifierResult(classifierResult())).toEqual({
      tier: "fast",
      confidence: 0.99,
      orchestrate: false,
    });
  });

  it("reads pSmart from the probability of the chosen option", () => {
    const raw = classifierResult({
      answers: {
        tier: { type: "choice", choice: "smart", probabilities: { fast: 0.2, smart: 0.8 }, confidence: 0.5 },
        orchestrate: { type: "bool", probability: 0.7 },
      },
    });
    expect(mapClassifierResult(raw)).toMatchObject({ tier: "smart", confidence: 0.8, orchestrate: true });
  });

  it("prefers the measured probability over the answer's own confidence field", () => {
    const raw = classifierResult({
      answers: {
        tier: { type: "choice", choice: "fast", probabilities: { fast: 0.61, smart: 0.39 }, confidence: 0.99 },
      },
    });
    expect(mapClassifierResult(raw)?.confidence).toBe(0.61);
  });

  it("keeps orchestrate undefined when the second answer is absent", () => {
    const raw = classifierResult({ answers: { tier: { type: "choice", choice: "fast", probabilities: { fast: 1 } } } });
    const verdict = mapClassifierResult(raw);
    expect(verdict?.tier).toBe("fast");
    expect(verdict?.orchestrate).toBeUndefined();
  });

  it("holds when the transport reports an error", () => {
    expect(mapClassifierResult(classifierResult({ stopReason: "error", errorMessage: "boom" }))).toBeNull();
    expect(mapClassifierResult(classifierResult({ stopReason: "aborted" }))).toBeNull();
  });

  it("holds when the tier answer is missing", () => {
    expect(mapClassifierResult(classifierResult({ answers: {} }))).toBeNull();
  });

  it("holds on an out-of-set choice", () => {
    const raw = classifierResult({
      answers: { tier: { type: "choice", choice: "medium", probabilities: { medium: 1 } } },
    });
    expect(mapClassifierResult(raw)).toBeNull();
  });

  it("holds on a refusal answer", () => {
    expect(mapClassifierResult(classifierResult({ answers: { tier: { type: "refusal" } } }))).toBeNull();
  });

  it("holds when the probability is not a finite number", () => {
    for (const bad of ["0.9", Number.NaN, null, undefined]) {
      const raw = classifierResult({
        answers: { tier: { type: "choice", choice: "fast", probabilities: { fast: bad as never } } },
      });
      expect(mapClassifierResult(raw)).toBeNull();
    }
  });

  it("falls back to answer.confidence when no probability map is present", () => {
    const raw = classifierResult({
      answers: { tier: { type: "choice", choice: "fast", confidence: 0.72 } },
    });
    expect(mapClassifierResult(raw)).toMatchObject({ tier: "fast", confidence: 0.72 });
  });
});

describe("buildClassifierContext", () => {
  it("asks one choice question and one bool question about the same state", () => {
    const ctx = buildClassifierContext("the prompt", RUBRIC);
    expect(ctx.state).toEqual({ prompt: "the prompt" });
    expect(Object.keys(ctx.questions).sort()).toEqual(["orchestrate", "tier"]);
    expect(ctx.questions.tier).toMatchObject({
      type: "choice",
      instructions: RUBRIC,
      criteria: { fast: expect.any(String), smart: expect.any(String) },
    });
    expect(ctx.questions.orchestrate).toMatchObject({
      type: "bool",
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
  });
});

describe("timeout floors", () => {
  it("uses the measured floor per protocol", () => {
    expect(classifierTimeoutFloor("openai-decisions")).toBe(8000);
    expect(classifierTimeoutFloor("typesafe-system-one")).toBe(15000);
    expect(classifierTimeoutFloor("cloudflare-workers-ai-system-one")).toBe(15000);
    expect(classifierTimeoutFloor(undefined)).toBe(15000);
  });

  it("never lowers a user timeout that is already above the floor", () => {
    expect(decisionTimeoutFor("openai-decisions", 5000)).toBe(8000);
    expect(decisionTimeoutFor("openai-decisions", 12000)).toBe(12000);
    expect(decisionTimeoutFor("typesafe-system-one", 5000)).toBe(15000);
    expect(decisionTimeoutFor("typesafe-system-one", 20000)).toBe(20000);
  });
});

describe("findClassifierModel", () => {
  const registry = {
    getModelsOfType: (type: string, provider?: string) =>
      type !== "classifier"
        ? []
        : ([
            { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" },
            { id: "gpt-6-luna", provider: "openai", api: "openai-decisions" },
          ] as RegistryModelLike[]).filter((m) => !provider || m.provider === provider),
  };

  it("finds a classifier by provider and id", () => {
    expect(findClassifierModel(registry, "openai", "gpt-6-luna")).toMatchObject({ provider: "openai" });
  });

  it("returns null when the ref is not a classifier in this host", () => {
    expect(findClassifierModel(registry, "openai", "gpt-4o")).toBeNull();
  });

  it("returns null on a host without classifier enumeration", () => {
    expect(findClassifierModel({}, "typesafe", "jev-latest")).toBeNull();
  });
});

describe("statusFromClassifierError", () => {
  it("extracts a failover-worthy status from pi's error text", () => {
    expect(statusFromClassifierError("System One API returned 429")).toBe("429");
    expect(statusFromClassifierError("OpenAI Decisions returned 503")).toBe("503");
    expect(statusFromClassifierError("OpenAI Decisions returned 400")).toBeNull();
    expect(statusFromClassifierError(undefined)).toBeNull();
  });

  it("recognises the System One wrapper shape that a live call actually returns", () => {
    // Verbatim from a real pi 1.4.0 call through OpenRouter (2026-10-23).
    const live =
      'System One API error (402): {"error":{"message":"Insufficient credits. This account never purchased credits.",' +
      '"code":402,"metadata":{"limit_source":"openrouter_credits"}}}';
    expect(statusFromClassifierError(live)).toBe("402");
    expect(statusFromClassifierError("System One API error (400): bad request")).toBeNull();
  });
});

describe("classify() dispatch", () => {
  it("judges a classifier endpoint through the registry, with the floor and no retries", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const registry = {
      classify: async (_model: unknown, _ctx: unknown, options: Record<string, unknown>) => {
        calls.push(options);
        return classifierResult();
      },
    };

    const result = await classify("do the thing", [endpointWithClassifier()], 5000, false, undefined, undefined, "sess-1", registry);

    expect(result).toMatchObject({ tier: "fast", source: "decision", confidence: 0.99 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ timeoutMs: 15000, maxRetries: 0 });
    expect(result.decisionProtocol).toBe("typesafe-system-one");
  });

  it("passes the provider attribution headers for an OpenCode-served classifier", async () => {
    let seen: Record<string, unknown> | undefined;
    const registry = {
      classify: async (_m: unknown, _c: unknown, options: Record<string, unknown>) => {
        seen = options;
        return classifierResult();
      },
    };
    const ep = endpointWithClassifier({
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/go",
      apiType: "typesafe-system-one",
      modelId: "jev-1.13",
      classifier: { id: "jev-1.13", provider: "opencode", api: "typesafe-system-one", baseUrl: "https://opencode.ai/zen/go" },
    });
    await classify("x", [ep], 15000, false, undefined, undefined, "sess-9", registry);
    expect(seen?.headers).toMatchObject({ "x-opencode-session": "sess-9", "x-opencode-client": "pi" });
  });

  it("falls through to the next rung when the classifier reports an error", async () => {
    const failing = {
      classify: async () => classifierResult({ stopReason: "error", errorMessage: "System One API returned 503" }),
    };
    const llm: ProviderEndpoint = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiType: "openai-completions",
      apiKey: "k",
      modelId: "deepseek-chat",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"tier":"smart","confidence":0.9}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const failures: string[] = [];
    const result = await classify(
      "x",
      [endpointWithClassifier(), llm],
      5000,
      false,
      undefined,
      (_p, _m, code) => failures.push(code),
      "s1",
      failing,
    );
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ tier: "smart", source: "llm" });
    expect(failures).toEqual(["503"]);
  });

  it("holds the position when no rung answers", async () => {
    const failing = { classify: async () => classifierResult({ stopReason: "error", errorMessage: "timeout" }) };
    const result = await classify("x", [endpointWithClassifier()], 5000, false, undefined, undefined, "s1", failing);
    expect(result).toEqual({ tier: "fast", source: "fallback" });
  });

  it("keeps the legacy System One endpoint on the self-built path", async () => {
    const registry = { classify: vi.fn() };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ answers: { tier: { choice: "smart", probabilities: { smart: 0.91 } }, orchestrate: { noul: 0.6 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const legacy: ProviderEndpoint = {
      provider: "typesafe",
      baseUrl: "https://api.typesafe.ai",
      apiType: "typesafe-decisions",
      apiKey: "k",
      modelId: "jev-latest",
    };
    const result = await classify("x", [legacy], 15000, false, undefined, undefined, "s1", registry);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ tier: "smart", source: "decision" });
    expect(registry.classify).not.toHaveBeenCalled();
  });
});

describe("listDecisionChoices", () => {
  const registry = {
    getModelsOfType: () =>
      [
        { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one", name: "Jev" },
        { id: "gpt-6-luna", provider: "openai", api: "openai-decisions", name: "GPT-6 Luna" },
      ] as RegistryModelLike[],
  };

  it("lists native classifier models before legacy endpoints", () => {
    const out = listDecisionChoices(registry, [
      { id: "jev-latest", provider: "typesafe", api: "typesafe-decisions" },
      { id: "jev-legacy", provider: "custom", api: "typesafe-decisions" },
    ]);
    expect(out.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "typesafe/jev-latest",
      "openai/gpt-6-luna",
      "custom/jev-legacy",
    ]);
  });

  it("does not duplicate a model that exists in both sources", () => {
    const out = listDecisionChoices(registry, [{ id: "jev-latest", provider: "typesafe", api: "typesafe-decisions" }]);
    expect(out).toHaveLength(2);
  });

  it("marks the source so the picker can label legacy entries", () => {
    const out = listDecisionChoices(registry, [{ id: "old", provider: "vend", api: "typesafe-decisions" }]);
    expect(out.find((m) => m.id === "old")?.name).toContain("legacy");
    expect(out.find((m) => m.id === "jev-latest")?.name).not.toContain("legacy");
  });

  it("returns only legacy entries on a host without classifier support", () => {
    const out = listDecisionChoices({}, [{ id: "old", provider: "vend", api: "typesafe-decisions" }]);
    expect(out).toHaveLength(1);
  });
});

describe("resolveJudgeEndpoints — native path (issue #54)", () => {

  const cfg = (mode: string, provider: string, model: string): any => ({
    ...DEFAULT_CONFIG,
    tiers: {
      fast: { models: [{ provider: "deepseek", model: "deepseek-chat", priority: 1 }] },
      smart: { models: [] },
    },
    routing: { ...DEFAULT_CONFIG.routing, judge: { mode, models: [{ provider, model, priority: 1 }] } },
  });

  const store: any = {
    typesafe: {
      baseUrl: "https://api.typesafe.ai",
      api: "typesafe-decisions",
      models: [{ id: "jev-latest", api: "typesafe-decisions" }],
    },
  };
  const auth: any = { typesafe: { key: "k" } };

  const withCatalog = (models: RegistryModelLike[]) => ({ getModelsOfType: () => models }) as never;

  it("prefers a pi classifier over the same model's legacy endpoint", async () => {
    const registry = withCatalog([
      { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one", baseUrl: "https://api.typesafe.ai" },
    ]);
    const eps = await resolveJudgeEndpoints(cfg("decision", "typesafe", "jev-latest"), store, auth, {}, registry);
    expect(eps[0]?.classifier).toBeTruthy();
    expect(eps[0]?.apiType).toBe("typesafe-system-one");
    // pi resolves the key inside classify(); the router never holds it here.
    expect(eps[0]?.apiKey).toBe("");
  });

  it("falls back to the legacy endpoint when the host has no classifier catalog", async () => {
    const eps = await resolveJudgeEndpoints(cfg("decision", "typesafe", "jev-latest"), store, auth, {}, undefined);
    expect(eps[0]?.classifier).toBeUndefined();
    expect(eps[0]?.apiType).toBe("typesafe-decisions");
  });

  it("never treats a classifier as a custom-mode LLM judge", async () => {
    const registry = withCatalog([{ id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" }]);
    const eps = await resolveJudgeEndpoints(cfg("custom", "typesafe", "jev-latest"), store, auth, {}, registry);
    expect(eps[0]?.classifier).toBeUndefined();
  });
});

describe("wizard timeout raise", () => {
  it("uses the protocol floor instead of one number for every decision model", () => {
    const cfg = (t: number): any => ({ routing: { judgeTimeout: t } });
    const openai = cfg(5000);
    expect(ensureDecisionJudgeTimeout(openai, classifierTimeoutFloor("openai-decisions"))).toMatchObject({
      from: 5000,
      to: 8000,
      raised: true,
    });
    const systemOne = cfg(5000);
    expect(ensureDecisionJudgeTimeout(systemOne, classifierTimeoutFloor("typesafe-system-one"))).toMatchObject({
      to: 15000,
      raised: true,
    });
  });

  it("leaves a timeout that is already above the floor alone", () => {
    const cfg: any = { routing: { judgeTimeout: 20000 } };
    expect(ensureDecisionJudgeTimeout(cfg, classifierTimeoutFloor("openai-decisions"))).toEqual({
      from: 20000,
      to: 20000,
      raised: false,
    });
    expect(cfg.routing.judgeTimeout).toBe(20000);
  });
});

describe("normalizeClassifierModel — TypeSafe baseUrl", () => {
  const base = { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" };

  it("adds /v1 for the official host, because pi 1.4.0 flattens the catalog path", () => {
    // Live: https://api.typesafe.ai/systemone -> 404, .../v1/systemone -> 403.
    expect(normalizeClassifierModel({ ...base, baseUrl: "https://api.typesafe.ai" }).baseUrl).toBe(
      "https://api.typesafe.ai/v1",
    );
    expect(normalizeClassifierModel({ ...base, baseUrl: "https://api.typesafe.ai/" }).baseUrl).toBe(
      "https://api.typesafe.ai/v1",
    );
  });

  it("leaves gateways and an already-fixed host untouched", () => {
    expect(
      normalizeClassifierModel({ ...base, baseUrl: "https://openrouter.ai/api/v1" }).baseUrl,
    ).toBe("https://openrouter.ai/api/v1");
    expect(
      normalizeClassifierModel({ ...base, baseUrl: "https://api.typesafe.ai/v1" }).baseUrl,
    ).toBe("https://api.typesafe.ai/v1");
  });

  it("hands the normalized model to the host transport", async () => {
    let seen: RegistryModelLike | undefined;
    const registry = {
      classify: async (model: RegistryModelLike) => {
        seen = model;
        return classifierResult();
      },
    };
    const ep = endpointWithClassifier({
      baseUrl: "https://api.typesafe.ai",
      classifier: { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one", baseUrl: "https://api.typesafe.ai" },
    });
    await classify("x", [ep], 15000, false, undefined, undefined, "s1", registry);
    expect(seen?.baseUrl).toBe("https://api.typesafe.ai/v1");
  });
});
