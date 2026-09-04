/**
 * pi-shift-router — Status-bar label tests (SPEC §8.x display contract).
 *
 * - The wand 🪄 appears ONLY while workers are actually spawned (spawned > 0).
 *   A planning frame (active, spawned = 0) — or a leaked orchestration state
 *   that survived an interrupted turn — shows the plain tier badge.
 * - A null currentModelId falls back to the tier's best resolvable model,
 *   marked `?` (intended, not confirmed) instead of a bare `…`.
 */

import { describe, expect, it } from "vitest";
import { createRouterState } from "../src/router.js";
import { formatStatusBarLabel } from "../src/status-bar.js";
import { formatTierDisplay, formatTierDisplayWithSpeed } from "../src/tier.js";
import type { ShiftRouterConfig } from "../src/types.js";

function makeConfig(overrides: Partial<ShiftRouterConfig> = {}): ShiftRouterConfig {
  return {
    enabled: true,
    tiers: {
      fast: { label: "Fast", models: [{ provider: "p", model: "fast-model", priority: 1 }], description: "" },
      smart: { label: "Smart", models: [{ provider: "p", model: "smart-model", priority: 1 }], description: "" },
    },
    routing: {
      mode: "auto",
      judgeTimeout: 5000,
      window: { size: 5, minConfidence: 0.5 },
      economics: { reworkPenalty: 3, downgradeMemory: 2 },
    },
    orchestration: { mode: "auto", maxRounds: 3, escalationThreshold: 2, requireSmartModel: true },
    ux: { quietMode: false, statusBar: true, inlineToast: true },
    ...overrides,
  } as ShiftRouterConfig;
}

const registry = { find: (p: string, m: string) => ({ provider: p, modelId: m }) };

describe("formatStatusBarLabel", () => {
  it("plain fast turn shows the tier badge with model + speed", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = "p/fast-model";
    state.recentSpeeds = [23];
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("[🦾 fast-model] • 23 tok/s");
  });

  it("no speed reading → bare badge", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentModelId = "smart-model";
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("[🧠 smart-model]");
  });

  it("planning phase (orchestration active, spawned = 0) shows NO wand — plain badge", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentModelId = "smart-model";
    state.orchestration.active = true;
    state.orchestration.spawned = 0;
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("[🧠 smart-model]");
  });

  it("delegation in flight (spawned > 0) shows the wand + worker counts", () => {
    const state = createRouterState();
    state.orchestration.active = true;
    state.orchestration.spawned = 3;
    state.orchestration.done = 2;
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("🪄 Done(2)/Total(3)");
  });

  it("delegation shows median worker throughput when readings exist", () => {
    const state = createRouterState();
    state.orchestration.active = true;
    state.orchestration.spawned = 2;
    state.orchestration.done = 2;
    state.orchestration.workerSpeeds = [20, 30];
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("🪄 Done(2)/Total(2) • ~25 tok/s");
  });

  it("plain turn shows the MEDIAN of recent speeds, not the last sample (spike-proof)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = "p/fast-model";
    // One artifact spike (~10x) among honest ~40 tok/s readings.
    state.recentSpeeds = [40, 42, 380, 41, 40];
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("[🦾 fast-model] • 41 tok/s");
  });

  it("delegation label also uses the median of worker speeds (spike-proof)", () => {
    const state = createRouterState();
    state.orchestration.active = true;
    state.orchestration.spawned = 3;
    state.orchestration.done = 3;
    state.orchestration.workerSpeeds = [40, 380, 42];
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("🪄 Done(3)/Total(3) • ~42 tok/s");
  });

  it("cap hit is surfaced on the delegation label", () => {
    const cfg = makeConfig();
    const state = createRouterState();
    state.orchestration.active = true;
    state.orchestration.spawned = 3;
    state.orchestration.done = 3;
    state.orchestration.rounds = cfg.orchestration.maxRounds; // hard cap reached
    expect(formatStatusBarLabel(cfg, state, registry)).toBe("🪄 Done(3)/Total(3) ⛔cap");
  });

  it("null currentModelId falls back to the tier's best model, marked ?", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = null; // switch never confirmed (e.g. auth refused)
    expect(formatStatusBarLabel(makeConfig(), state, registry)).toBe("[🦾 fast-model?]");
  });

  it("null currentModelId without a registry keeps the bare fallback", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = null;
    expect(formatStatusBarLabel(makeConfig(), state)).toBe("[🦾 …]");
  });

  it("disabled router shows the ⛔ badge", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentModelId = "p/fast-model";
    const cfg = makeConfig({ enabled: false });
    expect(formatStatusBarLabel(cfg, state, registry)).toBe("⛔");
  });

  it("returns undefined when the status bar is disabled", () => {
    const state = createRouterState();
    const cfg = makeConfig({ ux: { quietMode: false, statusBar: false, inlineToast: true } });
    expect(formatStatusBarLabel(cfg, state, registry)).toBeUndefined();
  });
});

describe("formatTierDisplay uncertain marker", () => {
  it("marks an unconfirmed model with ?", () => {
    expect(formatTierDisplay("fast", "p/fast-model", true)).toBe("[🦾 fast-model?]");
  });
  it("keeps the bare … fallback when even the intended model is unknown", () => {
    expect(formatTierDisplay("smart", null, true)).toBe("[🧠 …]");
  });
  it("withSpeed passes the marker through", () => {
    expect(formatTierDisplayWithSpeed("fast", "p/fast-model", 10, true)).toBe("[🦾 fast-model?] • 10 tok/s");
  });
});
