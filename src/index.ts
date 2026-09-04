/**
 * pi-shift-router — Pi-agent Extension
 *
 * Routes tasks to the optimal model based on complexity.
 * Two tiers: Fast (execution) ↔ Smart (judgment).
 * Uses sliding window trend detection with LLM Judge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { Tier, ShiftRouterConfig, RouterState, ProviderEndpoint } from "./types.js";
import { loadConfig, resolveFastEndpoints } from "./config.js";
import { findBestModelForTier, formatTierDisplay } from "./tier.js";
import { formatStatusBarLabel } from "./status-bar.js";
import { classify } from "./judge.js";
import {
  createRouterState,
  processRoute,
  applyModelSwitch,
  clearManualOverride,
  setManualOverrideTier,
  syncSessionModel,
} from "./router.js";
import {
  shouldOrchestrate,
  buildOrchestratorPrompt,
  enterOrchestration,
  exitOrchestration,
  resetOrchestration,
  recordWorkerOutcome,
  capHit,
} from "./orchestrate.js";
import { auditOrchestration, callAuditLLM, extractFinalAssistantText, extractWorkerResults } from "./audit.js";
import {
  planTurnFailover,
  markModelFailed,
  clearModelCooldown,
  isModelInCooldown,
  cooldownPredicate,
  remainingCooldownMs,
  formatRemaining,
  tokensPerSecond,
  recordSpeed,
  recordTurnThroughputFallback,
  findTierForModel,
} from "./failover.js";
import { registerCommands } from "./commands.js";

/** Check if both tiers share the same model configuration */
function allTiersIdentical(config: ShiftRouterConfig): boolean {
  const { fast, smart } = config.tiers;
  const modelsJson = (tc: typeof fast) =>
    tc.models.map((m) => `${m.provider}/${m.model}`).sort().join(",");
  return modelsJson(fast) === modelsJson(smart);
}

export default function slimRouterExtension(pi: ExtensionAPI) {
  let config: ShiftRouterConfig;
  let state: RouterState;
  let fastEndpoints: ProviderEndpoint[] = [];
  let initialized = false;
  // One-shot diagnostics flag: warn once per process when message_end arrives
  // without message_start wall-clock timing (throughput fallback engaged).
  let throughputTimingWarned = false;
  // Best-effort registry ref for the status-bar "intended model" fallback
  // (a null currentModelId shows `[🦾 model?]` instead of `[🦾 …]`).
  let statusBarRegistry: { find: (provider: string, modelId: string) => unknown } | undefined;

  // Track the ACTUAL session model for display purposes. The router only
  // updates state.current* on its own switches; user-driven changes via
  // pi's native picker (/model, Ctrl+P) or session restore arrive as
  // model_select events. Without this sync the badge shows a model that
  // is no longer running.
  pi.on("model_select", async (event, ctx) => {
    if (!initialized) await init(ctx);
    const e: any = event;
    const provider: string | undefined = e?.model?.provider;
    const modelId: string | undefined = e?.model?.id ?? e?.model?.modelId;
    if (!provider || !modelId) return;
    const tierChanged = syncSessionModel(state, config, provider, modelId);
    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter][diag] model_select (${e?.source}): ${provider}/${modelId}` +
          (tierChanged ? ` (tier -> ${state.currentTier})` : ""),
      );
    }
    if (config.ux.statusBar) updateBar(ctx.ui, config, state);
  });

  // Status-bar loading animation. `setStatus` frames are cheap and the bar
  // repaints every frame — we animate by cycling a suffix (· → ·· → ···) so
  // the user sees progress during the Judge API call and orchestration runs
  // instead of a frozen badge (which reads as "hung"). The interval is
  // per-turn; stopped on agent_end / judge-complete.
  let loadingTimer: ReturnType<typeof setInterval> | null = null;
  let loadingPhase = 0;
  const LOADING_DOTS = ["", ".", "..", "..."];

  // In-flight subagent spawn start times, keyed by toolCallId. tool_call
  // records the wall-clock start; tool_result pairs it back to compute that
  // worker's tokens/sec. Closure-local runtime bookkeeping — not part of
  // RouterState.
  const workerSpawnStarts = new Map<string, number>();

  // Turn-scoped flag: did the PRIMARY throughput path (message_start →
  // message_end wall-clock) record a reading during THIS turn? agent_end's
  // fallback needs exactly this — the old guard sniffed the session-persistent
  // recentSpeeds window and permanently disabled itself after the first
  // successful recording anywhere in the session (Bug A, v1.4.2).
  let primarySpeedRecorded = false;

  const getConfig = () => config;
  const getState = () => state;

  /** Animate the status badge suffix until stopLoading is called. */
  function startLoading(ui: any, base: string) {
    stopLoading();
    if (!config?.ux?.statusBar) return;
    loadingPhase = 0;
    ui.setStatus("shift-router", base + LOADING_DOTS[loadingPhase]);
    loadingTimer = setInterval(() => {
      loadingPhase = (loadingPhase + 1) % LOADING_DOTS.length;
      try { ui.setStatus("shift-router", base + LOADING_DOTS[loadingPhase]); } catch { /* ignore */ }
    }, 250);
  }

  /** Stop the loading animation (idempotent). */
  function stopLoading() {
    if (loadingTimer !== null) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  // ── Init ────────────────────────────────────────────────────

  async function init(ctx: { cwd: string; ui?: any }) {
    if (initialized) return;
    config = await loadConfig(ctx.cwd);
    state = createRouterState();
    fastEndpoints = await resolveFastEndpoints(config);
    initialized = true;
    // Startup banner: makes stale dist/ builds detectable at a glance.
    // pi loads dist/index.js from this working copy at process start —
    // if this version doesn't match the branch you think you're testing,
    // run `npm run build` and restart pi.
    let version = "?";
    try {
      const pkgPath = new URL("../package.json", import.meta.url);
      version = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "?";
    } catch {
      /* banner is best-effort */
    }
    console.log(`[ShiftRouter] v${version} loaded`);
  }

  // ── Status bar ──────────────────────────────────────────────

  function updateBar(ui: any, cfg: ShiftRouterConfig, s: RouterState) {
    ui.setStatus("shift-router", formatStatusBarLabel(cfg, s, statusBarRegistry));
  }

  // ── Session start ───────────────────────────────────────────
  //
  // Observe only: read config, init state, update status bar.
  // Do NOT call pi.setModel() — respect the user's default model.
  // The router only changes models during before_agent_start.

  pi.on("session_start", async (_event, ctx) => {
    await init(ctx);
    // Bug B (v1.4.2): sync the ACTUAL session model into display state. The
    // router's state starts as a guess ("fast", null) and pi's session
    // default never emits model_select, so the badge could show a model that
    // was never running. Display-only: no setModel — session_start stays
    // observe-only (SPEC contract).
    const m: any = (ctx as any).model;
    if (m?.provider && (m.id ?? m.modelId)) {
      syncSessionModel(state, config, m.provider, m.id ?? m.modelId);
    }
    // Defensive: a new session should never inherit orchestration state
    // from a previous one (e.g. after an abort that skipped agent_end).
    // Cheap no-op when inactive; refreshes the bar to a sane label.
    if (state.orchestration.active) resetOrchestration(state);
    updateBar(ctx.ui, config, state);

    // Hint when tiers are identically configured
    if (config.enabled && allTiersIdentical(config)) {
      console.warn(
        "[ShiftRouter] Both tiers share the same model. " +
        "Run '/router config' to set up tier-specific routing."
      );
    }
  });

  // ── Before each turn ────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!initialized) await init(ctx);
    statusBarRegistry = (ctx as any).modelRegistry as any;

    // Orchestration state must never survive across turns. A clean turn
    // exits it at agent_end; if it is still active here, the previous turn
    // was interrupted/aborted — and its loading timer may still be painting
    // a frozen planning frame every 250ms, overriding every updateBar.
    // Sweep both so the bar always shows the live state for THIS turn.
    // Runs before the enabled/prompt early return: a leaked frame must not
    // survive even into a disabled or empty turn.
    if (state.orchestration.active) {
      stopLoading();
      resetOrchestration(state);
      if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    }

    // New turn → the primary throughput path has recorded nothing yet.
    primarySpeedRecorded = false;

    if (!config?.enabled || !event.prompt?.trim()) return;

    const tDiag = Date.now();
    const verbose = config.ux.routerLogVerbose;
    const promptPreview = event.prompt.slice(0, 80).replace(/\n/g, " ");
    if (verbose) {
      console.log(`\n[ShiftRouter] ─── Turn start ───`);
      console.log(`[ShiftRouter] prompt: "${promptPreview}${event.prompt.length > 80 ? "…" : ""}"`);
      console.log(`[ShiftRouter] current: ${formatTierDisplay(state.currentTier, state.currentModelId)}`);
      console.log(`[ShiftRouter][diag] before_agent_start entered @${tDiag}`);
      console.log(`[ShiftRouter][diag] systemPrompt base: ${(event as any).systemPrompt?.length ?? "?"} chars`);
    }

    // Restore the working indicator flag. pi's `agent_start` only shows the
    // spinner when `workingVisible` is true (interactive-mode.js ~L2501); our
    // defensive clear in `agent_end` sets it false, and without restoring it
    // here every later turn would silently skip the spinner. Clearing then
    // re-setting also sweeps away any spinner frame that survived an aborted
    // `agent_end` delivery.
    try {
      ctx.ui.setWorkingVisible(false);
      ctx.ui.setWorkingVisible(true);
    } catch { /* ignore */ }

    // Animate a "judging…" badge in the status bar so the user sees the
    // router working during the Judge API call (static text reads as hung).
    if (config.ux.statusBar) startLoading(ctx.ui, "🧭 judging");

    let judgeResult;
    try {
      judgeResult = await classify(
        event.prompt,
        fastEndpoints,
        config.routing.judgeTimeout,
        verbose,
        cooldownPredicate(state.modelCooldowns, Date.now()),
        // Judge-side failure → mark the model into the shared cooldown map so
        // (a) the next judge call skips it without re-burning a 429, and
        // (b) the turn-path (`findBestModelForTier`) also avoids it.
        // Mirrors SPEC §8.5: only failover signatures cool down; classify's
        // own policy already excludes network/timeout/unparseable failures.
        (provider, model, code) => markModelFailed(state.modelCooldowns, provider, model, Date.now(), code),
      );
    } finally {
      // Restore the proper status badge immediately, regardless of judge outcome.
      stopLoading();
      updateBar(ctx.ui, config, state);
    }

    if (verbose) {
      const ratio = state.window.length === 0
        ? "0/0"
        : `${state.window.filter((e) => e.tier === "fast").length}/${state.window.length}`;
      console.log(
        `[ShiftRouter] judge: ${judgeResult.tier} (${judgeResult.source})` +
          (judgeResult.confidence !== undefined ? ` conf=${judgeResult.confidence.toFixed(2)}` : "") +
          (judgeResult.reason !== undefined ? ` reason=${judgeResult.reason}` : "") +
          `, window=[${state.window.map((e) => e.tier[0]).join("")}] (${ratio} fast)`,
      );
    }

    // Explicit orchestration intent override (no new command): if the user
    // explicitly asks for orchestration (e.g. "编排" / "orchestrat*" /
    // "delegate"), force smart + orchestrate:true regardless of what the
    // Judge said. Judge's `orchestrate` rule is soft (prompt-only); this is
    // the hard gate so explicit intent never gets blocked by a `fast` verdict.
    const EXPLICIT_ORCH_RE = /(编排|并行调研|并行对比|拆成.*子任务|派发|子代理|orchestrat|delegate\s+to\s+subagents?|fan[ -]?out|spawn\s+workers?)/i;
    const wantsExplicitOrch = EXPLICIT_ORCH_RE.test(event.prompt ?? "");
    if (wantsExplicitOrch && config.orchestration.mode === "auto" && config.enabled) {
      if (judgeResult.tier !== "smart" || judgeResult.orchestrate !== true) {
        if (verbose) console.log(`[ShiftRouter] explicit orchestration intent detected → forcing smart + orchestrate:true (was ${judgeResult.tier}/${String(judgeResult.orchestrate)})`);
        judgeResult = { ...judgeResult, tier: "smart" as const, orchestrate: true };
      }
    }

    const result = processRoute(judgeResult, state, config, ctx.modelRegistry as any);

    if (verbose) {
      console.log(`[ShiftRouter][diag] before_agent_start classify done in ${Date.now() - tDiag}ms`);
      console.log(`[ShiftRouter] decision: ${result.action}${result.switchTo ? ` → ${result.switchTo.provider}/${result.switchTo.modelId}` : ""}`);
    }

    // ── Task-level orchestration (SPEC §9.3) ──────────────────────
    // Judge said "smart" (or explicit override above) + orchestration mode
    // auto + smart model resolvable + subagent tool available → inject the
    // orchestrator instruction. The Smart main agent then plans/delegates/
    // reviews itself.
    //
    // Backward-compat: all conditions gated by config.orchestration.mode
    // (auto by default since v1.1.0; "off" disables entirely). Explicit
    // orchestration intent above bypasses the Judge tier gate, so
    // "use orchestration to research" no longer gets stuck on `fast`.
    const smartResolvable =
      (() => {
        try {
          return findBestModelForTier(
            "smart",
            config,
            ctx.modelRegistry as any,
            cooldownPredicate(state.modelCooldowns, Date.now()),
          ) != null;
        } catch {
          return false;
        }
      })();
    const subagentAvailable = (() => {
      try {
        // ExtensionAPI exposes configured tools via getAllTools/getActiveTools
        // (pi.tools is an internal Map on the Extension object, NOT on the
        // ExtensionAPI — dot-access on it was always undefined, which silently
        // disabled orchestration). pi-subagents registers the `subagent` tool
        // via pi.registerTool, so it shows up in both lists.
        const api = pi as any;
        const all: { name?: string }[] = typeof api.getAllTools === "function" ? api.getAllTools() : [];
        if (Array.isArray(all) && all.some((t) => t?.name === "subagent")) return true;
        const active: string[] = typeof api.getActiveTools === "function" ? api.getActiveTools() : [];
        return Array.isArray(active) && active.includes("subagent");
      } catch {
        return false;
      }
    })();
    // Manual override means the user explicitly forced plain routing for
    // this turn — never inject the orchestrator prompt or enter the
    // orchestration state. Without this guard, a `/router smart` + complex
    // task would enter orchestration and then agent_end's manualOverride
    // guard would skip the failover path while orchestration state (and its
    // status-bar label) lingered.
    const orchestrationAllowed = !state.manualOverride.active;
    let orchestratorSystemPrompt: string | undefined;
    try {
      if (
        orchestrationAllowed &&
        shouldOrchestrate(config, judgeResult.tier, judgeResult.orchestrate, smartResolvable, subagentAvailable)
      ) {
        enterOrchestration(state);
        // Snapshot the user's original goal for the post-turn acceptance
        // audit (goal-alignment check — see SPEC §9.3 audit).
        state.orchestration.goal = event.prompt ?? null;
        const orchPrompt = buildOrchestratorPrompt(config, cooldownPredicate(state.modelCooldowns, Date.now()));
        if (config.ux.routerLogVerbose) {
          console.log(
            `[ShiftRouter] 🪄 orchestrating: judge=${judgeResult.tier}` +
              (judgeResult.orchestrate !== undefined ? ` orchestrate=${judgeResult.orchestrate}` : "") +
              `, injecting orchestrator prompt (${orchPrompt.length} chars)`,
          );
        }
        // Animate the status badge while the Smart agent plans/delegates.
        // Base = current label (tier badge + tok/s + 🪄 pending marker), so
        // throughput telemetry stays visible during long planning phases;
        // tool_call paints the live worker count once workers spawn and
        // stopLoading() freezes on the last frame.
        if (config.ux.statusBar) {
          const animBase = formatStatusBarLabel(config, state, statusBarRegistry) ?? "🪄 orchestrating";
          startLoading(ctx.ui, animBase);
        }
        // Inject the orchestrator instruction into this turn's system prompt
        // by returning it — pi's before_agent_start handler chain reads
        // `result.systemPrompt` from the handler return value (NOT
        // `event.systemPrompt`), so we must use this contract. Earlier
        // versions mutated `event.systemPrompt` in place, which was dead
        // code: the mutation never reached the LLM.
        const baseSystemPrompt = (event as any).systemPrompt;
        if (typeof baseSystemPrompt !== "string") {
          // No system prompt at all (shouldn't happen — BeforeAgentStartEvent
          // types it as string). Fallback: inject as a hidden custom message
          // so the instruction still reaches the LLM this turn.
          return {
            message: {
              customType: "shift-router-orchestrator",
              content: orchPrompt,
              display: false,
            },
          };
        }
        const chainedSystemPrompt = baseSystemPrompt + "\n\n" + orchPrompt;
        if (config.ux.routerLogVerbose) {
          console.log(
            `[ShiftRouter] 🪄 system prompt chained: ${baseSystemPrompt.length} → ${chainedSystemPrompt.length} chars (+${orchPrompt.length} orchestrator)`,
          );
        }
        // Defer the handler return to the end of this function so the
        // model-switch logic below still runs on orchestration turns (the
        // Judge said "smart" — switchTo points at the smart chain, and
        // returning early here would leave the previous turn's model active,
        // potentially a Fast model running the CTO loop).
        orchestratorSystemPrompt = chainedSystemPrompt;
      }

      if (result.switchTo) {
        const ok = await applyModelSwitch(
          result.switchTo, state,
          ctx.modelRegistry as any,
          (m) => pi.setModel(m as any),
        );
        if (verbose) console.log(`[ShiftRouter] model switch ${ok ? "ok" : "FAILED"}`);
        if (ok && !config.ux.quietMode && config.ux.inlineToast) {
          ctx.ui.notify(`${formatTierDisplay(state.currentTier, state.currentModelId)}`, "info");
        }
      }
    } catch (err) {
      // Error containment: if anything after the Judge call throws
      // (processRoute / prompt build / model switch), the turn would die
      // before agent_end ever fires — leaving the dots animation spinning
      // and state.orchestration.active stuck true (status bar frozen on
      // "🪄 orchestrating…"). Clean up here and let the turn proceed on the
      // current model; per AGENTS.md errors are logged, never crash host.
      console.error("[ShiftRouter] before_agent_start error — recovering:", err);
      stopLoading();
      if (state.orchestration.active) exitOrchestration(state);
      if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    }

    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter][diag] before_agent_start end: systemPrompt=${(event as any).systemPrompt?.length ?? "?"} chars, current=${formatTierDisplay(state.currentTier, state.currentModelId)}`,
      );
    }

    updateBar(ctx.ui, config, state);
    if (state.manualOverride.active) clearManualOverride(state);

    // Deliver the orchestrator system prompt via the handler RESULT — pi's
    // before_agent_start chain reads `result.systemPrompt` from the return
    // value, NOT `event.systemPrompt` (in-place mutation is dead code).
    if (orchestratorSystemPrompt !== undefined) {
      return { systemPrompt: orchestratorSystemPrompt };
    }
  });

  // ── Runtime failover (SPEC §8.5) ──────────────────────────────
  //
  // agent_end: if the turn failed with a failover signature, mark the
  // model into exponential-backoff cooldown and immediately setModel to
  // the next healthy model in the same tier. pi's pending
  // agent.continue() retry then runs with the fallback model.

  pi.on("agent_end", async (event, ctx) => {
    const tEnd0 = Date.now();
    if (config.ux.routerLogVerbose) {
      console.log(`[ShiftRouter][diag] agent_end handler ENTER @${tEnd0}`);
    }
    // Defensive: explicitly clear the working spinner. If anything in this
    // handler (or pi's own agent_end → UI emit chain) hangs and prevents
    // the UI from clearing it, this guarantees it goes away.
    try { ctx.ui.setWorkingVisible(false); } catch { /* ignore */ }
    if (!initialized) await init(ctx);

    // ── Orchestration lifecycle (SPEC §9.3) ────────────────────
    // MVP is single-turn orchestration: the Smart turn that got the
    // orchestrator prompt is the whole loop (plan + delegate + review inside
    // that turn). On agent_end that turn is done → exit orchestration so the
    // next turn routes normally.
    //
    // MUST run BEFORE any early return (enabled / manualOverride): those
    // guards are about failover policy, not about orchestration state. If we
    // returned early with an active orchestration, the status bar would stay
    // stuck on "🪄 orchestrating…" until the next successful exit path.
    // (Placed also before the `!plan` early return below so a healthy
    // orchestration turn still releases its state. Cross-turn lifecycle is
    // Phase 3.)
    if (state.orchestration.active) {
      stopLoading();
      const o = state.orchestration;
      if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter] 🪄 orchestration turn ended — exited orchestrator state ` +
            `(workers ${o.done}/${o.spawned}, spend $${o.spend.toFixed(4)})`,
        );
      }
      // ── Acceptance audit (SPEC §9.3 托底 review) ─────────────────
      // Hard fallback after the CTO turn: verify the loop actually closed —
      // workers reported back, a CTO summary exists, acceptance is grounded.
      // Deterministic checks always run; the LLM pass (small fast-tier call)
      // runs when enabled. Best-effort: never blocks agent_end, never throws.
      const messages = (event as any).messages ?? [];
      const auditEnabled = config.orchestration.audit?.enabled ?? true;
      const auditTimeout = config.orchestration.audit?.timeoutMs ?? 5000;
      const verboseAudit = config.ux.routerLogVerbose;
      try {
        const audit = await auditOrchestration({
          spawned: o.spawned,
          done: o.done,
          rounds: o.rounds,
          escalations: o.escalations,
          maxRounds: config.orchestration.maxRounds,
          escalationThreshold: config.orchestration.escalationThreshold,
          messages,
          enabled: auditEnabled,
          goal: o.goal ?? undefined,
          ctoSummary: extractFinalAssistantText(messages),
          workerResults: extractWorkerResults(messages),
          endpoints: fastEndpoints,
          timeoutMs: auditTimeout,
          verbose: verboseAudit,
          llmCall: callAuditLLM,
        });
        state.lastAudit = audit;
        if (audit.violations.length > 0) {
          // Diagnosability over silence: ungrounded acceptance is exactly the
          // case the user must see. console.warn is not gated by verbose.
          console.warn(
            `[ShiftRouter] ⛔ orchestration audit flagged ${audit.violations.length} issue(s): ${audit.violations.join(" | ")}`,
          );
          if (!config.ux.quietMode && config.ux.inlineToast) {
            ctx.ui.notify(`pi-shift-router: ⛔ audit: ${audit.violations[0]}`, "warning");
          }
        } else if (verboseAudit) {
          console.log(`[ShiftRouter] ✓ orchestration audit passed (workers ${o.done}/${o.spawned})`);
        }
      } catch (auditErr) {
        // Errors are values: a broken audit must never crash agent_end.
        console.warn(`[ShiftRouter] orchestration audit failed: ${auditErr}`);
      }
      exitOrchestration(state);
      // Refresh the status bar: the previous frame may have shown
      // "🪄 orchestrating…" or "🪄 X/Y workers", but state.orchestration
      // is now inactive. Without this refresh the stale label persists
      // until the next event that calls updateBar (next turn, etc.).
      if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    }

    if (!config?.enabled) return;
    if (state.manualOverride.active) return; // user forced a model — don't override

    const t0 = Date.now();
    statusBarRegistry = (ctx as any).modelRegistry as any;
    // Throughput fallback: message_start may never fire with a usable role
    // for some providers, so streamingStartTime stays null and recentSpeeds
    // stays empty (no "• N tok/s" in the bar). agent_end always has the
    // full messages — derive speed from timestamps + usage when needed, and
    // REPAINT the bar: recording alone leaves the stale no-speed label up.
    let throughputRecorded = false;
    try {
      throughputRecorded = recordTurnThroughputFallback((event as any).messages ?? [], state, primarySpeedRecorded);
    } catch (fallbackErr) {
      console.warn(`[ShiftRouter] throughput fallback failed: ${fallbackErr}`);
    }
    const msgCount = (event as any).messages?.length ?? 0;
    const plan = planTurnFailover(
      (event as any).messages ?? [],
      state,
      config,
      (ctx as any).modelRegistry as any,
      t0,
    );
    if (config.ux.routerLogVerbose) {
      console.log(`[ShiftRouter][diag] agent_end entered: messages=${msgCount} plan=${plan ? "failover" : "none"} elapsed=${Date.now() - t0}ms`);
      // Dump a compact shape of every message so the next-turn API 400
      // ("role 'tool' without preceding tool_calls") can be traced to a
      // specific message in agent.state.messages. Each message is wrapped in
      // try/catch so a single malformed entry cannot hide the rest.
      // Format: idx | role | stopReason? | toolCallId? | toolUseIds? |
      //         contentKind | contentPreview (truncated).
      // Only dump when a failover actually happened — no need to spam per-turn logs.
      if (plan) {
      const msgs = (event as any).messages ?? [];
      for (let i = 0; i < msgs.length; i++) {
        const m: any = msgs[i];
        try {
          const role = m.role ?? "(no role)";
          const stop = m.stopReason ? ` stop=${m.stopReason}` : "";
          const tcid = m.toolCallId ? ` tcid=${m.toolCallId}` : "";
          let kind = "";
          let preview = "";
          if (Array.isArray(m.content)) {
            const types = m.content
              .map((b: any) => b?.type ?? "?")
              .filter((x: string, idx: number, arr: string[]) => arr.indexOf(x) === idx);
            kind = ` kinds=[${types.join(",")}]`;
            // First 60 chars of first text block as a preview.
            const firstText = m.content.find((b: any) => b?.type === "text");
            if (firstText?.text) {
              preview = ` text="${String(firstText.text).slice(0, 60).replace(/\n/g, " ")}${firstText.text.length > 60 ? "…" : ""}"`;
            }
          } else if (typeof m.content === "string") {
            kind = ` str.len=${m.content.length}`;
            preview = ` text="${m.content.slice(0, 60).replace(/\n/g, " ")}${m.content.length > 60 ? "…" : ""}"`;
          } else if (m.content === undefined || m.content === null) {
            kind = ` content=(${m.content === null ? "null" : "undefined"})`;
          } else {
            kind = ` content.type=${typeof m.content}`;
          }
          let toolUseIds = "";
          if (role === "assistant" && Array.isArray(m.content)) {
            const ids = m.content
              .filter((b: any) => b?.type === "toolCall")
              .map((b: any) => b.id)
              .filter(Boolean);
            if (ids.length > 0) toolUseIds = ` toolUse=[${ids.join(",")}]`;
          }
          // Provider/model info (helps confirm api=openai-completions vs
          // anthropic-messages for the failure case).
          const provider = m.provider ? ` provider=${m.provider}` : "";
          const api = m.api ? ` api=${m.api}` : "";
          console.log(
            `[ShiftRouter][diag]   msg[${i}] role=${role}${stop}${tcid}${provider}${api}${kind}${toolUseIds}${preview}`,
          );
        } catch (dumpErr) {
          console.log(
            `[ShiftRouter][diag]   msg[${i}] <dump failed: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)}> keys=${m && typeof m === "object" ? Object.keys(m).join(",") : "?"}`,
          );
        }
      }


      }
    }


    if (!plan) {
      // Healthy turn (or non-failover error). Repaint so a speed recorded by
      // the agent_end fallback actually reaches the bar — message_end may
      // have painted without one (empty recentSpeeds / no wall-clock timing).
      if (throughputRecorded && config.ux.statusBar) updateBar(ctx.ui, config, state);
      if (config.ux.routerLogVerbose) {
        console.log(`[ShiftRouter][diag] agent_end exiting (no failover) @${Date.now()} total=${Date.now() - tEnd0}ms`);
      }
      return; // healthy turn or non-failover error
    }

    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter] ⚠ ${plan.failed.provider}/${plan.failed.model} failed (${plan.failed.code}) → cooldown ${formatRemaining(remainingFor(state, plan.failed.provider, plan.failed.model))}`,
      );
    }
    // Diagnosability: a failed failover is otherwise easy to miss when
    // pi's own same-model retries keep producing identical errors. Warn
    // unconditionally (console.warn is not gated by inlineToast).
    if (!plan.switched || !plan.fallback) {
      const failTier = findTierForModel(config, plan.failed.provider, plan.failed.model) ?? state.currentTier;
      console.warn(
        `[ShiftRouter] ⚠ failover unavailable: ${plan.failed.provider}/${plan.failed.model} failed (${plan.failed.code}); no healthy ${failTier}-tier candidate (cooldown/exhausted). Keeping current model. Cross-tier switching is disabled by principle.`,
      );
    }

    if (plan.switched && plan.fallback) {
      const ok = await applyModelSwitch(
        plan.fallback, state,
        (ctx as any).modelRegistry as any,
        (m) => pi.setModel(m as any),
      );
      if (ok && !config.ux.quietMode && config.ux.inlineToast) {
        const retry = formatRemaining(remainingFor(state, plan.failed.provider, plan.failed.model));
        ctx.ui.notify(
          `⚠️ ${shortModel(plan.failed.provider, plan.failed.model)} unavailable (${plan.failed.code}), ` +
          `switching to ${shortModel(plan.fallback.provider, plan.fallback.modelId)} — retry in ${retry}`,
          "warning",
        );
      }
    } else if (!config.ux.quietMode && config.ux.inlineToast) {
      ctx.ui.notify(
        `⚠️ ${shortModel(plan.failed.provider, plan.failed.model)} unavailable (${plan.failed.code}) — ` +
        `all ${plan.failed.provider} models in cooldown, keeping current`,
        "warning",
      );
    }
  });
  // clear its cooldown immediately (SPEC §8.5.2(4) recovery).

  pi.on("agent_settled", async () => {
    if (config.ux.routerLogVerbose) {
      console.log(`[ShiftRouter][diag] agent_settled handler @${Date.now()}`);
    }
  });

  // ── Orchestration observability (SPEC §9.3) ────────────────────
  // Count subagent spawns/completions so the status bar can show live
  // progress (`🪄 2/5 workers`) and agent_end can report the run summary.
  // Works whether the subagent tool comes from pi-subagents or anywhere
  // else — we only watch the tool name.

  pi.on("tool_call", async (event, ctx) => {
    if (!initialized) await init(ctx);
    if (!config?.enabled) return;
    const e: any = event;
    if (e?.toolName !== "subagent") return;
    if (!state.orchestration.active) {
      if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter][diag] subagent tool_call but orchestration INACTIVE (active=false, spawned=${state.orchestration.spawned}) — skipping count; ui stays on tier badge`,
        );
      }
      return;
    }
    // Hard cap (SPEC §9.3): once maxRounds or escalationThreshold is reached,
    // physically refuse new worker spawns — the plugin's cap is not a prompt
    // suggestion, it is a block. The Smart agent sees the blocked call and
    // must take over the phase / wrap up.
    if (capHit(state, config)) {
      if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter] ⛔ cap hit (rounds=${state.orchestration.rounds}/${config.orchestration.maxRounds}, escalations=${state.orchestration.escalations}/${config.orchestration.escalationThreshold}) — blocking new subagent spawn`,
        );
      }
      return {
        block: true,
        reason: `orchestration cap reached (max ${config.orchestration.maxRounds} rounds, ${config.orchestration.escalationThreshold} escalations) — take over the phase yourself and wrap up`,
      };
    }
    state.orchestration.spawned += 1;
    // Pair with the matching tool_result to compute this worker's tok/s.
    if (typeof e?.toolCallId === "string") {
      workerSpawnStarts.set(e.toolCallId, Date.now());
    }
    // Stop the "orchestrating…" dots once real workers are in flight —
    // show the live count instead (static, no interval to fight the bar).
    stopLoading();
    if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter][diag] subagent tool_call #${state.orchestration.spawned}: spawned=${state.orchestration.spawned}, active=${state.orchestration.active} → updateBar`,
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!initialized) await init(ctx);
    if (!config?.enabled) return;
    const e: any = event;
    if (e?.toolName !== "subagent") return;
    if (!state.orchestration.active) return;
    // Hard-cap accounting (SPEC §9.3): every subagent result consumes a round;
    // an errored result advances the escalation streak. isError is pi's
    // standard field on tool_result events (see extensions docs).
    recordWorkerOutcome(state, config, e?.isError !== true);
    state.orchestration.done += 1;
    // Per-worker throughput: pair toolCallId back to its spawn time and
    // compute tokens/sec from usage.output. The bar shows the AVERAGE of
    // these readings, stable under concurrent completions.
    const spawnStart = typeof e?.toolCallId === "string" ? workerSpawnStarts.get(e.toolCallId) : undefined;
    if (spawnStart !== undefined) workerSpawnStarts.delete(e.toolCallId);
    const outputTokens: number = e?.usage?.output ?? 0;
    if (spawnStart !== undefined && outputTokens > 0) {
      const elapsed = Date.now() - spawnStart;
      const tps = tokensPerSecond(outputTokens, elapsed);
      if (tps > 0) state.orchestration.workerSpeeds.push(tps);
    }
    // Cost attribution (Phase 2): pi-subagents reports the subagent's usage
    // on the tool result. Fold it into the orchestration spend so agent_end
    // and (later) /router stats can show what delegation cost.
    const usage = e?.usage;
    const cost = usage?.cost?.total ?? 0;
    if (cost > 0) state.orchestration.spend += cost;
    if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter][diag] subagent tool_result: done=${state.orchestration.done}/${state.orchestration.spawned}, active=${state.orchestration.active}, cost=$${cost.toFixed(4)} → updateBar`,
      );
    }
  });

  pi.on("turn_end", async (event) => {
    if (config.ux.routerLogVerbose) {
      const msg: any = (event as any).message;
      console.log(`[ShiftRouter][diag] turn_end handler @${Date.now()} role=${msg?.role} stop=${msg?.stopReason ?? ""} err=${msg?.errorMessage ?? ""}`);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!initialized) await init(ctx);
    if (!config?.enabled) return;
    if (event.status >= 200 && event.status < 300 && state.currentProvider && state.currentModelId) {
      if (isModelInCooldown(state.modelCooldowns, state.currentProvider, state.currentModelId, Date.now())) {
        clearModelCooldown(state.modelCooldowns, state.currentProvider, state.currentModelId);
        if (config.ux.routerLogVerbose) {
          console.log(
            `[ShiftRouter] ✓ ${state.currentProvider}/${state.currentModelId} recovered (HTTP ${event.status}) — cooldown cleared`,
          );
        }
      }
    }
  });

  // Track token throughput. message_start records when streaming began;
  // message_end computes tokens/sec from elapsed time and usage.output.

  pi.on("message_start", async (_event, ctx) => {
    if (!initialized) await init(ctx);
    const msg: any = (_event as any).message;
    // Use Date.now() rather than msg.timestamp because at stream-start the
    // timestamp field may not yet be populated on the partial message.
    if (msg?.role === "assistant") {
      state.streamingStartTime = Date.now();
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!initialized) await init(ctx);
    const msg: any = (event as any).message;
    if (!msg || msg.role !== "assistant") return;

    // Display-only model sync (Bug B, v1.4.2): keep the badge on the ACTUAL
    // running model even when the divergence source is not a model_select
    // event (session default, provider-level switch). Idempotent — the
    // router's own applyModelSwitch already set these same values before the
    // message streamed; routing decisions are untouched.
    const msgModel: string | undefined = msg.model ?? msg.modelId;
    if (msg.provider && msgModel &&
        (msg.provider !== state.currentProvider || msgModel !== state.currentModelId)) {
      syncSessionModel(state, config, msg.provider, msgModel);
      if (config.ux.statusBar) updateBar(ctx.ui, config, state);
    }

    const usage = msg.usage;
    const outputTokens: number = usage?.output ?? 0;
    state.totalOutputTokens += outputTokens;
    // Cache-aware routing (SPEC §9.2): record the last activity so the
    // session-boundary gate knows whether the prompt cache is still warm.
    state.lastActivityAt = Date.now();

    // ── Throughput FIRST ──────────────────────────────────────────
    // The status bar's "• N tok/s" must never be starved by a fault in the
    // cost-telemetry block below (a throw there previously skipped the speed
    // record entirely — leaving fast turns without an indicator while smart
    // turns kept theirs, depending on which message shape tripped it).
    const startTime = state.streamingStartTime;
    if (startTime !== null && outputTokens > 0) {
      const elapsed = Date.now() - startTime;
      const tps = tokensPerSecond(outputTokens, elapsed);
      if (tps > 0) {
        recordSpeed(state.recentSpeeds, tps);
        primarySpeedRecorded = true; // turn-scoped: gates the agent_end fallback
        if (config.ux.routerLogVerbose) {
          console.log(
            `[ShiftRouter] ${outputTokens} tokens in ${elapsed}ms = ${tps} tok/s (total ${state.totalOutputTokens.toLocaleString()})`,
          );
        }
      } else if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter] message_end: tokens=${outputTokens} elapsed=${elapsed}ms startTime=${startTime} msgTs=${msg.timestamp}`,
        );
      }
    } else if (outputTokens > 0 && startTime === null && !throughputTimingWarned) {
      // Primary wall-clock path unavailable (message_start never delivered a
      // usable assistant timing). One warn per process; the agent_end
      // timestamp fallback covers the indicator.
      throughputTimingWarned = true;
      console.warn(
        `[ShiftRouter] throughput: message_end without message_start timing (output=${outputTokens}) — status bar relies on the agent_end timestamp fallback`,
      );
    } else if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter] message_end: tokens=${outputTokens} startTime=${startTime} usage=${usage ? JSON.stringify(usage) : "undefined"}`,
      );
    }

    // ── Cost telemetry (SPEC §9 "Cost telemetry — deep view") ────────
    // Attribute this message's tokens + cost to whichever tier was active
    // when it ran (`state.currentTier` reflects the model picked during
    // `before_agent_start`).
    const tokens = {
      input: usage?.input ?? 0,
      output: outputTokens,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
    };
    const messageCost = usage?.cost?.total ?? 0;
    const tierUsage = state.tierUsage[state.currentTier];
    tierUsage.calls += 1;
    tierUsage.tokens.input += tokens.input;
    tierUsage.tokens.output += tokens.output;
    tierUsage.tokens.cacheRead += tokens.cacheRead;
    tierUsage.tokens.cacheWrite += tokens.cacheWrite;
    tierUsage.cost += messageCost;
    state.callLog.push({
      tier: state.currentTier,
      provider: state.currentProvider ?? "?",
      modelId: state.currentModelId ?? "?",
      tokens,
      cost: messageCost,
    });

    // Always reset start time and refresh status bar — guarantees the bar
    // updates even when output_tokens=0 (reasoning-only models, free providers,
    // etc.).
    state.streamingStartTime = null;
    updateBar(ctx.ui, config, state);
    if (config.ux.routerLogVerbose) {
      console.log(`[ShiftRouter][diag] message_end handler done (role=assistant)`);
    }
  });

  // ── Commands ────────────────────────────────────────────────

  registerCommands(
    pi,
    getConfig,
    getState,
    async () => {
      const { loadConfig: reloadConfig, invalidateConfigCache: clearCache } =
        await import("./config.js");
      clearCache();
      try {
        config = await reloadConfig(process.cwd());
      } catch {
        /* keep old config on reload failure */
      }
      fastEndpoints = await resolveFastEndpoints(config);
      state.window = [];
      state.modelCooldowns.clear();
      state.tierUsage.fast = { calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
      state.tierUsage.smart = { calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
      state.callLog = [];
      clearManualOverride(state);
      resetOrchestration(state);
    },
    (tier: Tier) => setManualOverrideTier(state, tier),
    (ui: any) => updateBar(ui, config, state),
  );
}

// ── Display helpers ────────────────────────────────────────────────

/** Short model name: "minimax/MiniMax-M3" → "MiniMax-M3". */
function shortModel(_provider: string, model: string): string {
  return model.split("/").pop() ?? model;
}

/** Remaining cooldown for a model from the state map. */
function remainingFor(
  state: RouterState,
  provider: string,
  model: string,
): number {
  return remainingCooldownMs(state.modelCooldowns, provider, model, Date.now());
}
