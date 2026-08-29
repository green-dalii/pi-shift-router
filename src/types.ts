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
  /**
   * Judge's explicit orchestration signal (v1.1.0+). true = task is large
   * enough / decomposable enough that the Smart tier should orchestrate
   * Fast subagents instead of running the turn directly; false = Smart
   * runs the turn directly. Absent (older prompt / model didn't emit) =
   * no opinion — caller falls back to the tier-based default (smart →
   * orchestrate), preserving v1.0.0 behavior.
   */
  orchestrate?: boolean;
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
/** Named economics presets for `/router mode` (SPEC §2.3). */
export type EconomicMode = "eco" | "default" | "sport";

/**
 * R (reworkPenalty) per named mode — the only knob the gear presets touch.
 * θ = 1/R, and the turn runs smart iff pSmart ≥ θ, so HIGHER R → LOWER θ →
 * more eager escalation (stickier on Smart); LOWER R → HIGHER θ → only
 * clearly-needed turns run smart (cheaper).
 * eco: R=2 (θ=0.5) — conservative/cheap: only clearly-needed turns upgrade
 * default: R=3 (θ≈0.33)
 * sport: R=5 (θ=0.2) — eager/sticky: any real chance of needing Smart escalates
 */
export const ECONOMIC_MODE_PRESETS: Record<EconomicMode, number> = {
  eco: 2,
  default: 3,
  sport: 5,
};

/**
 * Pre-v1.4.0 defaults for the two LEGACY knobs. A config carrying exactly
 * these values is a wizard snapshot of the old defaults, not a deliberate
 * customization — it must migrate silently to the new rule (dead), not be
 * reinterpreted under new semantics. Only a *different* value is honored as
 * an override (and surfaced in /router status).
 */
export const LEGACY_THRESHOLD_DEFAULT = 0.6;
export const LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT = 0.9;

export interface RoutingConfig {
  mode: "auto" | "manual" | "off";
  /** LLM Judge timeout in ms */
  judgeTimeout: number;
  /**
   * Decision memory. Entries whose confidence is below `minConfidence` are
   * treated as no-signal holds (never switch, break a fast streak).
   * `threshold` is the LEGACY explicit θ override (raw pSmart bar) — prefer
   * `economics.reworkPenalty`. When absent, θ = 1/reworkPenalty (SPEC §2.3).
   */
  window: { size: number; threshold?: number; minConfidence?: number };
  /**
   * Expected-cost economics (SPEC §2.3). `reworkPenalty` encodes how many
   * price-deltas a wrong downgrade costs (rework multiplier); θ = 1/R.
   * `downgradeMemory` = consecutive decisive fast decisions required to
   * downgrade from smart to fast.
   * `mode` = named preset (`/router mode`); when present it is authoritative
   * over `reworkPenalty` (which stays as the legacy/manual fallback).
   */
  economics: { reworkPenalty: number; downgradeMemory: number; mode?: EconomicMode };
  /**
   * Cache-aware routing (SPEC §9.2). When fast and smart resolve to the
   * same provider family, a mid-session model switch forfeits the prompt
   * cache (cache reads bill at 0.1x–0.5x base input). When enabled:
   *   - effective θ is divided by `sameFamilyPenalty` (fewer downgrades),
   *   - downgrades are suppressed within `idleBoundaryMs` of the last
   *     message (the cache is warm); they only fire after an idle gap
   *     long enough that the cache has already expired.
   * `sameFamilyThreshold` is the LEGACY knob — when present it implies the
   * strong default penalty 3.0.
   * Default disabled; `shareProviderFamily()` auto-detection turns it on
   * when both tiers use the same provider.
   */
  cacheAware?: {
    enabled: boolean;
    sameFamilyThreshold?: number;
    sameFamilyPenalty?: number;
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
  /**
   * Post-turn acceptance audit (托底 review). When enabled, the plugin runs
   * a deterministic completeness check on every orchestrated turn and (when
   * the audit LLM is reachable) a small verification pass over the CTO's
   * summary vs the worker results. The audit is a hard *fallback*: it never
   * blocks the completed turn, but it flags ungrounded acceptance (e.g. the
   * CTO claimed "done" without reviewing) in logs / toast / `/router status`.
   */
  audit?: OrchestrationAuditConfig;
}

/** Configuration for the orchestration acceptance audit (SPEC §9.3). */
export interface OrchestrationAuditConfig {
  /** Run the audit at the end of every orchestrated turn. Default true. */
  enabled: boolean;
  /** Max ms for the LLM audit call (best-effort; deterministics always run). */
  timeoutMs: number;
}

/**
 * Result of the post-turn acceptance audit for one orchestrated turn.
 * Stored on `RouterState.lastAudit` (survives orchestration state reset)
 * and surfaced in logs / toast / `/router status`.
 */
export interface OrchestrationAudit {
  /** Epoch ms when the audit ran (agent_end of the orchestrated turn). */
  auditedAt: number;
  /** All spawned workers returned (done === spawned). False if a worker never reported back. */
  complete: boolean;
  /** Final assistant message looks like a CTO summary (output-contract markers). */
  hasCtoSummary: boolean;
  /** The task ended at a hard cap (maxRounds / escalationThreshold reached). */
  capHit: boolean;
  /** True when the orchestrated turn self-executed (spawned = 0, no LLM audit). */
  selfExecuted?: boolean;
  /** Deterministic violation strings (empty when the turn was clean). */
  violations: string[];
  /** LLM audit verdict (optional — only when the audit LLM call succeeded). */
  llm?: {
    /** "pass" or "flag". */
    verdict: "pass" | "flag";
    /** Specific issues the auditor found (human-readable). */
    issues: string[];
  };
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
  /** Subagent workers spawned during this orchestration task. */
  spawned: number;
  /** Subagent workers completed (tool_result received) this task. */
  done: number;
  /**
   * Per-worker throughput readings (tokens/sec), one per completed worker
   * this task. Drives the "~N tok/s avg" segment of the workers status-bar
   * label — average across completed workers, not a single worker, so
   * concurrent completions don't make the display jumpy.
   */
  workerSpeeds: number[];
  /**
   * Consecutive failed worker results this task (SPEC §9.3 escalation).
   * A failed subagent result increments it; when it reaches
   * `config.orchestration.escalationThreshold` it is counted as an
   * escalation and reset. A successful result resets it. Drives the hard
   * "Smart takes over the phase" cap — plugin-enforced, not prompt-side.
   */
  workerFailStreak: number;
  /**
   * Snapshot of the user's original prompt for this orchestrated turn.
   * Captured at `enterOrchestration` (before_agent_start) and fed to the
   * post-turn acceptance audit so it can verify **goal alignment** — the
   * delivered work matches what the user asked for, not just that the CTO
   * claimed success. Null until the first orchestrated turn starts.
   */
  goal: string | null;
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
    window: { size: 5, minConfidence: 0.5 },
    economics: { reworkPenalty: 3, downgradeMemory: 2 },
    cacheAware: {
      enabled: true,
      sameFamilyPenalty: 1.5,
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
    audit: { enabled: true, timeoutMs: 5000 },
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

/** Window entry — one Judge result / routing decision */
export interface WindowEntry {
  tier: Tier;
  timestamp: number;
  /**
   * Confidence of this classification (defaults to 1.0 when missing).
   * Display/debug only — decisions are EV-driven (SPEC §2.3).
   */
  confidence?: number;
  /** True = judge confidence below minConfidence (no signal, breaks streaks). */
  hold?: boolean;
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
  /**
   * Result of the last orchestration acceptance audit (SPEC §9.3 audit).
   * Survives orchestration state reset so `/router status` can report it
   * after the turn that triggered it has ended. Null until the first
   * orchestrated turn completes.
   */
  lastAudit: OrchestrationAudit | null;
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
