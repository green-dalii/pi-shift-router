/**
 * pi-shift-router — Runtime failover tests (SPEC §8.5)
 *
 * Covers the exponential-backoff cooldown state machine:
 *   - modelKey / cooldown helpers (pure, no IO)
 *   - failover error signature detection
 *   - same-tier fallback model selection (no cross-tier)
 *   - cooldown-aware routing (processRoute + findBestModelForTier)
 */

import { describe, it, expect } from "vitest";
import {
  modelKey,
  createCooldowns,
  markModelFailed,
  isModelInCooldown,
  clearModelCooldown,
  remainingCooldownMs,
  detectFailoverError,
  findFailoverModel,
  tokensPerSecond,
  recordSpeed,
  recordTurnThroughputFallback,
  medianSpeed,
  MIN_STREAM_ELAPSED_MS,
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
} from "../src/failover.js";
import { findBestModelForTier } from "../src/tier.js";
import {
  createRouterState,
  processRoute,
} from "../src/router.js";
import { DEFAULT_CONFIG, type ShiftRouterConfig, type Tier } from "../src/types.js";

const NOW = 1_000_000;
const MIN = 60_000;

// ─── modelKey ──────────────────────────────────────────────────────
describe("modelKey", () => {
  it("joins provider and model with a separator", () => {
    expect(modelKey("minimax", "MiniMax-M3")).toBe("minimax/MiniMax-M3");
  });

  it("distinguishes same model across providers", () => {
    expect(modelKey("a", "x")).not.toBe(modelKey("b", "x"));
  });
});

// ─── Cooldown marking (exponential backoff) ────────────────────────
describe("markModelFailed exponential backoff", () => {
  it("first failure sets a 1-minute cooldown", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "MiniMax-M3", NOW);
    const e = cd.get(modelKey("minimax", "MiniMax-M3"));
    expect(e).toBeDefined();
    expect(e!.until).toBe(NOW + MIN);
    expect(e!.attempts).toBe(1);
  });

  it("second failure quadruples to 4 minutes", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "MiniMax-M3", NOW);
    markModelFailed(cd, "minimax", "MiniMax-M3", NOW + MIN + 1);
    const e = cd.get(modelKey("minimax", "MiniMax-M3"));
    expect(e!.until).toBe(NOW + MIN + 1 + 4 * MIN);
    expect(e!.attempts).toBe(2);
  });

  it("grows 1m, 4m, 16m, 64m, ... exponentially", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    expect(cd.get(modelKey("m", "model"))!.until - NOW).toBe(MIN);
    markModelFailed(cd, "m", "model", NOW);
    expect(cd.get(modelKey("m", "model"))!.until - NOW).toBe(4 * MIN);
    markModelFailed(cd, "m", "model", NOW);
    expect(cd.get(modelKey("m", "model"))!.until - NOW).toBe(16 * MIN);
    markModelFailed(cd, "m", "model", NOW);
    expect(cd.get(modelKey("m", "model"))!.until - NOW).toBe(64 * MIN);
  });

  it("caps backoff at 6 hours (COOLDOWN_MAX_MS)", () => {
    const cd = createCooldowns();
    // Fail 10 times — should hit the cap
    for (let i = 0; i < 10; i++) {
      markModelFailed(cd, "m", "model", NOW);
    }
    const e = cd.get(modelKey("m", "model"))!;
    expect(e.until - NOW).toBeLessThanOrEqual(COOLDOWN_MAX_MS);
    expect(e.until - NOW).toBe(COOLDOWN_MAX_MS);
  });

  it("4xx failures skip the first two tiers and start at 16m", () => {
    const cd = createCooldowns();
    // First failure is a 429 (client-side rate limit) → start at 16m.
    markModelFailed(cd, "m", "model", NOW, "429");
    let e = cd.get(modelKey("m", "model"))!;
    expect(e.attempts).toBe(3);
    expect(e.until - NOW).toBe(16 * MIN);

    // Second 429 → 1h4m tier.
    markModelFailed(cd, "m", "model", NOW + 16 * MIN + 1, "429");
    e = cd.get(modelKey("m", "model"))!;
    expect(e.attempts).toBe(4);
    expect(e.until - (NOW + 16 * MIN + 1)).toBe(64 * MIN);
  });

  it("402 (billing-exhausted) inherits the 4xx 16m-start backoff — same as 429", () => {
    // 402 / Insufficient Balance is a client-side limit (account balance), so
    // it gets the longer backoff just like 429. markModelFailed keys off
    // `code.startsWith("4")` — verify 402 is treated identically so the
    // failover cadence is consistent across the 4xx quota/billing bucket.
    const cd429 = createCooldowns();
    markModelFailed(cd429, "m", "model-429", NOW, "429");
    const cd402 = createCooldowns();
    markModelFailed(cd402, "m", "model-402", NOW, "402");

    const e429 = cd429.get(modelKey("m", "model-429"))!;
    const e402 = cd402.get(modelKey("m", "model-402"))!;
    expect(e402.attempts).toBe(e429.attempts);
    expect(e402.until - NOW).toBe(e429.until - NOW);
    expect(e402.until - NOW).toBe(16 * MIN);
  });

  it("4xx start tier does not clobber a higher 5xx-evolved tier", () => {
    const cd = createCooldowns();
    // Evolve to 4h16m via 5xx failures (attempts=5).
    markModelFailed(cd, "m", "model", NOW);
    markModelFailed(cd, "m", "model", NOW);
    markModelFailed(cd, "m", "model", NOW);
    markModelFailed(cd, "m", "model", NOW);
    markModelFailed(cd, "m", "model", NOW);
    expect(cd.get(modelKey("m", "model"))!.attempts).toBe(5);

    // A later 429 must not reset back down to the 4xx start tier.
    markModelFailed(cd, "m", "model", NOW, "429");
    const e = cd.get(modelKey("m", "model"))!;
    expect(e.attempts).toBe(6); // monotonic: 5+1, not clamped to 3
    expect(e.until - NOW).toBe(COOLDOWN_MAX_MS); // 6h cap
  });

  it("5xx failures keep the 1m start", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW, "503");
    const e = cd.get(modelKey("m", "model"))!;
    expect(e.attempts).toBe(1);
    expect(e.until - NOW).toBe(MIN);
  });

  it("escalates after natural expiry — thawed model re-fail continues the series", () => {
    // The user's concern: model thaws (cooldown expires naturally), fails
    // again → attempts must continue from the previous tier, not reset.
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);           // attempts=1, until = NOW+1m
    markModelFailed(cd, "m", "model", NOW);           // attempts=2, until = NOW+4m
    markModelFailed(cd, "m", "model", NOW);           // attempts=3, until = NOW+16m
    const before = cd.get(modelKey("m", "model"))!;
    expect(before.attempts).toBe(3);

    // Let the cooldown expire naturally (no 2xx recovery), then fail again.
    const later = NOW + before.until - NOW + 1; // just past expiry
    markModelFailed(cd, "m", "model", later);         // attempts=4 → 64m
    const after = cd.get(modelKey("m", "model"))!;
    expect(after.attempts).toBe(4);
    expect(after.until - later).toBe(64 * MIN);
  });
});

// ─── Cooldown queries ──────────────────────────────────────────────
describe("isModelInCooldown", () => {
  it("returns true while within the cooldown window", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    expect(isModelInCooldown(cd, "m", "model", NOW + 30_000)).toBe(true);
  });

  it("returns false after the cooldown expires", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    expect(isModelInCooldown(cd, "m", "model", NOW + MIN + 1)).toBe(false);
  });

  it("returns false when never failed", () => {
    const cd = createCooldowns();
    expect(isModelInCooldown(cd, "m", "model", NOW)).toBe(false);
  });
});

describe("remainingCooldownMs", () => {
  it("returns remaining time while cooling", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    expect(remainingCooldownMs(cd, "m", "model", NOW + 30_000)).toBe(30_000);
  });

  it("returns 0 when not in cooldown", () => {
    const cd = createCooldowns();
    expect(remainingCooldownMs(cd, "m", "model", NOW)).toBe(0);
  });

  it("returns 0 after expiry", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    expect(remainingCooldownMs(cd, "m", "model", NOW + MIN + 1)).toBe(0);
  });
});

describe("clearModelCooldown", () => {
  it("removes the entry entirely (recovery)", () => {
    const cd = createCooldowns();
    markModelFailed(cd, "m", "model", NOW);
    clearModelCooldown(cd, "m", "model");
    expect(cd.has(modelKey("m", "model"))).toBe(false);
    expect(isModelInCooldown(cd, "m", "model", NOW)).toBe(false);
  });

  it("no-ops for unknown model", () => {
    const cd = createCooldowns();
    expect(() => clearModelCooldown(cd, "ghost", "x")).not.toThrow();
  });
});

// ─── Failover error signatures (SPEC §8.5.3) ───────────────────────
describe("detectFailoverError", () => {
  it("detects 429 rate limit status", () => {
    const r = detectFailoverError("Error: 429 {\"type\":\"error\",\"message\":\"rate_limit_error\"}");
    expect(r).not.toBeNull();
    expect(r!.code).toBe("429");
  });

  it("detects 5xx server errors", () => {
    expect(detectFailoverError("Error: 502 Bad Gateway")).not.toBeNull();
    expect(detectFailoverError("Error: 503 Service Unavailable")).not.toBeNull();
    expect(detectFailoverError("Error: 504 Gateway Timeout")).not.toBeNull();
    expect(detectFailoverError("HTTP 500 internal server error")).not.toBeNull();
  });

  it("detects quota / token plan exhaustion", () => {
    expect(detectFailoverError("已达到 Token Plan 用量上限：请升级 Token Plan 套餐")).not.toBeNull();
    expect(detectFailoverError("insufficient_quota for model")).not.toBeNull();
    expect(detectFailoverError("Quota exceeded for API key")).not.toBeNull();
    expect(detectFailoverError("rate limit exceeded")).not.toBeNull();
    expect(detectFailoverError("Too Many Requests")).not.toBeNull();
  });

  it("does NOT detect 400/401/404 (config/auth errors) — except unsupported_model", () => {
    expect(detectFailoverError("400 Bad Request: invalid_prompt")).toBeNull();
    expect(detectFailoverError("401 Unauthorized: invalid api key")).toBeNull();
    // 404 without model-not-found body is still config/auth, not failover.
    expect(detectFailoverError("404 page not found")).toBeNull();
  });

  it("detects unsupported_model / model_not_found as failover (retry next model)", () => {
    expect(detectFailoverError('400: {"code":"unsupported_model"}')).toEqual({ code: "unsupported_model" });
    expect(detectFailoverError('Model "stealth/ox-alpha" is not supported on this endpoint.')).toEqual({ code: "unsupported_model" });
    expect(detectFailoverError("404 model not found")).toEqual({ code: "unsupported_model" });
    expect(detectFailoverError("model_not_found: unknown model id")).toEqual({ code: "unsupported_model" });
  });

  it("detects 402 Insufficient Balance (real-world billing-exhausted payload)", () => {
    // The exact error string a user reported in v1.4.0: OpenRouter-style
    // JSON body wrapped in an "Error: 402: …" prefix. Pre-fix this silently
    // returned null (no '402' in the status list, no 'balance' keyword) and
    // left the dead model pinned forever.
    const exact = 'Error: 402: {"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}';
    expect(detectFailoverError(exact)).toEqual({ code: "402" });
  });

  it("detects 402 HTTP status without a body", () => {
    expect(detectFailoverError("Error: 402 Payment Required")).toEqual({ code: "402" });
    expect(detectFailoverError("HTTP 402")).toEqual({ code: "402" });
  });

  it("detects 'insufficient balance' as 402 (keyword path)", () => {
    expect(detectFailoverError("Insufficient Balance for account")).toEqual({ code: "402" });
    expect(detectFailoverError("insufficient_balance on key")).toEqual({ code: "402" });
    expect(detectFailoverError("余额不足，请充值后再试")).toEqual({ code: "402" });
  });

  it("returns null for arbitrary errors", () => {
    expect(detectFailoverError("TypeError: cannot read property of undefined")).toBeNull();
    expect(detectFailoverError("")).toBeNull();
    expect(detectFailoverError(undefined as unknown as string)).toBeNull();
  });

  it("does not misread '500' embedded in a normal message", () => {
    // "500" without an HTTP error context is not a failover signal
    expect(detectFailoverError("the output was 500 tokens")).toBeNull();
    expect(detectFailoverError("cost: 500")).toBeNull();
  });
});

// ─── Same-tier fallback selection (SPEC §8.5.2) ─────────────────────
describe("findFailoverModel — same tier only, skips cooldowns", () => {
  const cfg = (models: { provider: string; model: string; priority: number }[]): ShiftRouterConfig => ({
    ...DEFAULT_CONFIG,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      fast: { ...DEFAULT_CONFIG.tiers.fast, models },
      smart: { ...DEFAULT_CONFIG.tiers.smart, models: [
        { provider: "smart-p", model: "smart-m", priority: 1 },
      ]},
    },
  });
  const registry = {
    find: (p: string, m: string) => ({ provider: p, modelId: m }),
  };

  it("picks the next healthy model when primary is in cooldown", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "M3", NOW);

    const r = findFailoverModel("fast", config, registry, cd, NOW);
    expect(r).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash", tier: "fast" });
  });

  it("returns null when all models in the tier are in cooldown", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "M3", NOW);
    markModelFailed(cd, "deepseek", "deepseek-v4-flash", NOW);

    expect(findFailoverModel("fast", config, registry, cd, NOW)).toBeNull();
  });

  it("never crosses tiers (smart model not considered for fast tier)", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
    ]);
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "M3", NOW);

    // Fast tier is fully in cooldown — smart model must NOT be used
    expect(findFailoverModel("fast", config, registry, cd, NOW)).toBeNull();
  });

  it("returns primary when it is not in cooldown", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const cd = createCooldowns();

    const r = findFailoverModel("fast", config, registry, cd, NOW);
    expect(r?.modelId).toBe("M3");
  });

  it("ignores cooldowns that have already expired", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const cd = createCooldowns();
    markModelFailed(cd, "minimax", "M3", NOW);

    // After expiry, M3 becomes eligible again
    const r = findFailoverModel("fast", config, registry, cd, NOW + MIN + 1);
    expect(r?.modelId).toBe("M3");
  });

  it("works without a cooldowns map (no cooling)", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
    ]);
    const r = findFailoverModel("fast", config, registry, undefined, NOW);
    expect(r?.modelId).toBe("M3");
  });

  it("records and trims speed samples", () => {
    const speeds: number[] = [];
    recordSpeed(speeds, 10);
    expect(speeds).toEqual([10]);
    recordSpeed(speeds, 20);
    recordSpeed(speeds, 30);
    expect(speeds).toEqual([10, 20, 30]);
    recordSpeed(speeds, 40);
    recordSpeed(speeds, 50);
    recordSpeed(speeds, 60); // pushes out first
    expect(speeds.length).toBe(5);
    expect(speeds[0]).toBe(20);
  });

  it("tokensPerSecond returns 0 for invalid inputs", () => {
    expect(tokensPerSecond(0, 1000)).toBe(0);
    expect(tokensPerSecond(100, 0)).toBe(0);
    expect(tokensPerSecond(100, -1)).toBe(0);
  });

  it("tokensPerSecond rounds correctly", () => {
    // 100 tokens in 2000ms = 50 tok/s
    expect(tokensPerSecond(100, 2000)).toBe(50);
    // 30 tokens in 1500ms = 20 tok/s
    expect(tokensPerSecond(30, 1500)).toBe(20);
  });

  it("supports excluding the current model (immediate failover)", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const cd = createCooldowns();

    // Current is M3, not yet cooled — but for immediate failover we want
    // to skip it and go straight to the next one.
    const r = findFailoverModel(
      "fast", config, registry, cd, NOW,
      modelKey("minimax", "M3"),
    );
    expect(r).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash", tier: "fast" });
  });
});

// ─── Cooldown-aware findBestModelForTier ───────────────────────────
describe("findBestModelForTier with cooldown predicate", () => {
  const cfg = (models: { provider: string; model: string; priority: number }[]): ShiftRouterConfig => ({
    ...DEFAULT_CONFIG,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      fast: { ...DEFAULT_CONFIG.tiers.fast, models },
    },
  });
  const registry = {
    find: (p: string, m: string) => ({ provider: p, modelId: m }),
  };

  it("skips cooled models and picks next available", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const isCooldown = (p: string, m: string) => p === "minimax" && m === "M3";

    const r = findBestModelForTier("fast", config, registry, isCooldown);
    expect(r?.modelId).toBe("deepseek-v4-flash");
  });

  it("returns null when all models are cooled", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);
    const isCooldown = () => true;

    expect(findBestModelForTier("fast", config, registry, isCooldown)).toBeNull();
  });

  it("ignores predicate when omitted (backward compatible)", () => {
    const config = cfg([
      { provider: "minimax", model: "M3", priority: 1 },
    ]);
    const r = findBestModelForTier("fast", config, registry);
    expect(r?.modelId).toBe("M3");
  });
});

// ─── Cooldown-aware processRoute ───────────────────────────────────
describe("processRoute respects model cooldowns", () => {
  const makeConfig = (): ShiftRouterConfig => ({
    ...DEFAULT_CONFIG,
    tiers: {
      fast: { label: "Fast", models: [
        { provider: "minimax", model: "M3", priority: 1 },
        { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
      ], description: "" },
      smart: { label: "Smart", models: [
        { provider: "smart-p", model: "smart-m", priority: 1 },
      ], description: "" },
    },
  });
  const registry = { find: (p: string, m: string) => ({ provider: p, modelId: m }) };

  it("upgrade picks fallback when primary is cooled", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "minimax";
    state.currentModelId = "M3";
    markModelFailed(state.modelCooldowns, "smart-p", "smart-m", NOW);
    const config = makeConfig();

    const d = processRoute({ tier: "smart", source: "llm" }, state, config, registry, NOW);
    // All smart models are cooled → no switch available → stay (keep current fast)
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });

  it("upgrade picks the healthy smart model when primary cooled but fallback exists", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const config: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { label: "Fast", models: [
          { provider: "minimax", model: "M3", priority: 1 },
        ], description: "" },
        smart: { label: "Smart", models: [
          { provider: "smart-p", model: "smart-a", priority: 1 },
          { provider: "smart-p", model: "smart-b", priority: 2 },
        ], description: "" },
      },
    };
    markModelFailed(state.modelCooldowns, "smart-p", "smart-a", NOW);

    const d = processRoute({ tier: "smart", source: "llm" }, state, config, registry, NOW);
    expect(d.action).toBe("upgrade");
    expect(d.switchTo?.modelId).toBe("smart-b");
  });

  it("manual override bypasses cooldowns entirely", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.manualOverride = { active: true, provider: "smart-p", modelId: "smart-a" };
    markModelFailed(state.modelCooldowns, "smart-p", "smart-a", NOW);
    const config = makeConfig();

    const d = processRoute({ tier: "fast", source: "llm" }, state, config, registry);
    expect(d.action).toBe("manual");
    expect(d.switchTo?.modelId).toBe("smart-a"); // cooled but forced
  });

  it("initializes modelCooldowns on createRouterState", () => {
    const state = createRouterState();
    expect(state.modelCooldowns).toBeInstanceOf(Map);
    expect(state.modelCooldowns.size).toBe(0);
  });
});

// ─── agent_end throughput fallback ────────────────────────────────
describe("recordTurnThroughputFallback", () => {
  const msgs = (list: Array<[string, number, number]>) =>
    list.map(([role, ts, output]) => ({
      role,
      timestamp: ts,
      ...(role === "assistant" ? { usage: { output } } : {}),
    }));

  it("records the last assistant message's speed when the primary path recorded nothing this turn", () => {
    const state = createRouterState();
    const ok = recordTurnThroughputFallback(
      msgs([
        ["user", 1000, 0],
        ["assistant", 5000, 400], // 100 tok/s
        ["toolResult", 5200, 0],
        ["assistant", 8000, 300], // 100 tok/s (300/3s)
      ]),
      state,
      false,
    );
    expect(ok).toBe(true);
    expect(state.recentSpeeds.length).toBe(1);
    expect(state.recentSpeeds[0]).toBe(107); // last assistant: 300 tok / 2.8s
  });

  it("does NOT run when the primary path already recorded this turn (turn-scoped guard)", () => {
    const state = createRouterState();
    const ok = recordTurnThroughputFallback(
      msgs([
        ["user", 1000, 0],
        ["assistant", 5000, 400],
      ]),
      state,
      true,
    );
    expect(ok).toBe(false);
    expect(state.recentSpeeds).toEqual([]);
  });

  it("REGRESSION (Bug A): runs even when EARLIER turns populated the window — the guard is turn-scoped, not session-scoped", () => {
    // Pre-fix, the guard `recentSpeeds.length > 0` saw samples recorded by
    // previous turns and permanently disabled the fallback — providers with
    // broken message_start timing (e.g. MiniMax) lost their TPS indicator for
    // the rest of the session after any working primary recording.
    const state = createRouterState();
    recordSpeed(state.recentSpeeds, 250); // stale sample from an earlier turn
    const ok = recordTurnThroughputFallback(
      msgs([
        ["user", 1000, 0],
        ["assistant", 5000, 400],
      ]),
      state,
      false,
    );
    expect(ok).toBe(true);
    expect(state.recentSpeeds).toEqual([250, 100]); // 400 tok / 4s = 100
  });

  it("skips messages without output tokens or timestamps", () => {
    const state = createRouterState();
    const ok = recordTurnThroughputFallback(
      [
        { role: "user", timestamp: 1000 },
        { role: "assistant", timestamp: 5000, usage: { output: 0 } },
        { role: "assistant", timestamp: undefined, usage: { output: 100 } },
        { role: "assistant" }, // no timestamp at all
      ],
      state,
      false,
    );
    expect(ok).toBe(false);
    expect(state.recentSpeeds).toEqual([]);
  });

  it("needs a preceding message timestamp to estimate elapsed", () => {
    const state = createRouterState();
    const ok = recordTurnThroughputFallback(
      [{ role: "assistant", timestamp: 5000, usage: { output: 100 } }],
      state,
      false,
    );
    expect(ok).toBe(false);
  });
});

// ─── TPS smoothing (v1.4.2): median display + measurement-noise floor ──
describe("medianSpeed", () => {
  it("returns 0 for an empty window", () => {
    expect(medianSpeed([])).toBe(0);
  });

  it("passes a single sample through", () => {
    expect(medianSpeed([40])).toBe(40);
  });

  it("odd count takes the middle value", () => {
    expect(medianSpeed([40, 41, 380, 42, 40])).toBe(41);
  });

  it("even count averages the two middle values", () => {
    expect(medianSpeed([40, 400])).toBe(220);
    expect(medianSpeed([38, 40, 42, 400])).toBe(41);
  });

  it("a single wild spike does not move the median (the reported symptom)", () => {
    // Should read ~40 tok/s; one artifact sample at ~10x must not shift it.
    expect(medianSpeed([40, 42, 380, 41, 40])).toBe(41);
    expect(medianSpeed([380, 40, 41])).toBe(41);
  });
});

describe("tokensPerSecond measurement-noise floor", () => {
  it("exposes MIN_STREAM_ELAPSED_MS = 50", () => {
    expect(MIN_STREAM_ELAPSED_MS).toBe(50);
  });

  it("returns 0 below the floor (start-time misalignment artifact, the TPS spike source)", () => {
    // 2000 tokens "in" 49ms is not a 40k tok/s model — it is a message_start
    // that arrived late or a clock artifact. Never record it.
    expect(tokensPerSecond(2000, 49)).toBe(0);
    expect(tokensPerSecond(50, 10)).toBe(0);
  });

  it("still measures normally at and above the floor", () => {
    expect(tokensPerSecond(2000, 50)).toBe(40_000);
    expect(tokensPerSecond(400, 10_000)).toBe(40);
    expect(tokensPerSecond(0, 10_000)).toBe(0);
    expect(tokensPerSecond(100, 0)).toBe(0);
  });
});
