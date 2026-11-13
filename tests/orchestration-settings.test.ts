/**
 * pi-shift-router — orchestration settings (SPEC §9.3 / §5.2)
 *
 * `/router config` gained a 🪄 Orchestration entry. These tests pin the
 * defaults and the numeric-input contract; the menu-label routing lives here
 * too so a renamed row cannot silently fall through to "cancel".
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, ORCHESTRATION_LIMITS, type ShiftRouterConfig } from "../src/types.js";
import { clampInt, orchestrationSummary, matchMenuChoice } from "../src/commands.js";

function cfg(partial?: (c: ShiftRouterConfig) => void): ShiftRouterConfig {
  const c = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ShiftRouterConfig;
  partial?.(c);
  return c;
}

describe("orchestration defaults", () => {
  it("budgets six delegate→review rounds, not three", () => {
    // 3 was a v1.0.0 placeholder chosen before delegation worked; the first
    // real task (4 modules, 2 phases + 2 reviews) exhausted it before its
    // closing review. Six covers P95 phase counts at ~10 min / <$0.30.
    expect(DEFAULT_CONFIG.orchestration.maxRounds).toBe(6);
    expect(ORCHESTRATION_LIMITS.maxRounds).toEqual({ min: 1, max: 20, fallback: 6, legacyDefault: 3 });
  });

  it("keeps the escalation threshold about failures, not plan size", () => {
    expect(DEFAULT_CONFIG.orchestration.escalationThreshold).toBe(2);
    expect(ORCHESTRATION_LIMITS.escalationThreshold).toEqual({ min: 1, max: 6, fallback: 2 });
  });
});

describe("clampInt — the numeric input contract", () => {
  it("accepts an in-range integer, including the new upper bound", () => {
    expect(clampInt("4", 1, 20, 6)).toBe(4);
    expect(clampInt("20", 1, 20, 6)).toBe(20);
  });

  it("clamps to the bounds instead of rejecting", () => {
    expect(clampInt("0", 1, 20, 6)).toBe(1);
    expect(clampInt("99", 1, 20, 6)).toBe(20);
  });

  it("falls back on empty or non-numeric input", () => {
    expect(clampInt("", 1, 20, 6)).toBe(6);
    expect(clampInt("six", 1, 20, 6)).toBe(6);
    expect(clampInt(undefined, 1, 20, 6)).toBe(6);
  });

  it("reads the leading integer of a sloppy entry", () => {
    expect(clampInt(" 8 rounds ", 1, 20, 6)).toBe(8);
  });
});

describe("orchestrationSummary — one menu line", () => {
  it("shows mode, budget and audit state", () => {
    expect(orchestrationSummary(cfg())).toBe("auto, 6 rounds, audit on");
  });

  it("says when orchestration is off", () => {
    const c = cfg((c) => { c.orchestration.mode = "off"; });
    expect(orchestrationSummary(c)).toBe("off, 6 rounds, audit on");
  });

  it("reflects an audit opt-out", () => {
    const c = cfg((c) => { c.orchestration.audit.enabled = false; });
    expect(orchestrationSummary(c)).toBe("auto, 6 rounds, audit off");
  });
});

describe("menu routing", () => {
  it("routes the Orchestration row to its own menu", () => {
    expect(matchMenuChoice("🪄 Orchestration — auto, 6 rounds, audit on")).toBe("orch");
    expect(matchMenuChoice("🪄 Orchestration — off, 6 rounds, audit on")).toBe("orch");
  });

  it("does not steal the Judge or Fast rows", () => {
    expect(matchMenuChoice("🧭 Judge — reuse Fast tier chain")).toBe("judge");
    expect(matchMenuChoice("🦾 Fast — 1 model(s)")).toBe("fast");
  });
});
