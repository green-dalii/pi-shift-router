/**
 * pi-shift-router — Routing engine
 *
 * Two-tier sliding window trend detection:
 *   - Upgrade (fast → smart): immediate
 *   - Downgrade (smart → fast): requires window majority
 */

import type { ShiftRouterConfig, Tier, WindowEntry, RouterState, JudgeResult } from "./types.js";
import { ECONOMIC_MODE_PRESETS, LEGACY_THRESHOLD_DEFAULT, LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT } from "./types.js";
import { findBestModelForTier, type ResolvedModel } from "./tier.js";
import { createCooldowns, cooldownPredicate, findTierForModel } from "./failover.js";

/** Create an initial RouterState */
export function createRouterState(): RouterState {
  return {
    currentTier: "fast",
    currentModelId: null,
    currentProvider: null,
    window: [],
    manualOverride: { active: false },
    modelCooldowns: createCooldowns(),
    totalOutputTokens: 0,
    recentSpeeds: [],
    streamingStartTime: null,
    upgradeCount: 0,
    downgradeCount: 0,
    lastActivityAt: 0,
    tierUsage: {
      fast: emptyTierUsage(),
      smart: emptyTierUsage(),
    },
    callLog: [],
    orchestration: {
      active: false,
      rounds: 0,
      escalations: 0,
      startedAt: null,
      spend: 0,
      spawned: 0,
      done: 0,
      workerSpeeds: [],
      workerFailStreak: 0,
      goal: null,
    },
    lastAudit: null,
  };
}

/** Fresh zero-valued TierUsage. */
function emptyTierUsage(): { calls: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number } {
  return {
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  };
}

/**
 * Cache-aware routing (SPEC §9.2).
 *
 * Detect whether the fast and smart tiers resolve to the same provider
 * family. A prompt cache belongs to a model (byte-identical prefix on one
 * model's KV state); crossing a model boundary is a guaranteed cache miss.
 * When both tiers live under the same provider, a mid-session downgrade
 * forfeits the warm cache (reads bill 0.1x–0.5x of base input), so routing
 * to a cheaper model can cost more, not less.
 *
 * Returns true when both tiers have at least one model on the same provider
 * (and the router is configured to care). Pure config inspection — no IO.
 */
export function shareProviderFamily(config: ShiftRouterConfig): boolean {
  const fast = config.tiers.fast?.models ?? [];
  const smart = config.tiers.smart?.models ?? [];
  if (fast.length === 0 || smart.length === 0) return false;
  const fastProviders = new Set(fast.map((m) => m.provider));
  return smart.some((m) => fastProviders.has(m.provider));
}

/**
 * Effective rework penalty R (SPEC §2.3). A named `economics.mode` preset
 * (`/router eco|default|sport`) is authoritative when present;
 * otherwise the raw `reworkPenalty` applies (legacy default 3).
 */
export function effectiveReworkPenalty(config: ShiftRouterConfig): number {
  const mode = config.routing.economics?.mode;
  if (mode && mode in ECONOMIC_MODE_PRESETS) return ECONOMIC_MODE_PRESETS[mode];
  return config.routing.economics?.reworkPenalty ?? 3;
}

/**
 * Genuinely active legacy θ override, or undefined. The pre-v1.4.0 default
 * `0.6` is treated as **unset** (smooth migration: old wizard snapshots must
 * not be reinterpreted as a much more conservative θ); only a value that
 * differs from the old default is a deliberate customization and wins.
 */
export function legacyThetaOverride(config: ShiftRouterConfig): number | undefined {
  const t = config.routing.window.threshold;
  if (typeof t === "number" && t > 0 && t < 1 && t !== LEGACY_THRESHOLD_DEFAULT) return t;
  return undefined;
}

/**
 * Effective θ (the smart-probability bar) for the EV decision rule (SPEC §2.3).
 *
 * Base: θ = 1 / economics.reworkPenalty. A legacy explicit `window.threshold`
 * (user-set before v1.4.0, non-default value) overrides as a raw θ.
 * Cache-aware same-family routing divides θ by the same-family penalty so
 * fewer fast decisions fire (fewer downgrades → warm prompt cache survives).
 */
export function effectiveTheta(
  config: ShiftRouterConfig,
  cacheAware: boolean = shareProviderFamily(config),
): number {
  const legacy = legacyThetaOverride(config);
  if (legacy !== undefined) return legacy;
  const R = effectiveReworkPenalty(config);
  let theta = 1 / Math.max(R, 1);
  if (cacheAware && config.routing.cacheAware?.enabled) {
    theta /= sameFamilyThetaFactor(config);
  }
  return theta;
}

/**
 * Same-family θ divisor. New knob: `sameFamilyPenalty` (default 1.5).
 * Legacy `sameFamilyThreshold` (old ratio bar) implies the strong default
 * 3.0 — but only when it differs from the old default 0.9 (smooth migration:
 * wizard snapshots of the v1.3 default must not silently turn the strong
 * conservatism on).
 */
function sameFamilyThetaFactor(config: ShiftRouterConfig): number {
  const ca = config.routing.cacheAware;
  if (typeof ca?.sameFamilyPenalty === "number" && ca.sameFamilyPenalty > 1) return ca.sameFamilyPenalty;
  if (
    typeof ca?.sameFamilyThreshold === "number" &&
    ca.sameFamilyThreshold !== LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT
  ) {
    return 3.0;
  }
  return 1.5;
}

/**
 * Session-boundary gate for cache-aware downgrades. A downgrade to another
 * model only forfeits the cache while the cache is warm — i.e. within
 * `idleBoundaryMs` of the last message. After an idle gap longer than the
 * provider's cache TTL, the cache is already cold and switching costs
 * nothing extra.
 *
 * Returns true when a downgrade should be allowed right now (cache is cold
 * or cache-aware routing is off / not applicable).
 */
export function downgradeAllowedAt(
  state: RouterState,
  config: ShiftRouterConfig,
  now: number,
  cacheAware: boolean = shareProviderFamily(config),
): boolean {
  if (!cacheAware || !config.routing.cacheAware?.enabled) return true;
  const boundary = config.routing.cacheAware.idleBoundaryMs;
  // lastActivityAt == 0 → no message has completed yet; nothing cached to lose.
  if (state.lastActivityAt === 0) return true;
  return now - state.lastActivityAt > boundary;
}

export function analyzeDowngrade(
  window: WindowEntry[],
  currentTier: Tier,
  config: ShiftRouterConfig,
): { shouldDowngrade: boolean; targetTier: Tier | null } {
  // Can't downgrade further from fast
  if (currentTier !== "smart") return { shouldDowngrade: false, targetTier: null };

  // Downgrade requires `downgradeMemory` CONSECUTIVE decisive fast decisions.
  // Holds (no-signal entries) and smart decisions both break the streak.
  const memory = config.routing.economics?.downgradeMemory ?? 2;
  let streak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    const e = window[i];
    if (e.hold || e.tier !== "fast") break;
    streak += 1;
  }
  if (streak >= memory) {
    return { shouldDowngrade: true, targetTier: "fast" };
  }
  return { shouldDowngrade: false, targetTier: null };
}

/**
 * Core routing decision (SPEC §2.3 + §2.4):
 * 1. Manual override → use forced model
 * 2. EV decision: judge confidence → pSmart vs θ (hold below minConfidence)
 * 3. Upgrade on any decisive smart decision (immediate)
 * 4. Downgrade on downgradeMemory consecutive fast decisions (+ cache gate)
 * 5. Strict takeover: return the best available model of the RUNNING tier
 *    whenever the active model differs (or none is set) — the router owns
 *    model selection; user /model or session default is corrected here.
 */
export function processRoute(
  judgeResult: JudgeResult,
  state: RouterState,
  config: ShiftRouterConfig,
  modelRegistry: { find: (p: string, m: string) => unknown } | undefined,
  now: number = Date.now(),
): RouteDecision {
  const { tier: targetTier } = judgeResult;

  // 1. Manual override
  if (state.manualOverride.active) {
    if (state.manualOverride.modelId && state.manualOverride.provider) {
      return {
        switchTo: {
          provider: state.manualOverride.provider,
          modelId: state.manualOverride.modelId,
          tier: state.manualOverride.tier ?? targetTier,
        },
        action: "manual",
      };
    }
    if (state.manualOverride.tier) {
      const m = findBestModelForTier(state.manualOverride.tier, config, modelRegistry);
      if (m) return { switchTo: m, action: "manual" };
    }
  }

  // 2. EV decision (SPEC §2.3). Confidence below minConfidence = no signal.
  const confidence = judgeResult.confidence ?? 1.0;
  const minConf = config.routing.window.minConfidence ?? 0.5;
  const hold = confidence < minConf;
  let decision: Tier = hold ? state.currentTier : (targetTier === "smart" ? "smart" : "fast");
  if (!hold) {
    const theta = effectiveTheta(config);
    const pSmart = targetTier === "smart" ? confidence : 1 - confidence;
    decision = pSmart >= theta ? "smart" : "fast";
  }

  // 3. Push to window (hold entries marked; they break fast streaks).
  state.window.push({ tier: decision, timestamp: now, confidence, hold });
  const maxSize = config.routing.window.size;
  if (state.window.length > maxSize) {
    state.window = state.window.slice(-maxSize);
  }

  // 4. Immediate upgrade: fast → smart on a decisive smart decision.
  if (!hold && decision === "smart" && state.currentTier === "fast") {
    const m = findBestModelForTier("smart", config, modelRegistry, cooldownPredicate(state.modelCooldowns, now));
    if (m) {
      state.window = []; // fresh start for the new tier
      state.upgradeCount += 1;
      return { switchTo: m, action: "upgrade" };
    }
  }

  // 5. Downgrade: smart → fast on downgradeMemory consecutive fast decisions
  //    plus the cache-aware idle gate (SPEC §9.2).
  if (!hold && decision === "fast" && state.currentTier === "smart") {
    const down = analyzeDowngrade(state.window, state.currentTier, config);
    if (down.shouldDowngrade && downgradeAllowedAt(state, config, now)) {
      const m = findBestModelForTier("fast", config, modelRegistry, cooldownPredicate(state.modelCooldowns, now));
      if (m) {
        state.downgradeCount += 1;
        return { switchTo: m, action: "downgrade" };
      }
    }
  }

  // 6. Strict takeover (SPEC §2.4): the running tier's best available model
  //    must be on the wire. A differing current model (user /model, session
  //    default, or no model set) is corrected now; equality is a no-op.
  const runningTier = state.currentTier;
  const m = findBestModelForTier(runningTier, config, modelRegistry, cooldownPredicate(state.modelCooldowns, now));
  if (m && (m.provider !== state.currentProvider || m.modelId !== state.currentModelId)) {
    return { switchTo: m, action: "enforce" };
  }

  return { switchTo: null, action: "stay" };
}

export interface RouteDecision {
  switchTo: ResolvedModel | null;
  action: "upgrade" | "downgrade" | "stay" | "manual" | "enforce";
}

/**
 * Apply model switch: find model in registry, then call pi.setModel().
 */
export async function applyModelSwitch(
  resolved: ResolvedModel,
  state: RouterState,
  modelRegistry: { find: (p: string, m: string) => unknown } | undefined,
  setModel: (m: unknown) => Promise<boolean>,
): Promise<boolean> {
  try {
    // No-op when the requested model is already active: avoids a redundant
    // setModel per turn under strict takeover (SPEC §2.4).
    if (state.currentProvider === resolved.provider && state.currentModelId === resolved.modelId) {
      return true;
    }
    const model = modelRegistry?.find?.(resolved.provider, resolved.modelId);
    if (!model) {
      // Not verbose-gated: indicates a config/catalog desync the user must fix.
      // Kept as warn so the failure is visible even with verbose OFF, but it
      // only fires when a routing decision actually tries to switch to a
      // missing model — not on every /router config round-trip.
      console.warn(`[ShiftRouter] Model not found: ${resolved.provider}/${resolved.modelId}`);
      return false;
    }
    const ok = await setModel(model);
    if (ok) {
      state.currentTier = resolved.tier;
      state.currentModelId = resolved.modelId;
      state.currentProvider = resolved.provider;
      return true;
    }
    // pi.setModel returns false when the provider has no configured auth in
    // pi's runtime (agent-session.js: hasConfiguredAuth). This failure was
    // previously silent — the status bar stayed on a bare "…" with no model
    // name and no retry. Surface it so the user fixes auth instead of
    // chasing a UI ghost.
    console.warn(
      `[ShiftRouter] Model switch FAILED: ${resolved.provider}/${resolved.modelId} (pi.setModel returned false — provider auth not configured? check ~/.pi/agent/models.json + auth.json). Tier stays ${state.currentTier ?? "?"}.`,
    );
    return false;
  } catch (err) {
    console.warn(`[ShiftRouter] Model switch failed: ${err}`);
    return false;
  }
}

/**
 * Sync display state to the ACTUAL session model after a model_select
 * event (native picker /model, Ctrl+P cycle, session restore). Display-only:
 * routing decisions are untouched. Tier is re-inferred from tier membership
 * so the badge emoji follows; models outside both tiers keep the last tier.
 *
 * @returns true when the inferred tier changed (for verbose logging).
 */
export function syncSessionModel(
  state: RouterState,
  config: ShiftRouterConfig,
  provider: string,
  modelId: string,
): boolean {
  const previousTier = state.currentTier;
  state.currentProvider = provider;
  state.currentModelId = modelId;
  const tier = findTierForModel(config, provider, modelId);
  if (tier) state.currentTier = tier;
  return tier !== undefined && tier !== previousTier && tier !== null;
}

export function clearManualOverride(state: RouterState): void {
  state.manualOverride = { active: false };
}

export function setManualOverrideTier(state: RouterState, tier: Tier): void {
  state.manualOverride = { active: true, tier };
}

export function setManualOverrideModel(state: RouterState, provider: string, modelId: string): void {
  state.manualOverride = { active: true, provider, modelId };
}
