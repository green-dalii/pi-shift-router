/**
 * pi-shift-router — Runtime failover (SPEC §8.5)
 *
 * Exponential-backoff cooldown state machine for models that fail at
 * runtime (429 / 5xx / quota exhausted). When pi's own retry layer
 * gives up on a model, we mark it into cooldown and route subsequent
 * calls to the next healthy model in the SAME tier (no cross-tier).
 *
 * All functions here are pure — IO (pi hooks, setModel, notify) lives
 * in index.ts.
 */

import type { ShiftRouterConfig, Tier, RouterState } from "./types.js";

/** Cooldown base delay: 1 minute (SPEC §8.5.2). */
export const COOLDOWN_BASE_MS = 60_000;
/** Hard cap on backoff: 6 hours (covers coding-plan rate windows up to ~5h). */
export const COOLDOWN_MAX_MS = 6 * 60 * 60_000;
/**
 * Starting attempt count for 4xx failures (429 rate limits, quota).
 * Client-side limits typically persist far longer than transient 5xx
 * server errors, so skip the first two tiers and start at 16m instead
 * of 1m. 5xx keeps the 1m start for fast recovery.
 */
export const COOLDOWN_START_ATTEMPTS_4XX = 3; // BASE * 4^2 = 16m

/** One cooldown entry: when it expires + how many consecutive failures. */
export interface CooldownEntry {
  until: number;
  attempts: number;
}

/** Cooldown map: modelKey → entry. */
export type CooldownMap = Map<string, CooldownEntry>;

/** Create an empty cooldown map. */
export function createCooldowns(): CooldownMap {
  return new Map();
}

/** Uniquely identify a provider/model pair. */
export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Record a failure and apply exponential backoff:
 * backoff = BASE * 4^(attempts-1), capped at COOLDOWN_MAX_MS.
 * Multiplier 4 gives 1m → 4m → 16m → 1h4m → 4h16m → 6h(cap) —
 * designed for hour-scale coding-plan rate windows, not per-minute RPM.
 *
 * 4xx failures (429 / quota — client-side limits) skip the first two
 * tiers and start at 16m (COOLDOWN_START_ATTEMPTS_4XX): client limits
 * usually outlive server-side blips, so probing at 1m/4m wastes calls.
 * `code` is the failover signature ("429", "503", …); omitted or 5xx
 * keeps the 1m start.
 */
export function markModelFailed(
  cooldowns: CooldownMap,
  provider: string,
  model: string,
  now: number,
  code?: string,
): void {
  const key = modelKey(provider, model);
  const prev = cooldowns.get(key);
  const is4xx = !!code && code.startsWith("4");
  const attempts = Math.max(
    (prev?.attempts ?? 0) + 1,
    is4xx ? COOLDOWN_START_ATTEMPTS_4XX : 1,
  );
  const backoff = Math.min(COOLDOWN_BASE_MS * 4 ** (attempts - 1), COOLDOWN_MAX_MS);
  cooldowns.set(key, { until: now + backoff, attempts });
}

/** True if the model is currently in cooldown (not yet expired). */
export function isModelInCooldown(
  cooldowns: CooldownMap | undefined,
  provider: string,
  model: string,
  now: number,
): boolean {
  if (!cooldowns) return false;
  const e = cooldowns.get(modelKey(provider, model));
  return !!e && e.until > now;
}

/** Remove a model from cooldown (recovery). */
export function clearModelCooldown(
  cooldowns: CooldownMap,
  provider: string,
  model: string,
): void {
  cooldowns.delete(modelKey(provider, model));
}

/** Milliseconds until the model's cooldown expires (0 if not cooling). */
export function remainingCooldownMs(
  cooldowns: CooldownMap,
  provider: string,
  model: string,
  now: number,
): number {
  if (!isModelInCooldown(cooldowns, provider, model, now)) return 0;
  const e = cooldowns.get(modelKey(provider, model))!;
  return e.until - now;
}

/**
 * Detect whether an error message indicates a transient provider failure
 * worth failing over (SPEC §8.5.3). Returns the detected code (for user
 * feedback) or null when the error is not failover-worthy.
 *
 * NOTE: this is error-signature detection only, NOT a routing decision.
 * The LLM Judge remains the sole tier classifier (AGENTS.md).
 */
export function detectFailoverError(message: string | undefined | null): { code: string } | null {
  if (!message) return null;
  const text = message.trim();
  if (!text) return null;

  // Keyword signatures (rate limit / quota / token plan).
  if (
    /rate[_ -]?limit/i.test(text) ||
    /too many requests/i.test(text) ||
    /quota/i.test(text) ||
    /insufficient[_ -]?quota/i.test(text) ||
    /token\s*plan/i.test(text) ||
    /用量上限/i.test(text) ||
    /rate_limit_error/i.test(text)
  ) {
    return { code: "429" };
  }

  // Billing-exhausted (402): the account has no credits left, so retrying the
  // same model is futile. Many pi-3 providers (OpenRouter-style gateways,
  // zhipu/GLM, MiniMax) return "Insufficient Balance" wrapped in an HTTP 402.
  // Pre-v1.4.1 this silently fell through and pinned the dead model forever.
  if (
    /insufficient[_ -]?balance/i.test(text) ||
    /余额不足/i.test(text)
  ) {
    return { code: "402" };
  }

  // Provider-side "model not on this endpoint" — retrying the same model
  // will never succeed. Treat as failover-worthy so the next same-tier
  // model is tried next turn and the dead model is cooled.
  if (
    /unsupported[_ -]?model/i.test(text) ||
    /model[_ -]?not[_ -]?found/i.test(text) ||
    /not\s+supported/i.test(text)
  ) {
    return { code: "unsupported_model" };
  }

  // HTTP status codes, only when prefixed by an error context
  // (e.g. "Error: 500", "HTTP 502", "status 503") so bare numbers
  // in prose ("the output was 500 tokens") are not misread.
  // 429 = rate limit; 402 = billing-exhausted (same 4xx backoff bucket);
  // 50[0-9]/51[0-9]/52[0-9] = server errors (transient, fast 1m start).
  const statusMatch = text.match(
    /(?:error|http|status|code)[^\n]{0,12}\b(429|402|50[0-9]|51[0-9]|52[0-9])\b/i,
  );
  if (statusMatch) return { code: statusMatch[1] };

  return null;
}

/**
 * Find the next healthy model for a tier, skipping:
 *   1. the model that just failed (skipKey), and
 *   2. any model currently in cooldown.
 * Never crosses tiers.
 */
export function findFailoverModel(
  tier: Tier,
  config: ShiftRouterConfig,
  modelRegistry: { find: (p: string, m: string) => unknown } | undefined,
  cooldowns: CooldownMap | undefined,
  now: number,
  skipKey?: string,
): { provider: string; modelId: string; tier: Tier } | null {
  const tierConfig = config.tiers?.[tier];
  if (!tierConfig?.models?.length || !modelRegistry?.find) return null;

  const sorted = [...tierConfig.models].sort((a, b) => a.priority - b.priority);

  for (const ref of sorted) {
    if (ref.provider === undefined || ref.model === undefined) continue;
    if (skipKey && modelKey(ref.provider, ref.model) === skipKey) continue;
    if (isModelInCooldown(cooldowns, ref.provider, ref.model, now)) continue;
    try {
      if (modelRegistry.find(ref.provider, ref.model)) {
        return { provider: ref.provider, modelId: ref.model, tier };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Build a cooldown-aware predicate for findBestModelForTier.
 * Returns undefined when no cooldowns are active (fast path).
 */
export function cooldownPredicate(
  cooldowns: CooldownMap | undefined,
  now: number,
): ((provider: string, model: string) => boolean) | undefined {
  if (!cooldowns || cooldowns.size === 0) return undefined;
  return (provider: string, model: string) =>
    isModelInCooldown(cooldowns, provider, model, now);
}

/** Format remaining cooldown for display: "3m12s". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/** Max number of recent speed samples kept for averaging. */
export const SPEED_WINDOW_SIZE = 5;

/**
 * Throughput display smoothing (v1.4.2): the status bar shows the MEDIAN of
 * the sliding window, not the last sample. A single artifact reading (see
 * MIN_STREAM_ELAPSED_MS) can spike ~10x above the honest rate; the median is
 * immune to isolated outliers while still tracking genuine rate changes
 * within the 5-sample window.
 *
 * Even-count windows average the two middle values; empty windows read 0.
 */
export function medianSpeed(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Measurement-noise floor for elapsed time (ms). A provider that delivers
 * message_start late (or a clock artifact) can yield "2000 tokens in 40ms"
 * — tens of thousands of tok/s — which is a start-time misalignment, not a
 * real rate. Real streaming always spans at least a network round-trip, so
 * anything under this floor is discarded rather than recorded.
 */
export const MIN_STREAM_ELAPSED_MS = 50;

/**
 * Compute tokens-per-second from elapsed ms and output tokens.
 * Returns 0 when elapsed < MIN_STREAM_ELAPSED_MS (measurement artifact) or
 * output_tokens <= 0.
 */
export function tokensPerSecond(outputTokens: number, elapsedMs: number): number {
  if (elapsedMs < MIN_STREAM_ELAPSED_MS || outputTokens <= 0) return 0;
  return Math.round((outputTokens / elapsedMs) * 1000);
}

/** Push a new speed reading into the sliding window (evict oldest beyond limit). */
export function recordSpeed(speeds: number[], tps: number): void {
  speeds.push(tps);
  while (speeds.length > SPEED_WINDOW_SIZE) speeds.shift();
}

/**
 * Throughput fallback (agent_end). The primary path (message_start →
 * message_end wall-clock) is precise, but some providers/paths never deliver
 * message_start with a usable assistant role, leaving `streamingStartTime`
 * null — the status bar loses its "• N tok/s" indicator. agent_end always
 * carries the full message list, so derive the LAST assistant message's
 * generation speed from message timestamps + usage.
 *
 * v1.4.2 (Bug A fix): the guard is TURN-SCOPED, not session-scoped. The old
 * guard (`recentSpeeds.length > 0`) read a window that persists across turns,
 * so after the first successful primary recording ANYWHERE in the session,
 * this fallback was permanently disabled — providers with broken
 * message_start timing never got a TPS reading again. The caller now passes
 * whether the primary path recorded during THIS turn.
 * Only fills when the primary path produced nothing (redundant otherwise).
 */
export function recordTurnThroughputFallback(
  messages: Array<{ role?: string; timestamp?: number; usage?: { output?: number } }>,
  state: RouterState,
  primaryRecordedThisTurn: boolean,
): boolean {
  if (primaryRecordedThisTurn) return false; // primary path recorded this turn
  let lastTps = 0;
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const out = m.usage?.output ?? 0;
    if (out <= 0) continue;
    const ts = m.timestamp;
    const prev = messages[i - 1];
    const start = typeof prev?.timestamp === "number" ? prev.timestamp : undefined;
    if (typeof ts !== "number" || start === undefined) continue;
    const elapsedMs = ts - start;
    if (elapsedMs <= 0) continue;
    const tps = tokensPerSecond(out, elapsedMs);
    if (tps > 0) lastTps = tps;
  }
  if (lastTps > 0) {
    recordSpeed(state.recentSpeeds, lastTps);
    return true;
  }
  return false;
}

// ── Integration helpers (SPEC §8.5.2) ──────────────────────────────
// These are kept pure and dependency-injected so they can be unit-tested
// without touching pi's extension API. index.ts wires them to hooks.

/** Minimal shape of the last assistant message from agent_end. */
export interface FailedTurnInfo {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Inspect the tail of an agent_end transcript for a failover-worthy
 * failure. Returns the failed model + detected code, or null.
 * SPEC §8.5.2(1): last assistant message with stopReason "error".
 */
export function detectTurnFailure(messages: unknown[]): {
  provider: string;
  model: string;
  code: string;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as FailedTurnInfo | undefined;
    if (!m || typeof m !== "object") continue;
    if (m.role !== "assistant") continue;
    // Only the final assistant message can fail a turn; earlier ones succeeded.
    if (m.stopReason === "error") {
      const det = detectFailoverError(m.errorMessage);
      if (det && m.provider && m.model) {
        return { provider: m.provider, model: m.model, code: det.code };
      }
    }
    // An assistant message without error ends the search (earlier failures
    // were already handled by a previous failover).
    return null;
  }
  return null;
}

/** Result of running the immediate failover decision. */
export interface FailoverDecision {
  /** The model that failed and was put into cooldown. */
  failed: { provider: string; model: string; code: string };
  /** The replacement model (null when the tier is exhausted). */
  fallback: { provider: string; modelId: string; tier: Tier } | null;
  /** Whether we switched models (false when tier exhausted). */
  switched: boolean;
}

/**
 * Reverse-lookup: which tier does a provider/model belong to?
 * Returns null when ambiguous (in both tiers) or unknown.
 * Used to fail over within the tier that actually owns the failed model,
 * rather than assuming state.currentTier.
 */
export function findTierForModel(
  config: ShiftRouterConfig,
  provider: string,
  model: string,
): Tier | null {
  const inFast = config.tiers?.fast?.models?.some(
    (m) => m.provider === provider && m.model === model,
  );
  const inSmart = config.tiers?.smart?.models?.some(
    (m) => m.provider === provider && m.model === model,
  );
  if (inFast && inSmart) return null; // ambiguous — caller decides
  if (inFast) return "fast";
  if (inSmart) return "smart";
  return null;
}

/**
 * Handle a failed turn: mark the failing model into cooldown and pick a
 * same-tier fallback. Pure — the caller applies the switch via pi.setModel.
 *
 * @returns null when no failure was detected (nothing to do).
 */
export function planTurnFailover(
  messages: unknown[],
  state: { modelCooldowns: CooldownMap; currentTier: Tier },
  config: ShiftRouterConfig,
  modelRegistry: { find: (p: string, m: string) => unknown } | undefined,
  now: number,
): FailoverDecision | null {
  const failed = detectTurnFailure(messages);
  if (!failed) return null;

  markModelFailed(state.modelCooldowns, failed.provider, failed.model, now, failed.code);

  // Fail over within the tier that owns the failed model, falling back to
  // the current tier when the model is unknown or ambiguous.
  const failTier = findTierForModel(config, failed.provider, failed.model) ?? state.currentTier;

  const fallback = findFailoverModel(
    failTier,
    config,
    modelRegistry,
    state.modelCooldowns,
    now,
    modelKey(failed.provider, failed.model),
  );

  return {
    failed,
    fallback,
    switched: fallback !== null,
  };
}
