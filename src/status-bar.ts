/**
 * pi-shift-router — Status-bar label (pure, testable without pi).
 *
 * Rendering contract:
 * - Plain tier badge `[🦾 deepseek-v4-flash • 23 tok/s]` whenever nothing is
 *   being delegated. The wand 🪄 is reserved for delegation IN FLIGHT only
 *   (`orchestration.spawned > 0`); a planning frame or a leaked orchestration
 *   state must never read as "orchestrating".
 * - A missing `currentModelId` (e.g. a model switch was refused because the
 *   provider auth isn't configured in pi's runtime) falls back to the tier's
 *   best resolvable model, marked `?` — "intended, not confirmed" — instead
 *   of a bare `…`.
 */

import type { RouterState, ShiftRouterConfig, Tier } from "./types.js";
import { formatTierDisplayWithSpeed } from "./tier.js";
import { findBestModelForTier } from "./tier.js";
import { medianSpeed } from "./failover.js";

/** Append a throughput segment when a reading exists; bare label otherwise. */
function speedLabel(base: string, speed: number): string {
  return speed > 0 ? `${base} • ${speed} tok/s` : base;
}

/**
 * Compute the status-bar label for the current router state.
 *
 * `modelRegistry` is optional: when provided it enables the "intended model"
 * fallback for a null `currentModelId`. Returns undefined when the status bar
 * is disabled (the caller should pass undefined to `ui.setStatus` to clear it).
 */
export function formatStatusBarLabel(
  cfg: ShiftRouterConfig,
  s: RouterState,
  modelRegistry?: { find: (provider: string, modelId: string) => unknown },
): string | undefined {
  if (!cfg.ux.statusBar) return undefined;
  // Median of the sliding window, not the last sample: a single artifact
  // reading (late message_start / clock noise) can spike ~10x; the median is
  // spike-proof while still tracking genuine rate changes (v1.4.2).
  const speed = medianSpeed(s.recentSpeeds);

  // Delegation in flight → dedicated orchestration label. Done/Total =
  // completed vs started subagent tool-calls this run (one workflowScript
  // call is one tool_call; inner runs.all fan-out is not separately counted).
  // Throughput is the MEDIAN across completed workers — spike-proof, same
  // rationale as the plain-turn label. Cap-hit indicator: the hard caps
  // (maxRounds / escalationThreshold) are reached and new spawns are blocked
  // — show it so the user sees the loop is being stopped by the plugin, not
  // stuck.
  if (s.orchestration.active && s.orchestration.spawned > 0) {
    const o = s.orchestration;
    const capLabel =
      o.rounds >= cfg.orchestration.maxRounds || o.escalations >= cfg.orchestration.escalationThreshold
        ? " ⛔cap"
        : "";
    if (o.workerSpeeds.length > 0) {
      const med = medianSpeed(o.workerSpeeds);
      return `🪄 Done(${o.done})/Total(${o.spawned}) • ~${med} tok/s${capLabel}`;
    }
    return `🪄 Done(${o.done})/Total(${o.spawned})${capLabel}`;
  }

  // Planning phase or plain routing: the tier badge — the chosen tier's own
  // model is doing the thinking, so throughput telemetry stays visible.
  const tier: Tier | null = s.currentTier;
  const confirmed = s.currentModelId;
  let modelId = confirmed;
  let uncertain = false;
  if (!modelId && tier) {
    try {
      const m = modelRegistry ? findBestModelForTier(tier, cfg, modelRegistry) : null;
      if (m) {
        modelId = m.modelId;
        uncertain = true;
      }
    } catch {
      /* keep the bare fallback */
    }
  }
  const base = cfg.enabled
    ? formatTierDisplayWithSpeed(tier, modelId, speed, uncertain)
    : speedLabel("⛔", speed);
  return base;
}
