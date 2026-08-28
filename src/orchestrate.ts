/**
 * pi-shift-router — Task-level orchestration (SPEC §9.3, v1.0.0)
 *
 * The plugin's whole job here is (a) decide when a Judge "smart" verdict
 * becomes an orchestration run, (b) inject the orchestrator instruction with
 * the current Fast/Smart tier chains rendered in, and (c) hold the hard caps
 * (rounds, escalations, budget). The actual loop — plan, delegate via the
 * subagent tool, review, re-delegate, take over, accept — is the Smart main
 * agent's own work once the orchestrator prompt is active.
 *
 * Design constraints (SPEC §9.3):
 * - Tiers are the single source of truth; we render pi-shift-router.json
 *   tier chains (healthy-only, cooldown-filtered) into the prompt. We never
 *   write pi-subagents' settings — per-run model overrides are passed by the
 *   Smart agent, guided by the rendered chain.
 * - Backward compatibility: with `orchestration.mode` "off" (explicit opt-out
 *   via `/router orchestrate off`), every path here is a no-op — behavior is
 *   byte-for-byte today's router. Default is "auto" (v1.0.0 feature shipped
 *   on by default); even in auto, simple tasks (fast verdict) never
 *   orchestrate, and missing subagent tool / unresolvable Smart model skip
 *   injection — so the default change is invisible for plain routing.
 * - Simple tasks never orchestrate: only a Judge "smart" verdict can enter.
 * - Missing pi-subagents / unresolvable Smart model → skip injection and run
 *   the turn as today's smart-tier run (no crash).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  ShiftRouterConfig,
  RouterState,
  OrchestrationState,
  ModelRef,
} from "./types.js";

// ─── Orchestrator prompt ─────────────────────────────────────────

const FALLBACK_ORCHESTRATOR_PROMPT =
  `You are the CTO orchestrating this complex task. Plan it, delegate\n` +
  `implementation to Fast subagents (agent: "worker", context: "fresh", model\n` +
  `pinned from the Fast tier), review each result, re-delegate with concrete\n` +
  `feedback, take over a phase yourself after {{escalationThreshold}} failed\n` +
  `worker attempts, and do a final acceptance pass. Max {{maxRounds}} rounds.\n` +
  `Re-delegations must include a failure report (what failed, where, the\n` +
  `acceptance test to re-run). Do not repeat the same feedback twice — after\n` +
  `{{escalationThreshold}} consecutive failures the router blocks new spawns;\n` +
  `take over the phase yourself.`;

function loadOrchestratorPrompt(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "./prompts/orchestrator.md");
    return readFileSync(path, "utf-8").trim();
  } catch (err) {
    console.warn("[ShiftRouter] Failed to load prompts/orchestrator.md, using fallback:", err);
    return FALLBACK_ORCHESTRATOR_PROMPT;
  }
}

const ORCHESTRATOR_PROMPT = loadOrchestratorPrompt();

// ─── Tier chain rendering ─────────────────────────────────────────

/**
 * Render one tier's model chain as `provider/model:thinking` lines in
 * priority order, skipping models currently in cooldown.
 *
 * `thinkingSuffix` is the explicit thinking level to pin (e.g. "high").
 * Fork-context workers get force-forced to `thinking: off` by pi-subagents'
 * safety sanitizer for anthropic-messages APIs, so the orchestrator prompt
 * explicitly instructs `context: "fresh"` + explicit thinking — verified
 * (2026-08-13) to honor the override.
 */
export function renderTierChain(
  models: ModelRef[] | undefined,
  isCooldown: ((provider: string, model: string) => boolean) | undefined,
  thinkingSuffix: string,
): string {
  if (!models || models.length === 0) return "(none — fall back to Smart for implementation)";
  const sorted = [...models].sort((a, b) => a.priority - b.priority);
  const lines: string[] = [];
  let skipped = 0;
  for (const ref of sorted) {
    try {
      if (isCooldown?.(ref.provider, ref.model)) {
        skipped += 1;
        continue;
      }
    } catch {
      // cooldown predicate must never block rendering
    }
    lines.push(`  ${lines.length + 1}. \`${ref.provider}/${ref.model}:${thinkingSuffix}\``);
  }
  if (lines.length === 0) {
    if (skipped > 0) return "(all models in cooldown — fall back to Smart for implementation)";
    return "(none — fall back to Smart for implementation)";
  }
  return lines.join("\n");
}

/** Resolve the explicit thinking level to pin for worker models. */
export function defaultThinkingSuffix(): string {
  // Fast-tier execution quality depends on reasoning; "high" is the safe
  // default (matches the user's defaultThinkingLevel and worker frontmatter).
  // Future: read from config when a per-tier thinking level lands.
  return "high";
}

// ─── Orchestrator prompt assembly ─────────────────────────────────

/**
 * Build the full orchestrator instruction for this turn.
 *
 * Renders the Fast tier chain (cooldown-filtered) and Smart tier chain into
 * the orchestrator.md template. `isCooldown` is injected so the rendered
 * chain reflects *today's* health, not a stale snapshot.
 */
export function buildOrchestratorPrompt(
  config: ShiftRouterConfig,
  isCooldown: ((provider: string, model: string) => boolean) | undefined,
): string {
  const thinking = defaultThinkingSuffix();
  const fastChain = renderTierChain(config.tiers.fast.models, isCooldown, thinking);
  const smartChain = renderTierChain(config.tiers.smart.models, isCooldown, thinking);
  return ORCHESTRATOR_PROMPT
    .replaceAll("{{fastChain}}", fastChain)
    .replaceAll("{{smartChain}}", smartChain)
    .replaceAll("{{maxRounds}}", String(config.orchestration.maxRounds))
    .replaceAll("{{escalationThreshold}}", String(config.orchestration.escalationThreshold));
}

// ─── Orchestration lifecycle ──────────────────────────────────────

/** Fresh (inactive) orchestration state. */
export function createOrchestrationState(): OrchestrationState {
  return {
    active: false,
    rounds: 0,
    escalations: 0,
    startedAt: null,
    spend: 0,
    spawned: 0,
    done: 0,
    workerSpeeds: [],
    workerFailStreak: 0,
  };
}

/** Reset orchestration state to inactive. */
export function resetOrchestration(state: RouterState): void {
  state.orchestration = createOrchestrationState();
}

/**
 * Enter orchestration for this task. Idempotent: re-entering while already
 * active keeps the existing run (does not reset caps mid-task).
 */
export function enterOrchestration(state: RouterState): void {
  const orch = state.orchestration;
  if (!orch.active) {
    orch.active = true;
    orch.startedAt = Date.now();
    orch.rounds = 0;
    orch.escalations = 0;
    orch.spend = 0;
    orch.spawned = 0;
    orch.done = 0;
    orch.workerSpeeds = [];
    orch.workerFailStreak = 0;
  }
}

/** Exit orchestration (task complete, aborted, or cap hit). */
export function exitOrchestration(state: RouterState): void {
  state.orchestration = createOrchestrationState();
}

/**
 * Decide whether THIS turn should run as an orchestration turn.
 *
 * All conditions must hold:
 * 1. Orchestration mode "auto" (default; opt-out via `/router orchestrate
 *    off`). There is no "always" mode — orchestration is never forced on
 *    simple work.
 * 2. Router enabled.
 * 3. Judge said "smart" (complex) — simple tasks never orchestrate.
 * 4. Judge's explicit orchestration signal does not veto: `orchestrate:
 *    false` → Smart runs the turn directly. Absent (undefined) = no veto,
 *    default behavior (smart → orchestrate). `true` = explicit go.
 * 5. Smart tier model is resolvable (or requireSmartModel is false).
 * 6. pi-subagents is available (the subagent tool exists) — otherwise
 *    degrade to today's smart-tier run.
 *
 * Pure decision — no side effects. Returns true when the orchestrator
 * prompt should be injected for this turn.
 */
export function shouldOrchestrate(
  config: ShiftRouterConfig,
  judgeTier: string,
  judgeOrchestrate: boolean | undefined,
  smartModelResolvable: boolean,
  subagentToolAvailable: boolean,
): boolean {
  if (!config.enabled) return false;
  if (config.orchestration.mode !== "auto") return false;
  if (judgeTier !== "smart") return false;
  // Explicit veto from the Judge wins: judge said smart but NOT orchestratable.
  if (judgeOrchestrate === false) return false;
  if (config.orchestration.requireSmartModel && !smartModelResolvable) return false;
  if (!subagentToolAvailable) return false;
  return true;
}

/**
 * Record a worker outcome for this orchestration task and update the hard-cap
 * counters (SPEC §9.3 — hard/soft control split).
 *
 * Each subagent `tool_result` consumes one `round`. A failed worker result
 * (isError) advances the per-phase consecutive-failure streak; when the streak
 * reaches `escalationThreshold`, it is counted as an escalation (the Smart
 * agent is expected to take over the phase) and the streak resets so a fresh
 * phase starts from zero. A successful result resets the streak.
 *
 * Pure state update — no side effects. Call from the `tool_result` handler for
 * subagent tools only, and only while orchestration is active.
 */
export function recordWorkerOutcome(state: RouterState, config: ShiftRouterConfig, ok: boolean): void {
  const orch = state.orchestration;
  if (!orch.active) return;
  orch.rounds += 1;
  if (ok) {
    orch.workerFailStreak = 0;
    return;
  }
  orch.workerFailStreak += 1;
  if (orch.workerFailStreak >= config.orchestration.escalationThreshold) {
    orch.escalations += 1;
    orch.workerFailStreak = 0;
  }
}

export function capHit(state: RouterState, config: ShiftRouterConfig): boolean {
  const orch = state.orchestration;
  if (!orch.active) return false;
  if (orch.rounds >= config.orchestration.maxRounds) return true;
  if (orch.escalations >= config.orchestration.escalationThreshold) return true;
  return false;
}
