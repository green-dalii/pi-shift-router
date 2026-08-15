/**
 * pi-shift-router — Type definitions
 *
 * Two-tier routing: Fast (engineer) ↔ Smart (CTO).
 * Fast: execution-heavy tasks, daily coding, following patterns.
 * Smart: judgment-heavy tasks, architecture, planning, code review.
 */

/** The two routing tiers */
export type Tier = "fast" | "smart";

/** All tier labels */
export const TIERS: readonly Tier[] = ["fast", "smart"] as const;

/** Judge result (tier classification) */
export interface JudgeResult {
  tier: Tier;
  source: "llm" | "fallback";
  /**
   * LLM's confidence in the tier classification, in [0, 1].
   * Used by the confidence-weighted sliding window: entries below
   * `window.minConfidence` are ignored; weighted ratio decides downgrade.
   * Defaults to 1.0 when the Judge doesn't emit it (backward-compat).
   */
  confidence?: number;
  /**
   * Ultra-short human-readable reason for the classification (one phrase,
   * e.g. "user asked for depth" / "routine bug fix"). Emitted by the Judge
   * as a JSON field and surfaced in verbose logs + `/router status` detail
   * — a debugging aid, never used by the routing algorithm itself.
   */
  reason?: string;
}

/** A reference to a specific model in a specific provider */
export interface ModelRef {
  provider: string;
  model: string;
  priority: number;
}

/** Configuration for one tier */
export interface TierConfig {
  label: string;
  models: ModelRef[];
  description: string;
}

/** UX configuration */
export interface UXConfig {
  quietMode: boolean;
  statusBar: boolean;
  inlineToast: boolean;
  /** Verbose logging: print router decisions, judge calls, window state to console */
  routerLogVerbose: boolean;
}

/** Routing behaviour config */
export interface RoutingConfig {
  mode: "auto" | "manual" | "off";
  /** LLM Judge timeout in ms */
  judgeTimeout: number;
  /**
   * Sliding window for downgrade gating. Entries whose confidence is
   * below `minConfidence` are ignored. Downgrade fires when
   * `Σ confidence_for_fast / window_size` ≥ `threshold`.
   */
  window: { size: number; threshold: number; minConfidence?: number };
  /**
   * Cache-aware routing (SPEC §9.2). When fast and smart resolve to the
   * same provider family, a mid-session model switch forfeits the prompt
   * cache (cache reads bill at 0.1x–0.5x base input) — downgrading to a
   * cheaper model can cost 3.5x more, not less. When enabled:
   *   - the downgrade threshold is raised to `sameFamilyThreshold` so
   *     fewer mid-session downgrades fire, and
   *   - downgrades are suppressed within `idleBoundaryMs` of the last
   *     message (the cache is warm); they only fire after an idle gap
   *     long enough that the cache has already expired.
   * Default disabled; `shareProviderFamily()` auto-detection turns it on
   * when both tiers use the same provider.
   */
  cacheAware?: {
    enabled: boolean;
    sameFamilyThreshold: number;
    idleBoundaryMs: number;
  };
}

/** Full SLIM Router configuration */
export interface ShiftRouterConfig {
  enabled: boolean;
  tiers: {
    fast: TierConfig;
    smart: TierConfig;
  };
  routing: RoutingConfig;
  ux: UXConfig;
  /** Task-level orchestration (SPEC §9.3, planned v1.0.0). Default off — opt-in. */
  orchestration: OrchestrationConfig;
}

/**
 * Task-level orchestration (SPEC §9.3). When active AND Judge says complex,
 * the main agent runs the Smart model with an orchestrator instruction: it
 * plans, delegates implementation to Fast subagents (via the subagent tool),
 * reviews each result, and loops until clean — with plugin-side hard caps.
 *
 * Default "auto" (this is a v1.0.0 feature — shipped on by default so users
 * experience it; anyone who prefers plain routing runs `/router orchestrate
 * off`). All fields optional — an existing config without `orchestration.*`
 * parses unchanged (deepMerge from DEFAULT_CONFIG).
 */
export interface OrchestrationConfig {
  /**
   * Mode. "auto" (default): Judge-driven — simple tasks (fast verdict) keep
   * the plain router; complex tasks (smart verdict) escalate to
   * Smart-orchestrated execution. "off": never orchestrate — byte-for-byte
   * today's router. There is no "always" mode: orchestration is never forced
   * on simple work.
   */
  mode: "auto" | "off";
  /** Max review/delegate rounds before Smart takes over (hard cap). */
  maxRounds: number;
  /** A worker failing ≥N times → Smart takes over the phase itself. */
  escalationThreshold: number;
  /** Skip orchestration when the Smart tier model can't be resolved. */
  requireSmartModel: boolean;
}

/** Orchestration lifecycle state (session-scoped, not persisted). */
export interface OrchestrationState {
  /** Is the main agent currently running as an orchestrator? */
  active: boolean;
  /** Rounds consumed this task (hard cap: maxRounds). */
  rounds: number;
  /** Workers escalated this task (hard cap: escalationThreshold). */
  escalations: number;
  /** Epoch ms when the current orchestration task started. */
  startedAt: number | null;
  /** Estimated spend so far (USD) — hard budget guard. */
  spend: number;
}

/** Default configuration */
export const DEFAULT_CONFIG: ShiftRouterConfig = {
  enabled: true,
  tiers: {
    fast: {
      label: "Fast",
      models: [],
      description: "Daily coding, debugging, following patterns — execution mode",
    },
    smart: {
      label: "Smart",
      models: [],
      description: "Architecture, planning, code review, trade-off analysis — judgment mode",
    },
  },
  routing: {
    mode: "auto",
    judgeTimeout: 5000,
    window: { size: 5, threshold: 0.6, minConfidence: 0.5 },
    cacheAware: {
      enabled: true,
      sameFamilyThreshold: 0.9,
      idleBoundaryMs: 5 * 60_000,
    },
  },
  ux: {
    quietMode: false,
    statusBar: true,
    inlineToast: true,
    routerLogVerbose: false,
  },
  orchestration: {
    mode: "auto",
    maxRounds: 3,
    escalationThreshold: 2,
    requireSmartModel: true,
  },
};

/** Model entry from models-store.json */
export interface StoredModel {
  id: string;
  name?: string;
  provider: string;
  baseUrl?: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
}

/** One provider's entry in the merged model store. */
export interface ProviderEntry {
  models: StoredModel[];
  /** Provider-level fields — custom providers in models.json put baseUrl/api/apiKey here. */
  baseUrl?: string;
  api?: string;
  apiKey?: string;
}

/** Merged model store: built-in catalog (models-store.json) + custom providers (models.json). */
export interface ModelsStore {
  [provider: string]: ProviderEntry;
}

/** Window entry — one Judge result */
export interface WindowEntry {
  tier: Tier;
  timestamp: number;
  /**
   * Confidence of this classification (defaults to 1.0 when missing).
   * Used by the confidence-weighted sliding window.
   */
  confidence?: number;
}

/** Auth store shape — maps provider name to API key */
export interface AuthStore {
  [provider: string]: { type: string; key: string };
}

/** Resolved info for making an API call to a provider */
export interface ProviderEndpoint {
  provider: string;
  baseUrl: string;
  apiType: string;       // "openai-completions" | "openai-responses" | "anthropic-messages"
  apiKey: string;
  modelId: string;
}

/** Configured tier with resolved model info (for config display) */
export interface TierEntry {
  tier: Tier;
  label: string;
  description: string;
  models: Array<{ provider: string; model: string }>;
}

import type { CooldownMap } from "./failover.js";

/** Router internal state */
export interface RouterState {
  currentTier: Tier;
  currentModelId: string | null;
  currentProvider: string | null;
  window: WindowEntry[];
  manualOverride: {
    active: boolean;
    tier?: Tier;
    modelId?: string;
    provider?: string;
  };
  /** Models in exponential-backoff cooldown after runtime failure (SPEC §8.5) */
  modelCooldowns: CooldownMap;
  /** Cumulative output tokens across the session (from AssistantMessage.usage.output). */
  totalOutputTokens: number;
  /** Sliding window of recent tokens-per-second readings (for `/router stats`). */
  recentSpeeds: number[];
  /** Epoch ms when the current in-flight assistant message started streaming; null when none. */
  streamingStartTime: number | null;
  /** Cumulative count of fast→smart tier transitions. */
  upgradeCount: number;
  /** Cumulative count of smart→fast tier transitions. */
  downgradeCount: number;
  /**
   * Epoch ms of the most recent assistant message end (any tier). Used by
   * cache-aware routing (SPEC §9.2) to detect whether a session boundary
   * has passed — a gap longer than the provider's cache TTL means the
   * prompt cache is already cold, so downgrading costs nothing extra.
   * 0 when no message has completed yet.
   */
  lastActivityAt: number;
  /**
   * Cumulative per-tier spend. Populated from pi-agent's
   * `message_end.usage.cost.total` (USD) plus token counts.
   * SPEC §9 (Cost telemetry — deep view).
   */
  tierUsage: Record<Tier, TierUsage>;
  /**
   * Per-message record of (tier, provider, modelId, tokens). Used to compute
   * the "what it would have cost on the most expensive model you used"
   * hypothetical baseline for the savings estimate.
   */
  callLog: CallRecord[];
  /** Task-level orchestration lifecycle (SPEC §9.3). */
  orchestration: OrchestrationState;
}

/** Token counts for one assistant message. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Cumulative spend for a single tier. */
export interface TierUsage {
  calls: number;
  tokens: TokenUsage;
  /** USD summed from pi-agent's `message_end.usage.cost.total`. */
  cost: number;
}

/** Per-message attribution record kept for hypothetical baseline calculation. */
export interface CallRecord {
  tier: Tier;
  provider: string;
  modelId: string;
  tokens: TokenUsage;
  cost: number;
}
