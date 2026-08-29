/**
 * pi-shift-router — Turn-failure integration tests
 *
 * Covers the pure helpers that wire runtime failover into pi hooks:
 *   - detectTurnFailure: inspect agent_end messages for a failed turn
 *   - planTurnFailover: mark cooldown + pick same-tier fallback
 */

import { describe, it, expect } from "vitest";
import {
  detectTurnFailure,
  planTurnFailover,
  isModelInCooldown,
  modelKey,
  findTierForModel,
} from "../src/failover.js";
import { createRouterState } from "../src/router.js";
import { DEFAULT_CONFIG, type ShiftRouterConfig } from "../src/types.js";

const NOW = 1_000_000;

function makeConfig(models: { provider: string; model: string; priority: number }[]): ShiftRouterConfig {
  return {
    ...DEFAULT_CONFIG,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      fast: { ...DEFAULT_CONFIG.tiers.fast, models },
    },
  };
}

const registry = { find: (p: string, m: string) => ({ provider: p, modelId: m }) };

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    ...overrides,
  };
}

// ─── detectTurnFailure ─────────────────────────────────────────────
describe("detectTurnFailure", () => {
  it("returns null for a healthy turn", () => {
    const messages = [
      { role: "user", content: [] },
      assistant({ provider: "minimax", model: "M3" }),
    ];
    expect(detectTurnFailure(messages)).toBeNull();
  });

  it("detects a failed final assistant message with 429", () => {
    const messages = [
      { role: "user", content: [] },
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: 'Error: 429 {"type":"error","message":"rate_limit_error"}',
      }),
    ];
    const r = detectTurnFailure(messages);
    expect(r).toEqual({ provider: "minimax", model: "M3", code: "429" });
  });

  it("detects quota exhaustion (token plan)", () => {
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐",
      }),
    ];
    expect(detectTurnFailure(messages)).not.toBeNull();
  });

  it("ignores non-failover errors (400/401)", () => {
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "401 Unauthorized: invalid api key",
      }),
    ];
    expect(detectTurnFailure(messages)).toBeNull();
  });

  it("detects 402 Insufficient Balance on a real-world payload (regression — v1.4.0)", () => {
    // The user's reported failure: pre-fix, neither '402' (not in the status
    // list) nor 'Insufficient Balance' (not in the keyword list) was caught —
    // the dead model stayed pinned and the same 402 fired on every turn.
    const exact = 'Error: 402: {"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}';
    const messages = [
      assistant({
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
        stopReason: "error",
        errorMessage: exact,
      }),
    ];
    expect(detectTurnFailure(messages)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      code: "402",
    });
  });

  it("returns null when transcript is empty", () => {
    expect(detectTurnFailure([])).toBeNull();
  });

  it("only considers the LAST assistant message", () => {
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "Error: 429 rate limit", // earlier failure — should be ignored
      }),
      assistant({ provider: "deepseek", model: "deepseek-v4-flash" }),
    ];
    expect(detectTurnFailure(messages)).toBeNull();
  });

  it("tolerates non-object entries in the transcript", () => {
    expect(detectTurnFailure([null, undefined, 42, "x"])).toBeNull();
  });
});

// ─── findTierForModel ──────────────────────────────────────────────
describe("findTierForModel", () => {
  const cfg: ShiftRouterConfig = {
    ...DEFAULT_CONFIG,
    tiers: {
      fast: { label: "Fast", models: [{ provider: "minimax", model: "M3", priority: 1 }], description: "" },
      smart: { label: "Smart", models: [{ provider: "smart-p", model: "smart-m", priority: 1 }], description: "" },
    },
  };

  it("returns the tier that owns the model", () => {
    expect(findTierForModel(cfg, "minimax", "M3")).toBe("fast");
    expect(findTierForModel(cfg, "smart-p", "smart-m")).toBe("smart");
  });

  it("returns null for unknown models", () => {
    expect(findTierForModel(cfg, "ghost", "x")).toBeNull();
  });

  it("returns null when a model appears in both tiers (ambiguous)", () => {
    const both: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { label: "Fast", models: [{ provider: "minimax", model: "M3", priority: 1 }], description: "" },
        smart: { label: "Smart", models: [{ provider: "minimax", model: "M3", priority: 1 }], description: "" },
      },
    };
    expect(findTierForModel(both, "minimax", "M3")).toBeNull();
  });
});

// ─── planTurnFailover ──────────────────────────────────────────────
describe("planTurnFailover", () => {
  it("returns null on a healthy turn (no failover needed)", () => {
    const state = createRouterState();
    const messages = [assistant({ provider: "minimax", model: "M3" })];
    const config = makeConfig([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);

    const r = planTurnFailover(messages, state, config, registry, NOW);
    expect(r).toBeNull();
  });

  it("marks the failed model into cooldown and picks the same-tier fallback", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "Error: 429 rate limit",
      }),
    ];
    const config = makeConfig([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);

    const r = planTurnFailover(messages, state, config, registry, NOW);

    // Cooldown applied
    expect(isModelInCooldown(state.modelCooldowns, "minimax", "M3", NOW)).toBe(true);
    // Fallback chosen — same tier
    expect(r).not.toBeNull();
    expect(r!.failed).toEqual({ provider: "minimax", model: "M3", code: "429" });
    expect(r!.fallback).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash", tier: "fast" });
    expect(r!.switched).toBe(true);
  });

  it("does not switch when the whole tier is exhausted (keeps current)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "Error: 429 rate limit",
      }),
    ];
    const config = makeConfig([
      { provider: "minimax", model: "M3", priority: 1 }, // only model
    ]);

    const r = planTurnFailover(messages, state, config, registry, NOW);
    expect(r).not.toBeNull();
    expect(r!.fallback).toBeNull();
    expect(r!.switched).toBe(false);
    expect(isModelInCooldown(state.modelCooldowns, "minimax", "M3", NOW)).toBe(true);
  });

  it("skips the failed model even if not yet cooled (immediate failover)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "Error: 500 internal server error",
      }),
    ];
    const config = makeConfig([
      { provider: "minimax", model: "M3", priority: 1 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 },
    ]);

    const r = planTurnFailover(messages, state, config, registry, NOW);
    expect(r!.fallback?.modelId).toBe("deepseek-v4-flash");
    expect(state.modelCooldowns.has(modelKey("minimax", "M3"))).toBe(true);
  });

  it("never offers a smart model as fallback for a fast-tier failure", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    const messages = [
      assistant({
        provider: "minimax",
        model: "M3",
        stopReason: "error",
        errorMessage: "Error: 429",
      }),
    ];
    const config: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { label: "Fast", models: [{ provider: "minimax", model: "M3", priority: 1 }], description: "" },
        smart: { label: "Smart", models: [{ provider: "smart-p", model: "smart-m", priority: 1 }], description: "" },
      },
    };

    const r = planTurnFailover(messages, state, config, registry, NOW);
    expect(r!.fallback).toBeNull(); // fast tier exhausted — never cross to smart
  });
});
