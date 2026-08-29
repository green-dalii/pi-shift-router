/**
 * pi-shift-router — Routing engine tests
 *
 * Two-tier (fast/smart) routing algorithm tests:
 *   - Upgrade (fast → smart): immediate
 *   - Downgrade (smart → fast): requires window majority
 *   - Manual override bypasses all routing
 *   - Fallback when judge unavailable
 */

import { describe, it, expect, vi } from "vitest";
import {
  createRouterState,
  processRoute,
  syncSessionModel,
  type RouterState,
} from "../src/router.js";
import type { ShiftRouterConfig, JudgeResult, Tier } from "../src/types.js";

function makeRegistry() {
  return { find: (provider: string, modelId: string) => ({ provider, modelId }) };
}

function makeConfig(overrides: Partial<ShiftRouterConfig> = {}): ShiftRouterConfig {
  return {
    enabled: true,
    tiers: {
      fast:  { label: "Fast",  models: [{ provider: "p", model: "fast-model",  priority: 1 }], description: "" },
      smart: { label: "Smart", models: [{ provider: "p", model: "smart-model", priority: 1 }], description: "" },
    },
    routing: {
      mode: "auto",
      judgeTimeout: 5000,
      window: { size: 5, minConfidence: 0.5 },
      economics: { reworkPenalty: 3, downgradeMemory: 2 },
    },
    ux: { quietMode: false, statusBar: true, inlineToast: true },
    ...overrides,
  } as ShiftRouterConfig;
}

function judge(tier: Tier): JudgeResult {
  return { tier, source: "llm" };
}

function step(state: RouterState, config: ShiftRouterConfig, j: JudgeResult) {
  return processRoute(j, state, config, makeRegistry());
}

// ─── Upgrade (immediate) ──────────────────────────────────────────
describe("Upgrade is immediate", () => {
  it("fast → smart on any smart judge", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const config = makeConfig();

    const d = step(state, config, judge("smart"));
    expect(d.action).toBe("upgrade");
    expect(d.switchTo?.tier).toBe("smart");
    // Window cleared on upgrade
    expect(state.window.length).toBe(0);
  });

  it("fast stays fast on confident fast judge (no upgrade needed)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });
});

// ─── Downgrade gating (streak semantics, SPEC §2.3) ───────────────
describe("Downgrade from smart requires downgradeMemory consecutive fast decisions", () => {
  it("smart stays when window has only smart entries", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    state.window = [
      { tier: "smart", timestamp: 0 },
      { tier: "smart", timestamp: 0 },
      { tier: "smart", timestamp: 0 },
    ];
    const config = makeConfig();

    const d = step(state, config, judge("smart"));
    expect(d.action).toBe("stay");
  });

  it("smart stays on a single fast decision (streak < downgradeMemory)", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    state.window = [
      { tier: "fast", timestamp: 0 },
      { tier: "smart", timestamp: 0 },
      { tier: "smart", timestamp: 0 },
    ];
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("stay");
  });

  it("smart downgrades after downgradeMemory consecutive fast decisions", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    state.window = [
      { tier: "fast", timestamp: 0 },
      { tier: "fast", timestamp: 0 },
      { tier: "fast", timestamp: 0 },
    ];
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("downgrade");
    expect(d.switchTo?.tier).toBe("fast");
  });

  it("fast never downgrades further (already bottom)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("stay");
  });
});

// ─── Stay ─────────────────────────────────────────────────────────
describe("Stay action", () => {
  it("returns no switchTo on stay", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });

  it("smart stays on smart judge (window entry still pushed)", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    const config = makeConfig();

    const d = step(state, config, judge("smart"));
    expect(d.action).toBe("stay");
    // Window entry still pushed for tracking
    expect(state.window.length).toBeGreaterThan(0);
  });
});

// ─── Window size cap ──────────────────────────────────────────────
describe("Window size cap", () => {
  it("discards oldest entries beyond window size", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.window = Array.from({ length: 8 }, (_, i) => ({ tier: "fast" as Tier, timestamp: i }));
    const config = makeConfig(); // window.size = 5

    step(state, config, judge("fast"));
    expect(state.window.length).toBeLessThanOrEqual(5);
  });
});

// ─── Judge fallback ──────────────────────────────────────────────
describe("Judge fallback", () => {
  it("returns fast when no LLM endpoint provided", async () => {
    const { classify } = await import("../src/judge.js");
    const r = await classify("anything", null);
    expect(r.tier).toBe("fast");
    expect(r.source).toBe("fallback");
  });
});

// ─── Manual override ──────────────────────────────────────────────
describe("Manual override", () => {
  it("bypasses routing entirely when active (by tier)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.manualOverride = { active: true, tier: "smart" };
    const config = makeConfig();

    const d = step(state, config, judge("fast")); // judge says stay
    expect(d.action).toBe("manual");
    expect(d.switchTo?.tier).toBe("smart");
    expect(d.switchTo?.modelId).toBe("smart-model");
  });

  it("bypasses routing when active (by exact model)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.manualOverride = {
      active: true,
      provider: "anthropic",
      modelId: "claude-opus-4",
    };
    const config = makeConfig();

    const d = step(state, config, judge("fast"));
    expect(d.action).toBe("manual");
    expect(d.switchTo?.provider).toBe("anthropic");
    expect(d.switchTo?.modelId).toBe("claude-opus-4");
  });
});

// ─── applyModelSwitch / manual override helpers ──────────────────
import {
  applyModelSwitch,
  clearManualOverride,
  setManualOverrideTier,
  setManualOverrideModel,
} from "../src/router.js";

describe("applyModelSwitch", () => {
  it("finds the model and updates state on success", async () => {
    const state = createRouterState();
    const registry = { find: (p: string, m: string) => ({ provider: p, modelId: m }) };
    const setModel = async () => true;

    const ok = await applyModelSwitch(
      { provider: "p", modelId: "fast-model", tier: "fast" },
      state,
      registry,
      setModel,
    );

    expect(ok).toBe(true);
    expect(state.currentTier).toBe("fast");
    expect(state.currentModelId).toBe("fast-model");
    expect(state.currentProvider).toBe("p");
  });

  it("returns false and warns when model is not in the registry", async () => {
    const state = createRouterState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await applyModelSwitch(
      { provider: "missing", modelId: "nope", tier: "smart" },
      state,
      { find: () => undefined },
      async () => true,
    );

    expect(ok).toBe(false);
    expect(state.currentTier).toBe("fast"); // unchanged default
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Model not found: missing/nope"),
    );
    warn.mockRestore();
  });

  it("does not update state when setModel returns false", async () => {
    const state = createRouterState();
    const ok = await applyModelSwitch(
      { provider: "p", modelId: "smart-model", tier: "smart" },
      state,
      makeRegistry(),
      async () => false,
    );

    expect(ok).toBe(false);
    expect(state.currentModelId).toBeNull();
  });

  it("catches a setModel throw and returns false", async () => {
    const state = createRouterState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await applyModelSwitch(
      { provider: "p", modelId: "x", tier: "fast" },
      state,
      makeRegistry(),
      async () => {
        throw new Error("boom");
      },
    );

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Model switch failed"));
    warn.mockRestore();
  });
});

describe("manual override helpers", () => {
  it("clearManualOverride resets to inactive", () => {
    const state = createRouterState();
    state.manualOverride = { active: true, tier: "smart" };
    clearManualOverride(state);
    expect(state.manualOverride).toEqual({ active: false });
  });

  it("setManualOverrideTier pins a tier", () => {
    const state = createRouterState();
    setManualOverrideTier(state, "fast");
    expect(state.manualOverride).toEqual({ active: true, tier: "fast" });
  });

  it("setManualOverrideModel pins an exact model", () => {
    const state = createRouterState();
    setManualOverrideModel(state, "anthropic", "claude-opus-4");
    expect(state.manualOverride).toEqual({
      active: true,
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
  });
});


// ─── syncSessionModel: display follows the ACTUAL session model ────
describe("syncSessionModel (model_select sync)", () => {
  it("updates provider/modelId and re-infers tier from membership", () => {
    const config = makeConfig();
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";

    const changed = syncSessionModel(state, config, "p", "fast-model");
    expect(changed).toBe(true);
    expect(state.currentTier).toBe("fast");
    expect(state.currentProvider).toBe("p");
    expect(currentModelIdIs(state, "fast-model")).toBe(true);
  });

  it("keeps last tier for models outside both tiers (display-only)", () => {
    const config = makeConfig();
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = "fast-model";

    const changed = syncSessionModel(state, config, "other", "mystery-model");
    expect(changed).toBe(false);
    expect(state.currentTier).toBe("fast"); // badge emoji stays on last known tier
    expect(currentModelIdIs(state, "mystery-model")).toBe(true);
    expect(state.currentProvider).toBe("other");
  });

  it("same-tier re-select reports no tier change", () => {
    const config = makeConfig();
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";

    expect(syncSessionModel(state, config, "p", "fast-model")).toBe(false);
  });
});

function currentModelIdIs(state: RouterState, id: string): boolean {
  return state.currentModelId === id;
}
