/**
 * pi-shift-router — Confidence-driven EV routing tests (SPEC §2.3)
 *
 * Judge returns { tier, confidence }. The EV decision rule turns confidence
 * into the probability the task needs the smart tier:
 *   pSmart = c (smart) or 1−c (fast); θ = 1 / economics.reworkPenalty.
 * Confidence below `window.minConfidence` = no signal (hold) — such entries
 * never switch tiers and break a fast streak. analyzeDowngrade then only
 * counts trailing DECISIVE fast entries (confidence already spent at
 * decision time).
 */

import { describe, it, expect } from "vitest";
import { analyzeDowngrade } from "../src/router.js";
import { extractTier } from "../src/judge.js";
import type { ShiftRouterConfig, WindowEntry } from "../src/types.js";

function makeConfig(overrides: Partial<ShiftRouterConfig["routing"]> = {}): ShiftRouterConfig {
  return {
    enabled: true,
    tiers: {
      fast: { label: "Fast", models: [{ provider: "p", model: "f", priority: 1 }], description: "" },
      smart: { label: "Smart", models: [{ provider: "p", model: "s", priority: 1 }], description: "" },
    },
    routing: {
      mode: "auto",
      judgeTimeout: 5000,
      window: {
        size: 5,
        minConfidence: 0.5,
        ...overrides.window,
      },
      economics: { reworkPenalty: 3, downgradeMemory: 2 },
    },
    ux: { quietMode: false, statusBar: true, inlineToast: true },
  } as ShiftRouterConfig;
}

function entry(tier: "fast" | "smart", confidence?: number, hold?: boolean): WindowEntry {
  return {
    tier,
    timestamp: 0,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(hold ? { hold } : {}),
  };
}

// ─── Tier parsing ──────────────────────────────────────────────────
describe("extractTier parses confidence", () => {
  it("extracts confidence from primary JSON shape", () => {
    const text = '{"tier":"fast","confidence":0.85}';
    expect(extractTier(text)).toBe("fast");
  });

  it("returns null for malformed confidence (non-numeric)", () => {
    const text = '{"tier":"fast","confidence":"high"}';
    expect(extractTier(text)).toBe("fast"); // tier still parsed
  });
});

// ─── analyzeDowngrade: decisive streak ─────────────────────────────
describe("analyzeDowngrade (decisive fast streak)", () => {
  it("downgrades when all trailing fast entries are decisive (high confidence)", () => {
    const window = [entry("fast", 0.9), entry("fast", 0.9), entry("fast", 0.9)];
    const r = analyzeDowngrade(window, "smart", makeConfig());
    // trailing streak 3 ≥ downgradeMemory 2
    expect(r.shouldDowngrade).toBe(true);
  });

  it("does not downgrade on a single fast entry", () => {
    const window = [entry("fast", 0.9)];
    const r = analyzeDowngrade(window, "smart", makeConfig());
    expect(r.shouldDowngrade).toBe(false);
  });

  it("low-confidence window entries are holds and break the streak", () => {
    // Entries below minConfidence are marked hold at decision time; they
    // must never contribute to a fast streak.
    const window = [entry("fast", 0.9), entry("fast", 0.9, true), entry("fast", 0.9)];
    const r = analyzeDowngrade(window, "smart", makeConfig());
    expect(r.shouldDowngrade).toBe(false);
  });

  it("defaults to confidence 1.0 when not provided (backward compat)", () => {
    const window = [
      { tier: "fast" as const, timestamp: 0 },
      { tier: "fast" as const, timestamp: 0 },
    ];
    const r = analyzeDowngrade(window, "smart", makeConfig());
    expect(r.shouldDowngrade).toBe(true);
  });
});

// ─── End-to-end via processRoute ───────────────────────────────────
import { createRouterState, processRoute } from "../src/router.js";
describe("processRoute respects confidence", () => {
  it("low-confidence judge verdict holds (no downgrade, no upgrade)", () => {
    const state = createRouterState();
    state.currentTier = "smart";
    state.currentProvider = "p";
    state.currentModelId = "s";
    const config = makeConfig();

    const d = processRoute({ tier: "fast", source: "llm", confidence: 0.3 }, state, config, { find: () => ({} as any) });
    expect(d.action).toBe("stay"); // confidence 0.3 < 0.5 → hold
    expect(state.window[state.window.length - 1]?.hold).toBe(true);
  });

  it("partial confidence on a fast verdict upgrades (EV rule)", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "f";
    const config = makeConfig();

    // fast c=0.6 → pSmart=0.4 ≥ θ=1/3 → smart decision → upgrade
    const d = processRoute({ tier: "fast", source: "llm", confidence: 0.6 }, state, config, { find: () => ({} as any) });
    expect(d.action).toBe("upgrade");
  });

  it("confident fast verdict stays on the fast chain", () => {
    const state = createRouterState();
    state.currentTier = "fast";
    state.currentProvider = "p";
    state.currentModelId = "f";
    const config = makeConfig();

    const d = processRoute({ tier: "fast", source: "llm", confidence: 0.9 }, state, config, { find: () => ({} as any) });
    expect(d.action).toBe("stay");
  });
});
