/**
 * pi-shift-router — Status dashboard view-model tests (pure assembler).
 *
 * The assembler turns router state + stats + config into a structured view
 * model; the TUI component (status-panel.ts) renders it with theme colors.
 * These tests pin the LOGIC: cache-hit math, bar rendering, gear bar
 * percentages (theta → plain-language "bar"), cooldown/live marking, and
 * every n/a fallback.
 */

import { describe, it, expect } from "vitest";
import {
  cacheHitPct,
  renderBar,
  gearBarPct,
  assembleStatusData,
  type StatusPanelInput,
} from "../src/tui/status-panel.js";
import type { Tier } from "../src/types.js";

function baseInput(overrides: Partial<StatusPanelInput> = {}): StatusPanelInput {
  return {
    version: "1.4.2",
    enabled: true,
    routingMode: "auto",
    currentTier: "smart",
    currentProvider: "commandcode",
    currentModelId: "deepseek/deepseek-v4-flash",
    manualActive: false,
    lastDecision: { verdict: "smart", confidence: 0.95, action: "upgrade", reason: "explicit smart request" },
    contextUsage: { tokens: 38_200, contextWindow: 200_000 },
    cacheStats: { input: 2_400, cacheRead: 12_400 },
    money: {
      spentFast: 0.0031, spentSmart: 0.052, callsFast: 14, callsSmart: 3,
      actualTotal: 0.0551, baselineTotal: 0.2103, savings: 0.1552,
      baselineName: "commandcode/deepseek/deepseek-v4-flash",
    },
    speed: { current: 125, avg: 98, totalTokens: 45_230 },
    gear: { label: "default", thetaEff: 0.2222, downgradeMemory: 2, cacheAware: true, sameFamily: true, sameFamilyFactor: 1.5 },
    otherGears: [
      { cmd: "/router eco", label: "save more", theta: 0.5 },
      { cmd: "/router sport", label: "smarter sooner", theta: 0.2 },
    ],
    chains: [
      { tier: "fast", models: [
        { provider: "minimax-cn", model: "MiniMax-M3", costIn: 0.28 },
        { provider: "commandcode", model: "deepseek/deepseek-v4-flash", costIn: 0.11 },
        { provider: "commandcode", model: "meta/muse-spark-1.2-contributor", costIn: 0.21 },
      ] },
      { tier: "smart", models: [
        { provider: "commandcode", model: "deepseek/deepseek-v4-flash", costIn: 0.11 },
        { provider: "zai", model: "glm-5.3-flash", costIn: 0.14 },
        { provider: "commandcode", model: "meta/muse-spark-1.2-contributor", costIn: 0.21 },
      ] },
    ],
    cooldowns: [{ provider: "commandcode", model: "deepseek/deepseek-v4-flash", remainingMs: 192_000 }],
    judgeModel: "minimax-cn/MiniMax-M3",
    windowGlyphs: ["smart", "smart", "fast", "fast", "smart"] as Tier[],
    orchestration: { mode: "auto", active: false, audit: "clean (LLM pass)" },
    configSource: { source: "project", path: "/proj/.pi/pi-shift-router.json", userLayerExists: true },
    now: 1_000_000,
    ...overrides,
  };
}

describe("cacheHitPct", () => {
  it("hit = cacheRead / (input + cacheRead)", () => {
    expect(cacheHitPct({ input: 2_400, cacheRead: 12_400 })).toBe(84); // 12400/14800 = 83.8
  });

  it("returns null (n/a) when the provider reported no prompt tokens", () => {
    expect(cacheHitPct({ input: 0, cacheRead: 0 })).toBeNull();
    expect(cacheHitPct(null)).toBeNull();
  });

  it("0% when everything was a cache miss", () => {
    expect(cacheHitPct({ input: 5_000, cacheRead: 0 })).toBe(0);
  });
});

describe("renderBar", () => {
  it("renders filled + empty blocks across the width", () => {
    expect(renderBar(0.2, 10)).toBe("▓▓░░░░░░░░");
    expect(renderBar(1, 4)).toBe("▓▓▓▓");
    expect(renderBar(0, 4)).toBe("░░░░");
  });

  it("rounds to nearest block and clamps", () => {
    expect(renderBar(0.25, 4)).toBe("▓░░░");
    expect(renderBar(1.3, 4)).toBe("▓▓▓▓");
    expect(renderBar(-1, 4)).toBe("░░░░");
  });
});

describe("gearBarPct — theta becomes a plain-language bar", () => {
  it("base theta → percent", () => {
    expect(gearBarPct(0.5, false, 1.5)).toBe(50);
    expect(gearBarPct(0.2, false, 1.5)).toBe(20);
  });

  it("same-family cache-aware divides the bar (0.33 → 22)", () => {
    expect(gearBarPct(1 / 3, true, 1.5)).toBe(22);
  });

  it("no division when cache-aware is off", () => {
    expect(gearBarPct(1 / 3, false, 1.5)).toBe(33);
  });
});

describe("assembleStatusData", () => {
  it("marks the LIVE chain entry (current provider/model) per tier", () => {
    const d = assembleStatusData(baseInput());
    const smart = d.chains.find((c) => c.tier === "smart")!;
    expect(smart.models[0].live).toBe(true);
    const fast = d.chains.find((c) => c.tier === "fast")!;
    expect(fast.models[0].live).toBe(false);
    // The same model under the OTHER tier's chain is not live.
    expect(fast.models[1].live).toBe(false);
  });

  it("inlines cooldown into the matching chain entry", () => {
    const d = assembleStatusData(baseInput());
    const fast = d.chains.find((c) => c.tier === "fast")!;
    expect(fast.models[1].cooldownRemainingMs).toBe(192_000);
    expect(fast.models[0].cooldownRemainingMs).toBeUndefined();
  });

  it("context line renders used/window with percent", () => {
    const d = assembleStatusData(baseInput());
    expect(d.contextLine).toEqual({ pct: 19, used: "38.2k", window: "200.0k" });
  });

  it("context line is null when pi has no reading (fresh turn)", () => {
    const d = assembleStatusData(baseInput({ contextUsage: null }));
    expect(d.contextLine).toBeNull();
  });

  it("cache line shows hit% + served-from-cache tokens", () => {
    const d = assembleStatusData(baseInput());
    expect(d.cacheLine).toEqual({ pct: 84, cached: "12.4k", total: "14.8k" });
  });

  it("cache line is null when no cache data (first turn / provider silent)", () => {
    const d = assembleStatusData(baseInput({ cacheStats: null }));
    expect(d.cacheLine).toBeNull();
  });

  it("gear line carries the plain-language bar of the EFFECTIVE theta", () => {
    const d = assembleStatusData(baseInput());
    expect(d.gearLine.barPct).toBe(22);
    expect(d.gearLine.label).toBe("default");
  });

  it("other gears get the same family-adjusted bar treatment", () => {
    const d = assembleStatusData(baseInput());
    expect(d.otherGears.map((g) => g.barPct)).toEqual([33, 13]); // 0.5/1.5→33, 0.2/1.5→13
  });

  it("money savings percentage is derived, not stored", () => {
    const d = assembleStatusData(baseInput());
    expect(d.money!.savingsPct).toBe(74); // 0.1552 / 0.2103 = 73.8
  });

  it("money section is null when cost telemetry has no baseline (no pricing)", () => {
    const d = assembleStatusData(baseInput({ money: null }));
    expect(d.money).toBeNull();
  });

  it("last decision line passes through verdict/confidence/action/reason", () => {
    const d = assembleStatusData(baseInput());
    expect(d.lastLine).toEqual({
      verdict: "smart", confidence: 0.95, action: "upgrade", reason: "explicit smart request",
    });
  });

  it("last decision line is null before the first decision of the session", () => {
    const d = assembleStatusData(baseInput({ lastDecision: null }));
    expect(d.lastLine).toBeNull();
  });

  it("disabled router still renders (header carries the OFF state)", () => {
    const d = assembleStatusData(baseInput({ enabled: false }));
    expect(d.header).toContain("OFF");
  });

  it("config source line distinguishes project/user/default", () => {
    expect(assembleStatusData(baseInput()).configLine).toContain("project");
    const u = assembleStatusData(baseInput({
      configSource: { source: "user", path: "/home/.pi/agent/pi-shift-router.json", userLayerExists: true },
    }));
    expect(u.configLine).toContain("user");
    const n = assembleStatusData(baseInput({
      configSource: { source: "default", path: null, userLayerExists: false },
    }));
    expect(n.configLine).toContain("defaults");
  });
});
