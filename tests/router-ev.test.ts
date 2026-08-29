/**
 * pi-shift-router — EV routing + model authority tests (SPEC §2.3/§2.4)
 *
 * New contract (v1.4.0):
 * - Tier decisions come from an expected-cost rule over judge confidence:
 *   pSmart = c (smart) or 1−c (fast); θ = 1/reworkPenalty.
 *   confidence < minConfidence → hold (no signal, breaks fast streak).
 * - Upgrade fires on any decisive smart decision (immediate).
 * - Downgrade requires `downgradeMemory` consecutive decisive fast decisions
 *   plus the cache-aware idle gate.
 * - Strict takeover: processRoute always returns the model the turn must run
 *   on — the best available model of the running tier (cooldown-aware).
 *   A current model that differs (incl. user /model or session default)
 *   produces an "enforce" switch; equality is a no-op ("stay").
 */

import { describe, expect, it } from "vitest";
import {
  createRouterState,
  processRoute,
  applyModelSwitch,
  analyzeDowngrade,
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

function judge(tier: Tier, confidence = 1.0): JudgeResult {
  return { tier, confidence, source: "llm" };
}

function step(state: RouterState, config: ShiftRouterConfig, j: JudgeResult) {
  return processRoute(j, state, config, makeRegistry());
}

// ─── EV decision: upgrades ────────────────────────────────────────
describe("EV rule — upgrade (fast → smart)", () => {
  it("confident smart verdict upgrades immediately", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const d = step(state, makeConfig(), judge("smart", 0.9));
    expect(d.action).toBe("upgrade");
    expect(d.switchTo?.tier).toBe("smart");
    expect(state.window.length).toBe(0); // cleared on upgrade
  });

  it("uncertain fast verdict upgrades (pSmart = 1−c ≥ θ)", () => {
    // θ = 1/3 ≈ 0.33; fast verdict c=0.6 → pSmart=0.4 ≥ 0.33 → smart
    const state = createRouterState();
    state.currentTier = "fast";
    const d = step(state, makeConfig(), judge("fast", 0.6));
    expect(d.action).toBe("upgrade");
    expect(d.switchTo?.tier).toBe("smart");
  });

  it("confident fast verdict stays fast", () => {
    // pSmart = 0.1 < 0.33 → fast; current model already the fast-chain best → no-op
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const d = step(state, makeConfig(), judge("fast", 0.9));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });

  it("weak smart verdict is overridden to fast (confidence gate)", () => {
    // smart c=0.2 → pSmart=0.2 < 0.33 → fast decision, no upgrade
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const d = step(state, makeConfig(), judge("smart", 0.2));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
    expect(state.window[state.window.length - 1]?.tier).toBe("fast"); // fast decision recorded
  });
});

// ─── EV decision: hold ────────────────────────────────────────────
describe("EV rule — low confidence holds", () => {
  it("confidence below minConfidence never switches (smart verdict)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const d = step(state, makeConfig(), judge("smart", 0.4)); // < 0.5
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
    const last = state.window[state.window.length - 1];
    expect(last?.hold).toBe(true);
  });

  it("confidence below minConfidence never switches (fast verdict)", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    const d = step(state, makeConfig(), judge("fast", 0.3)); // < 0.5
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });
});

// ─── EV decision: downgrade streak ────────────────────────────────
describe("EV rule — downgrade requires downgradeMemory consecutive fast decisions", () => {
  it("single fast decision does NOT downgrade", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    const d = step(state, makeConfig(), judge("fast", 0.95));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });

  it("two consecutive fast decisions downgrade", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    // 1st fast decision (window records it)
    step(state, makeConfig(), judge("fast", 0.95));
    // 2nd consecutive fast decision
    const d = step(state, makeConfig(), judge("fast", 0.95));
    expect(d.action).toBe("downgrade");
    expect(d.switchTo?.tier).toBe("fast");
  });

  it("a smart decision resets the streak", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    step(state, makeConfig(), judge("fast", 0.95));
    step(state, makeConfig(), judge("smart", 0.9));
    const d = step(state, makeConfig(), judge("fast", 0.95));
    expect(d.action).toBe("stay"); // streak restarted at 1
  });

  it("a hold breaks the streak", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    step(state, makeConfig(), judge("fast", 0.95));
    step(state, makeConfig(), judge("smart", 0.4)); // hold
    const d = step(state, makeConfig(), judge("fast", 0.95));
    expect(d.action).toBe("stay"); // hold reset trailing fast count
  });
});

describe("analyzeDowngrade", () => {
  it("counts trailing decisive fast entries against downgradeMemory", () => {
    const cfg = makeConfig();
    const win = [
      { tier: "smart" as const, timestamp: 0 },
      { tier: "fast" as const, timestamp: 0 },
      { tier: "fast" as const, timestamp: 0 },
    ];
    const r = analyzeDowngrade(win, "smart", cfg);
    expect(r.shouldDowngrade).toBe(true);
  });
  it("does not downgrade from fast", () => {
    const r = analyzeDowngrade([{ tier: "fast" as const, timestamp: 0 }], "fast", makeConfig());
    expect(r.shouldDowngrade).toBe(false);
  });
  it("does not downgrade with a single trailing fast", () => {
    const r = analyzeDowngrade([{ tier: "fast" as const, timestamp: 0 }], "smart", makeConfig());
    expect(r.shouldDowngrade).toBe(false);
  });
});

// ─── θ derivation ─────────────────────────────────────────────────
describe("θ derivation (economics + legacy migration)", () => {
  it("default reworkPenalty 3 → θ = 1/3: fast c=0.6 upgrades, fast c=0.9 stays", () => {
    const cfg = makeConfig();
    const s1 = createRouterState();
    s1.currentTier = "fast";
    expect(step(s1, cfg, judge("fast", 0.6)).action).toBe("upgrade");
    const s2 = createRouterState();
    s2.currentTier = "fast";
    s2.currentProvider = "p";
    s2.currentModelId = "fast-model";
    expect(step(s2, cfg, judge("fast", 0.9)).action).toBe("stay");
  });

  it("explicit window.threshold acts as a raw θ override", () => {
    const cfg = makeConfig({
      routing: { mode: "auto", judgeTimeout: 5000, window: { size: 5, threshold: 0.6, minConfidence: 0.5 } },
    });
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    // smart c=0.5 → pSmart=0.5 < 0.6 → fast decision → no upgrade
    const d = step(state, cfg, judge("smart", 0.5));
    expect(d.action).toBe("stay");
  });

  it("cache-aware same-family lowers effective θ (fewer fast decisions)", () => {
    const sameFamily = makeConfig({
      routing: {
        mode: "auto",
        judgeTimeout: 5000,
        window: { size: 5, minConfidence: 0.5 },
        economics: { reworkPenalty: 3, downgradeMemory: 2 },
        cacheAware: { enabled: true, sameFamilyPenalty: 2, idleBoundaryMs: 300000 },
      },
    });
    // fast c=0.7 → pSmart=0.3; θ=0.33/2=0.165 → 0.3 ≥ 0.165 → smart decision
    const state = createRouterState();
    state.currentTier = "fast";
    const d = step(state, sameFamily, judge("fast", 0.7));
    expect(d.action).toBe("upgrade");
  });

  it("legacy sameFamilyThreshold implies strong same-family conservatism", () => {
    const legacy = makeConfig({
      routing: {
        mode: "auto",
        judgeTimeout: 5000,
        window: { size: 5, minConfidence: 0.5 },
        economics: { reworkPenalty: 3, downgradeMemory: 2 },
        cacheAware: { enabled: true, sameFamilyThreshold: 0.9, idleBoundaryMs: 300000 },
      },
    });
    // fast c=0.95 → pSmart=0.05; θ=0.33/3=0.11 → 0.05 < 0.11 → fast decision (downgrade eligible)
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    const d = step(state, legacy, judge("fast", 0.95));
    expect(d.action).toBe("stay"); // streak = 1, not 2 yet
  });
});

// ─── Strict takeover (model authority) ────────────────────────────
describe("Strict takeover — model authority (SPEC §2.4)", () => {
  it("first turn (no model set) enforces the tier's best model", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const d = step(state, makeConfig(), judge("fast", 0.9));
    expect(d.action).toBe("enforce");
    expect(d.switchTo).toEqual({ provider: "p", modelId: "fast-model", tier: "fast" });
  });

  it("user-selected out-of-chain model is corrected to the tier best", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "other";
    state.currentModelId = "whatever";
    const d = step(state, makeConfig(), judge("fast", 0.9));
    expect(d.action).toBe("enforce");
    expect(d.switchTo?.modelId).toBe("fast-model");
  });

  it("current model already the tier best → stay (no redundant setModel)", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "smart-model";
    const d = step(state, makeConfig(), judge("smart", 0.9));
    expect(d.action).toBe("stay");
    expect(d.switchTo).toBeNull();
  });

  it("manual override bypasses takeover", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    state.manualOverride = { active: true, provider: "p", modelId: "manual-model" };
    const d = step(state, makeConfig(), judge("smart", 0.9));
    expect(d.action).toBe("manual");
    expect(d.switchTo?.modelId).toBe("manual-model");
  });

  it("enforces the running tier after an upgrade decision", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    const d = step(state, makeConfig(), judge("smart", 0.9));
    expect(d.action).toBe("upgrade");
    expect(d.switchTo).toEqual({ provider: "p", modelId: "smart-model", tier: "smart" });
  });
});

// ─── applyModelSwitch no-op ───────────────────────────────────────
describe("applyModelSwitch no-op on identical model", () => {
  it("skips setModel when provider/model already active", async () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    let calls = 0;
    const ok = await applyModelSwitch(
      { provider: "p", modelId: "fast-model", tier: "fast" },
      state,
      makeRegistry(),
      async () => { calls += 1; return true; },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("still switches when the model differs", async () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "fast-model";
    let calls = 0;
    const ok = await applyModelSwitch(
      { provider: "p", modelId: "smart-model", tier: "smart" },
      state,
      makeRegistry(),
      async () => { calls += 1; return true; },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(state.currentModelId).toBe("smart-model");
  });
});
