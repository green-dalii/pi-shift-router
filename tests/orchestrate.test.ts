/**
 * pi-shift-router — Orchestration (SPEC §9.3) tests
 *
 * Backward-compatibility contract:
 * 1. Default off — orchestration.mode="off" is byte-for-byte today's router.
 * 2. Simple tasks (Judge "fast") never orchestrate.
 * 3. Config without orchestration.* parses unchanged (deepMerge defaults).
 * 4. Missing subagent tool / unresolvable Smart model → no injection, no crash.
 * 5. Abort/reset semantics.
 * 6. Existing features unaffected.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  type ShiftRouterConfig,
  type RouterState,
} from "../src/types.js";
import { createRouterState } from "../src/router.js";
import {
  shouldOrchestrate,
  buildOrchestratorPrompt,
  renderTierChain,
  enterOrchestration,
  exitOrchestration,
  resetOrchestration,
  capHit,
  recordWorkerOutcome,
} from "../src/orchestrate.js";

function makeConfig(partial?: Partial<ShiftRouterConfig>): ShiftRouterConfig {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ShiftRouterConfig;
  if (partial) {
    // Deep merge partial into the config clone.
    const p = partial as unknown as Record<string, unknown>;
    const c = cfg as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      if (
        v !== null && typeof v === "object" && !Array.isArray(v) &&
        c[k] !== null && typeof c[k] === "object" && !Array.isArray(c[k])
      ) {
        (c[k] as Record<string, unknown>) = { ...(c[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        c[k] = v;
      }
    }
  }
  return cfg;
}

function noCooldown(_provider: string, _model: string): boolean {
  return false;
}

describe("orchestration: default config", () => {
  it("is auto by default (v1.0.0 feature on by default)", () => {
    expect(DEFAULT_CONFIG.orchestration.mode).toBe("auto");
  });

  it("config without orchestration.* parses unchanged (backward-compat #3)", () => {
    // Simulate an old config file (no orchestration key) — deepMerge must
    // fill in defaults. loadConfig uses the same deepMerge; here we verify
    // the default shape is present and complete.
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ShiftRouterConfig;
    expect(cfg.orchestration).toEqual({
      mode: "auto",
      maxRounds: 3,
      escalationThreshold: 2,
      requireSmartModel: true,
    });
  });
});

describe("shouldOrchestrate", () => {
  it("returns true by default for smart verdict when everything available (default auto)", () => {
    const cfg = makeConfig();
    // judgeOrchestrate undefined (older prompt / not emitted) → no veto, default smart→orchestrate
    expect(shouldOrchestrate(cfg, "smart", undefined, true, true)).toBe(true);
  });

  it("returns false when orchestration explicitly off (opt-out)", () => {
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "off" } });
    expect(shouldOrchestrate(cfg, "smart", undefined, true, true)).toBe(false);
  });

  it("returns false for simple tasks even in auto mode (backward-compat #2)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "fast", undefined, true, true)).toBe(false);
  });

  it("returns false when router disabled", () => {
    const cfg = makeConfig({ enabled: false });
    expect(shouldOrchestrate(cfg, "smart", undefined, true, true)).toBe(false);
  });

  it("returns true for smart verdict when everything available", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "smart", undefined, true, true)).toBe(true);
  });

  it("returns false when Judge explicitly vetoes orchestration (orchestrate:false)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "smart", false, true, true)).toBe(false);
  });

  it("returns true when Judge explicitly asks for orchestration (orchestrate:true)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "smart", true, true, true)).toBe(true);
  });

  it("ignores orchestrate signal on fast verdict (simple never orchestrates)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "fast", true, true, true)).toBe(false);
  });

  it("returns false when Smart model unresolvable and requireSmartModel (backward-compat #4)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "smart", undefined, false, true)).toBe(false);
  });

  it("returns true when Smart model unresolvable but requireSmartModel=false", () => {
    const cfg = makeConfig({
      orchestration: { ...DEFAULT_CONFIG.orchestration, requireSmartModel: false },
    });
    expect(shouldOrchestrate(cfg, "smart", undefined, false, true)).toBe(true);
  });

  it("returns false when subagent tool unavailable (backward-compat #4)", () => {
    const cfg = makeConfig();
    expect(shouldOrchestrate(cfg, "smart", undefined, true, false)).toBe(false);
  });
});

describe("renderTierChain", () => {
  it("renders models in priority order with thinking suffix", () => {
    const chain = renderTierChain(
      [
        { provider: "b", model: "m2", priority: 2 },
        { provider: "a", model: "m1", priority: 1 },
      ],
      noCooldown,
      "high",
    );
    expect(chain).toContain("a/m1:high");
    expect(chain).toContain("b/m2:high");
    // priority order: a/m1 first
    expect(chain.indexOf("a/m1")).toBeLessThan(chain.indexOf("b/m2"));
  });

  it("skips models in cooldown", () => {
    const chain = renderTierChain(
      [
        { provider: "a", model: "hot", priority: 1 },
        { provider: "a", model: "cold", priority: 2 },
      ],
      (p, m) => m === "hot",
      "high",
    );
    expect(chain).not.toContain("hot");
    expect(chain).toContain("a/cold:high");
  });

  it("reports when all models are in cooldown", () => {
    const chain = renderTierChain(
      [{ provider: "a", model: "hot", priority: 1 }],
      () => true,
      "high",
    );
    expect(chain).toContain("cooldown");
  });

  it("reports when tier has no models", () => {
    const chain = renderTierChain(undefined, noCooldown, "high");
    expect(chain).toContain("(none");
  });
});

describe("buildOrchestratorPrompt", () => {
  it("injects fast/smart chains and caps into the template", () => {
    const cfg = makeConfig({
      orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", maxRounds: 5, escalationThreshold: 3 },
    });
    cfg.tiers.fast.models = [{ provider: "fastp", model: "fm", priority: 1 }];
    cfg.tiers.smart.models = [{ provider: "smartp", model: "sm", priority: 1 }];
    const prompt = buildOrchestratorPrompt(cfg, noCooldown);
    expect(prompt).toContain("fastp/fm:high");
    expect(prompt).toContain("smartp/sm:high");
    expect(prompt).not.toContain("{{maxRounds}}");
    expect(prompt).toContain("5");
    expect(prompt).toContain("3");
    expect(prompt).toContain("context: \"fresh\"");
    expect(prompt).toContain("subagent");
  });

  it("renders cooldown-filtered chain into the prompt", () => {
    const cfg = makeConfig({
      orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto" },
    });
    cfg.tiers.fast.models = [
      { provider: "p", model: "down", priority: 1 },
      { provider: "p", model: "up", priority: 2 },
    ];
    const prompt = buildOrchestratorPrompt(cfg, (p, m) => m === "down");
    expect(prompt).toContain("p/up:high");
    expect(prompt).not.toContain("p/down");
  });
});

describe("orchestration lifecycle", () => {
  it("enterOrchestration activates and sets startedAt", () => {
    const state: RouterState = createRouterState();
    enterOrchestration(state);
    expect(state.orchestration.active).toBe(true);
    expect(state.orchestration.startedAt).not.toBeNull();
  });

  it("enterOrchestration is idempotent (no reset mid-task)", () => {
    const state: RouterState = createRouterState();
    enterOrchestration(state);
    state.orchestration.rounds = 2;
    enterOrchestration(state);
    expect(state.orchestration.rounds).toBe(2);
  });

  it("exitOrchestration returns to inactive", () => {
    const state: RouterState = createRouterState();
    enterOrchestration(state);
    exitOrchestration(state);
    expect(state.orchestration.active).toBe(false);
    expect(state.orchestration.startedAt).toBeNull();
  });

  it("resetOrchestration clears an active run", () => {
    const state: RouterState = createRouterState();
    enterOrchestration(state);
    resetOrchestration(state);
    expect(state.orchestration.active).toBe(false);
  });

  it("capHit is false when inactive", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig();
    expect(capHit(state, cfg)).toBe(false);
  });

  it("capHit fires at maxRounds", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", maxRounds: 3 } });
    enterOrchestration(state);
    state.orchestration.rounds = 3;
    expect(capHit(state, cfg)).toBe(true);
  });

  it("capHit fires at escalationThreshold", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    state.orchestration.escalations = 2;
    expect(capHit(state, cfg)).toBe(true);
  });

  it("capHit false below caps", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", maxRounds: 3, escalationThreshold: 2 } });
    enterOrchestration(state);
    state.orchestration.rounds = 1;
    state.orchestration.escalations = 1;
    expect(capHit(state, cfg)).toBe(false);
  });

  it("recordWorkerOutcome is a no-op when inactive", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto" } });
    recordWorkerOutcome(state, cfg, false);
    expect(state.orchestration.rounds).toBe(0);
    expect(state.orchestration.escalations).toBe(0);
  });

  it("recordWorkerOutcome success consumes a round and resets streak", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    state.orchestration.workerFailStreak = 1; // a prior failure happened
    recordWorkerOutcome(state, cfg, true);
    expect(state.orchestration.rounds).toBe(1);
    expect(state.orchestration.workerFailStreak).toBe(0);
    expect(state.orchestration.escalations).toBe(0);
  });

  it("recordWorkerOutcome escalates after N consecutive failures", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    recordWorkerOutcome(state, cfg, false);
    recordWorkerOutcome(state, cfg, false);
    expect(state.orchestration.escalations).toBe(1);
    expect(state.orchestration.workerFailStreak).toBe(0); // reset after escalation
    expect(state.orchestration.rounds).toBe(2);
    // One more failure starts a new streak toward the next escalation.
    recordWorkerOutcome(state, cfg, false);
    expect(state.orchestration.escalations).toBe(1);
    expect(state.orchestration.workerFailStreak).toBe(1);
  });

  it("recordWorkerOutcome interleaved success breaks the streak", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    recordWorkerOutcome(state, cfg, false); // streak=1
    recordWorkerOutcome(state, cfg, true); // success → streak=0
    recordWorkerOutcome(state, cfg, false); // streak=1 again
    expect(state.orchestration.escalations).toBe(0);
    expect(state.orchestration.workerFailStreak).toBe(1);
    expect(state.orchestration.rounds).toBe(3);
  });

  it("capHit fires once escalations reach threshold via outcomes", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    recordWorkerOutcome(state, cfg, false);
    recordWorkerOutcome(state, cfg, false); // escalations=1
    recordWorkerOutcome(state, cfg, false);
    recordWorkerOutcome(state, cfg, false); // escalations=2 → cap
    expect(state.orchestration.escalations).toBe(2);
    expect(capHit(state, cfg)).toBe(true);
  });

  it("capHit fires once rounds reach maxRounds via outcomes", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", maxRounds: 3, escalationThreshold: 10 } });
    enterOrchestration(state);
    recordWorkerOutcome(state, cfg, true);
    recordWorkerOutcome(state, cfg, true);
    recordWorkerOutcome(state, cfg, true); // rounds=3 → cap
    expect(state.orchestration.rounds).toBe(3);
    expect(capHit(state, cfg)).toBe(true);
  });

  it("capHit reflects escalations in status bar label", () => {
    const state: RouterState = createRouterState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "auto", escalationThreshold: 2 } });
    enterOrchestration(state);
    recordWorkerOutcome(state, cfg, false);
    recordWorkerOutcome(state, cfg, false); // escalations=1, cap not hit
    expect(formatStatusBarLabel(cfg, state)).toContain("🪄");
    expect(formatStatusBarLabel(cfg, state)).not.toContain("⛔cap");
    recordWorkerOutcome(state, cfg, false);
    recordWorkerOutcome(state, cfg, false); // escalations=2 → cap
    expect(capHit(state, cfg)).toBe(true);
    expect(formatStatusBarLabel(cfg, state)).toContain("⛔cap");
  });
});

// ─── Status bar label — orchestrating-state bug fix ─────────────────
//
// Bug: after `exitOrchestration` / `resetOrchestration`, the status bar
// kept showing "🪄 orchestrating…" because the bar was not refreshed.
// `formatStatusBarLabel` is a pure function extracted from updateBar so
// we can verify the label transitions correctly through the orchestration
// lifecycle.
import { formatStatusBarLabel } from "../src/index.js";

describe("formatStatusBarLabel — orchestration lifecycle bug fix", () => {
  function makeState(): RouterState {
    return createRouterState();
  }

  function makeConfig(overrides: Partial<ShiftRouterConfig> = {}): ShiftRouterConfig {
    return {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { ...DEFAULT_CONFIG.tiers.fast, models: [{ provider: "p", model: "m", priority: 1 }] },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [{ provider: "p", model: "m", priority: 1 }] },
      },
      ...overrides,
    } as ShiftRouterConfig;
  }

  it("returns undefined when statusBar is disabled", () => {
    const cfg = makeConfig({ ux: { ...DEFAULT_CONFIG.ux, statusBar: false } });
    const s = makeState();
    enterOrchestration(s);
    expect(formatStatusBarLabel(cfg, s)).toBeUndefined();
  });

  it("appends 🪄 pending marker to tier badge when active and no workers spawned (keeps tok/s visible)", () => {
    const s = makeState();
    enterOrchestration(s);
    const label = formatStatusBarLabel(makeConfig(), s);
    // Planning phase: badge + throughput stay visible, wand marks pending.
    // Default state = fast tier, no model resolved yet → "[🦾 …]".
    expect(label).toMatch(/\[🦾 …\]/);
    expect(label).toMatch(/🪄$/);
  });

  it("planning-phase label includes tok/s when speed telemetry exists", () => {
    const s = makeState();
    enterOrchestration(s);
    s.recentSpeeds.push(42);
    s.currentTier = "smart";
    s.currentModelId = "opencode/deepseek";
    expect(formatStatusBarLabel(makeConfig(), s)).toBe("[🧠 deepseek] • 42 tok/s 🪄");
  });

  it("returns '🪄 X/Y workers' when workers have been spawned", () => {
    const s = makeState();
    enterOrchestration(s);
    s.orchestration.spawned = 3;
    s.orchestration.done = 1;
    expect(formatStatusBarLabel(makeConfig(), s)).toBe("🪄 1/3 workers");
  });

  it("returns tier badge after exitOrchestration (the bug fix)", () => {
    const s = makeState();
    enterOrchestration(s);
    expect(formatStatusBarLabel(makeConfig(), s)).toMatch(/🪄$/);
    exitOrchestration(s);
    // After exit, the orchestration state is inactive → plain tier badge.
    const label = formatStatusBarLabel(makeConfig(), s);
    expect(label).toBe("[🦾 …]");
  });

  it("returns tier badge after resetOrchestration (the bug fix)", () => {
    const s = makeState();
    enterOrchestration(s);
    s.orchestration.spawned = 2;
    resetOrchestration(s);
    expect(formatStatusBarLabel(makeConfig(), s)).not.toMatch(/🪄/);
  });

  it("⛔ + pending marker wins over pure ⛔ when router disabled and orchestration planning", () => {
    const cfg = makeConfig({ enabled: false });
    const s = makeState();
    enterOrchestration(s);
    // Planning phase keeps whatever base applies, plus the wand marker.
    expect(formatStatusBarLabel(cfg, s)).toBe("⛔ 🪄");
    exitOrchestration(s);
    expect(formatStatusBarLabel(cfg, s)).toBe("⛔");
  });
  it("⛔ keeps throughput segment when router disabled and a reading exists", () => {
    const cfg = makeConfig({ enabled: false });
    const s = makeState();
    s.recentSpeeds.push(55);
    expect(formatStatusBarLabel(cfg, s)).toBe("⛔ • 55 tok/s");
  });

  it("⛔ stays bare when router disabled and no readings", () => {
    const cfg = makeConfig({ enabled: false });
    expect(formatStatusBarLabel(cfg, makeState())).toBe("⛔");
  });

  it("workers label shows AVERAGE tok/s across completed workers", () => {
    const s = makeState();
    enterOrchestration(s);
    s.orchestration.spawned = 5;
    s.orchestration.done = 2;
    // Completed workers ran at 20 and 40 tok/s -> avg 30.
    s.orchestration.workerSpeeds.push(20, 40);
    expect(formatStatusBarLabel(makeConfig(), s)).toBe("🪄 2/5 workers • ~30 tok/s avg");
  });

  it("workers label has no throughput segment until first worker completes", () => {
    const s = makeState();
    enterOrchestration(s);
    s.orchestration.spawned = 3;
    s.orchestration.done = 0;
    expect(formatStatusBarLabel(makeConfig(), s)).toBe("🪄 0/3 workers");
  });
});