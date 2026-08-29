/**
 * pi-shift-router — Cache-aware routing tests (SPEC §9.2 + §2.3)
 *
 * When fast and smart resolve to the same provider family, a mid-session
 * downgrade forfeits the warm prompt cache (reads bill 0.1x–0.5x of base
 * input). Cache-aware routing LOWERS the effective θ (fewer fast decisions →
 * fewer downgrades) and suppresses downgrades while the cache is warm,
 * only allowing them after an idle boundary long enough that the cache has
 * already expired.
 *
 * Covered here:
 *   - shareProviderFamily: same-provider detection
 *   - effectiveTheta: θ = 1/reworkPenalty; ÷ sameFamilyPenalty when on;
 *     legacy sameFamilyThreshold implies the strong factor 3.0
 *   - downgradeAllowedAt: session-boundary gate
 *   - processRoute end-to-end: downgrade suppressed on warm cache,
 *     allowed after idle boundary, unchanged when disabled
 */

import { describe, it, expect } from "vitest";
import {
  createRouterState,
  processRoute,
  analyzeDowngrade,
  shareProviderFamily,
  effectiveTheta,
  downgradeAllowedAt,
  type RouteDecision,
} from "../src/router.js";
import type { ShiftRouterConfig, JudgeResult, Tier } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const IDLE_BOUNDARY = 5 * 60_000; // 5 min, matches DEFAULT_CONFIG

function makeConfig(overrides: Partial<ShiftRouterConfig> = {}): ShiftRouterConfig {
  return {
    ...DEFAULT_CONFIG,
    tiers: {
      fast: { label: "Fast", models: [{ provider: "anthropic", model: "claude-sonnet-5", priority: 1 }], description: "" },
      smart: { label: "Smart", models: [{ provider: "anthropic", model: "claude-opus-5", priority: 1 }], description: "" },
    },
    ...overrides,
  };
}

function makeRegistry() {
  return { find: (provider: string, modelId: string) => ({ provider, modelId }) };
}

function judge(tier: Tier, confidence = 1.0): JudgeResult {
  return { tier, confidence, source: "llm" };
}

/** Fill the window with N fast decisions (confidence 1.0). */
function fillFastWindow(state: ReturnType<typeof createRouterState>, n: number, now: number): void {
  for (let i = 0; i < n; i++) {
    state.window.push({ tier: "fast", timestamp: now - 1000, confidence: 1.0 });
  }
}

function step(
  state: ReturnType<typeof createRouterState>,
  config: ShiftRouterConfig,
  j: JudgeResult,
  now: number,
): RouteDecision {
  return processRoute(j, state, config, makeRegistry(), now);
}

// ─── shareProviderFamily ──────────────────────────────────────────
describe("shareProviderFamily", () => {
  it("returns true when both tiers use the same provider", () => {
    const config = makeConfig();
    expect(shareProviderFamily(config)).toBe(true);
  });

  it("returns true when one model in each tier shares a provider among several", () => {
    const config = makeConfig({
      tiers: {
        fast: {
          label: "Fast",
          models: [
            { provider: "openai", model: "gpt-5.6-luna", priority: 2 },
            { provider: "anthropic", model: "claude-sonnet-5", priority: 1 },
          ],
          description: "",
        },
        smart: {
          label: "Smart",
          models: [{ provider: "anthropic", model: "claude-opus-5", priority: 1 }],
          description: "",
        },
      },
    });
    expect(shareProviderFamily(config)).toBe(true);
  });

  it("returns false when tiers use different providers", () => {
    const config = makeConfig({
      tiers: {
        fast: { label: "Fast", models: [{ provider: "openai", model: "gpt-5.6-luna", priority: 1 }], description: "" },
        smart: { label: "Smart", models: [{ provider: "anthropic", model: "claude-opus-5", priority: 1 }], description: "" },
      },
    });
    expect(shareProviderFamily(config)).toBe(false);
  });

  it("returns false when either tier has no models", () => {
    const config = makeConfig({
      tiers: {
        fast: { label: "Fast", models: [], description: "" },
        smart: { label: "Smart", models: [{ provider: "anthropic", model: "claude-opus-5", priority: 1 }], description: "" },
      },
    });
    expect(shareProviderFamily(config)).toBe(false);
  });
});

// ─── effectiveTheta ───────────────────────────────────────────────
describe("effectiveTheta", () => {
  it("θ = 1/reworkPenalty when cache-aware is off", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { ...DEFAULT_CONFIG.routing.cacheAware!, enabled: false },
      },
    });
    expect(effectiveTheta(config, true)).toBeCloseTo(1 / 3, 5); // shareProviderFamily true but enabled=false
  });

  it("divides θ by sameFamilyPenalty when cache-aware is on (same family)", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { enabled: true, sameFamilyPenalty: 2, idleBoundaryMs: IDLE_BOUNDARY },
      },
    });
    expect(effectiveTheta(config, true)).toBeCloseTo(1 / 6, 5);
  });

  it("is on by default for same-family configs (SPEC §9.2): θ = 1/3 ÷ 1.5", () => {
    const config = makeConfig(); // DEFAULT_CONFIG: cacheAware.enabled = true, sameFamilyPenalty 1.5
    expect(shareProviderFamily(config)).toBe(true);
    expect(effectiveTheta(config)).toBeCloseTo((1 / 3) / 1.5, 5);
  });

  it("keeps the base θ when providers differ even if cache-aware is enabled", () => {
    const config = makeConfig({
      tiers: {
        fast: { label: "Fast", models: [{ provider: "openai", model: "gpt-5.6-luna", priority: 1 }], description: "" },
        smart: { label: "Smart", models: [{ provider: "anthropic", model: "claude-opus-5", priority: 1 }], description: "" },
      },
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { enabled: true, sameFamilyPenalty: 2, idleBoundaryMs: IDLE_BOUNDARY },
      },
    });
    expect(effectiveTheta(config, false)).toBeCloseTo(1 / 3, 5);
  });

  it("legacy explicit window.threshold overrides as a raw θ", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        window: { size: 5, threshold: 0.6, minConfidence: 0.5 },
      },
    });
    expect(effectiveTheta(config)).toBe(0.6);
  });

  it("legacy sameFamilyThreshold implies the strong factor 3.0", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { enabled: true, sameFamilyThreshold: 0.9, idleBoundaryMs: IDLE_BOUNDARY },
      },
    });
    expect(effectiveTheta(config, true)).toBeCloseTo((1 / 3) / 3, 5);
  });
});

// ─── downgradeAllowedAt ───────────────────────────────────────────
describe("downgradeAllowedAt", () => {
  const cacheAware = { enabled: true, sameFamilyPenalty: 1.5, idleBoundaryMs: IDLE_BOUNDARY };
  const now = 1_000_000_000_000;

  it("always allows when cache-aware is disabled", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { ...DEFAULT_CONFIG.routing.cacheAware!, enabled: false },
      },
    });
    const state = createRouterState();
    state.lastActivityAt = now - 1000; // very recent message
    expect(downgradeAllowedAt(state, config, now)).toBe(true);
  });

  it("allows when no message has completed yet (nothing cached)", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = createRouterState();
    expect(downgradeAllowedAt(state, config, now)).toBe(true); // lastActivityAt === 0
  });

  it("blocks while the cache is warm (recent activity)", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = createRouterState();
    state.lastActivityAt = now - 60_000; // 1 min ago
    expect(downgradeAllowedAt(state, config, now)).toBe(false);
  });

  it("allows after the idle boundary (cache expired)", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = createRouterState();
    state.lastActivityAt = now - (IDLE_BOUNDARY + 1000);
    expect(downgradeAllowedAt(state, config, now)).toBe(true);
  });

  it("treats the exact boundary as still warm (conservative)", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = createRouterState();
    state.lastActivityAt = now - IDLE_BOUNDARY;
    // Implementation uses strict `>`: at exactly the boundary the cache is
    // still considered live, so the downgrade is blocked.
    expect(downgradeAllowedAt(state, config, now)).toBe(false);
  });
});

// ─── analyzeDowngrade streak semantics ────────────────────────────
describe("analyzeDowngrade (trailing decisive fast streak)", () => {
  it("requires downgradeMemory consecutive trailing fast entries", () => {
    const config = makeConfig();
    const win = [
      { tier: "smart" as Tier, timestamp: 1 },
      { tier: "fast" as Tier, timestamp: 1 },
      { tier: "fast" as Tier, timestamp: 1 },
    ];
    expect(analyzeDowngrade(win, "smart", config).shouldDowngrade).toBe(true); // streak 2
    expect(analyzeDowngrade([{ tier: "fast" as Tier, timestamp: 1 }], "smart", config).shouldDowngrade).toBe(false); // streak 1
  });

  it("a hold entry breaks the streak", () => {
    const config = makeConfig();
    const win = [
      { tier: "fast" as Tier, timestamp: 1 },
      { tier: "fast" as Tier, timestamp: 1, hold: true },
    ];
    expect(analyzeDowngrade(win, "smart", config).shouldDowngrade).toBe(false);
  });

  it("never downgrades from fast", () => {
    expect(analyzeDowngrade([{ tier: "fast" as Tier, timestamp: 1 }], "fast", makeConfig()).shouldDowngrade).toBe(false);
  });
});

// ─── processRoute end-to-end ──────────────────────────────────────
describe("processRoute with cache-aware routing", () => {
  const now = 1_000_000_000_000;
  const cacheAware = { enabled: true, sameFamilyPenalty: 1.5, idleBoundaryMs: IDLE_BOUNDARY };

  function smartState() {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "anthropic";
    state.currentModelId = "claude-opus-5";
    return state;
  }

  it("suppresses a mid-session downgrade while the cache is warm", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = smartState();
    state.lastActivityAt = now - 10_000; // warm cache
    fillFastWindow(state, 5, now);

    const d = step(state, config, judge("fast"), now);
    expect(d.action).toBe("stay"); // downgrade blocked
    expect(d.switchTo).toBeNull();
  });

  it("allows the downgrade after the idle boundary", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = smartState();
    state.lastActivityAt = now - (IDLE_BOUNDARY + 1000); // cache expired
    fillFastWindow(state, 5, now);

    const d = step(state, config, judge("fast"), now);
    expect(d.action).toBe("downgrade");
    expect(d.switchTo?.tier).toBe("fast");
  });

  it("downgrades normally when cache-aware is disabled", () => {
    const config = makeConfig({
      routing: {
        ...DEFAULT_CONFIG.routing,
        cacheAware: { ...DEFAULT_CONFIG.routing.cacheAware!, enabled: false },
      },
    });
    const state = smartState();
    state.lastActivityAt = now - 10_000; // warm, but disabled → no gate
    fillFastWindow(state, 5, now);

    const d = step(state, config, judge("fast"), now);
    expect(d.action).toBe("downgrade");
  });

  it("stays when the fast streak is interrupted by smart decisions", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = smartState();
    state.lastActivityAt = now - (IDLE_BOUNDARY + 1000); // cache cold, gate passes
    for (let i = 0; i < 3; i++) state.window.push({ tier: "fast", timestamp: now - 1000, confidence: 1.0 });
    for (let i = 0; i < 2; i++) state.window.push({ tier: "smart", timestamp: now - 1000, confidence: 1.0 });

    const d = step(state, config, judge("fast"), now);
    // window = [f,f,f,s,s] + current fast → trailing fast streak = 1 < 2 → stay
    expect(d.action).toBe("stay");
  });

  it("does not block upgrades even when cache-aware is on", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = createRouterState();
    state.currentTier = "fast";
    state.lastActivityAt = now - 10_000; // warm cache

    const d = step(state, config, judge("smart", 0.95), now);
    expect(d.action).toBe("upgrade");
    expect(d.switchTo?.tier).toBe("smart");
  });

  it("still downgrades at a sustained fast streak when the cache is cold", () => {
    const config = makeConfig({ routing: { ...DEFAULT_CONFIG.routing, cacheAware } });
    const state = smartState();
    state.lastActivityAt = now - (IDLE_BOUNDARY + 1000);
    fillFastWindow(state, 5, now);

    const d = step(state, config, judge("fast"), now);
    expect(d.action).toBe("downgrade");
  });
});
