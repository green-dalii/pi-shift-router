/**
 * pi-shift-router — Tier management
 *
 * Handles model lookup across tiers, priority-based fallback,
 * and integration with pi's model registry.
 */

import type { ShiftRouterConfig, Tier } from "./types.js";
import { TIERS } from "./types.js";

/** Resolved model info with its tier */
export interface ResolvedModel {
  provider: string;
  modelId: string;
  tier: Tier;
}

/**
 * Find the best available model for a given tier.
 * Searches pi's model registry by provider + model id, falls back by priority.
 *
 * @param isCooldown Optional predicate; when provided, models for which it
 *   returns true are skipped (SPEC §8.5 runtime failover).
 */
export function findBestModelForTier(
  tier: Tier,
  config: ShiftRouterConfig,
  modelRegistry: { find: (provider: string, modelId: string) => unknown } | undefined,
  isCooldown?: (provider: string, modelId: string) => boolean,
): ResolvedModel | null {
  const tierConfig = config.tiers[tier];
  if (!tierConfig?.models?.length || !modelRegistry?.find) return null;

  const sorted = [...tierConfig.models].sort((a, b) => a.priority - b.priority);

  for (const ref of sorted) {
    try {
      if (isCooldown?.(ref.provider, ref.model)) continue;
      if (modelRegistry.find(ref.provider, ref.model)) {
        return { provider: ref.provider, modelId: ref.model, tier };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** Check if a tier is valid */
export function isValidTier(s: string): s is Tier {
  return TIERS.includes(s as Tier);
}

/** Get display label for a tier */
export function tierLabel(tier: Tier, config: ShiftRouterConfig): string {
  const cfg = config.tiers[tier];
  return cfg?.label ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** Get emoji for a tier */
export function tierEmoji(tier: Tier): string {
  switch (tier) {
    case "smart":
      return "🧠";
    case "fast":
      return "🦾";
  }
}

/** Format tier for status bar: "[🧠 kimi-k3]". `uncertain` appends "?" to the
 * model name — the router *intends* this model but it isn't confirmed active
 * (e.g. a model switch was refused because auth is missing). */
export function formatTierDisplay(
  tier: Tier | null,
  modelId: string | null,
  uncertain = false,
): string {
  if (!tier) return "";
  const emoji = tierEmoji(tier);
  const model = modelId?.split("/").pop() ?? "…";
  return `[${emoji} ${model}${uncertain && model !== "…" ? "?" : ""}]`;
}

/**
 * Like formatTierDisplay but appends a tokens-per-second indicator when positive.
 * E.g. "[🧠 kimi-k3 • 23 tok/s]".
 */
export function formatTierDisplayWithSpeed(
  tier: Tier | null,
  modelId: string | null,
  tokensPerSec: number,
  uncertain = false,
): string {
  const base = formatTierDisplay(tier, modelId, uncertain);
  if (!base || tokensPerSec <= 0) return base;
  return `${base} • ${tokensPerSec} tok/s`;
}
