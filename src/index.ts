/**
 * pi-shift-router — Pi-agent Extension
 *
 * Routes tasks to the optimal model based on complexity.
 * Two tiers: Fast (execution) ↔ Smart (judgment).
 * Uses sliding window trend detection with LLM Judge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tier, ShiftRouterConfig, RouterState, ProviderEndpoint } from "./types.js";
import { loadConfig, resolveFastEndpoints } from "./config.js";
import { findBestModelForTier, formatTierDisplay, formatTierDisplayWithSpeed } from "./tier.js";
import { classify } from "./judge.js";
import {
  createRouterState,
  processRoute,
  applyModelSwitch,
  clearManualOverride,
  setManualOverrideTier,
} from "./router.js";
import {
  shouldOrchestrate,
  buildOrchestratorPrompt,
  enterOrchestration,
  exitOrchestration,
  resetOrchestration,
} from "./orchestrate.js";
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

  // Status-bar loading animation. `setStatus` frames are cheap and the bar
  // repaints every frame — we animate by cycling a suffix (· → ·· → ···) so
  // the user sees progress during the Judge API call and orchestration runs
  // instead of a frozen badge (which reads as "hung"). The interval is
  // per-turn; stopped on agent_end / judge-complete.
  let loadingTimer: ReturnType<typeof setInterval> | null = null;
  let loadingPhase = 0;
  const LOADING_DOTS = ["", ".", "..", "..."];

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
  }

  // ── Status bar ──────────────────────────────────────────────

  function updateBar(ui: any, cfg: ShiftRouterConfig, s: RouterState) {
    if (!cfg.ux.statusBar) { ui.setStatus("shift-router", undefined); return; }
    if (s.orchestration.active) {
      // Orchestration runs on the Smart tier — show what the CTO is doing:
      // how many Fast subagents spawned / completed so far.
      const o = s.orchestration;
      const label = o.spawned === 0
        ? "🪄 orchestrating"
        : `🪄 ${o.done}/${o.spawned} workers`;
      ui.setStatus("shift-router", label);
      return;
    }
    const speed = s.recentSpeeds.length > 0 ? s.recentSpeeds[s.recentSpeeds.length - 1] : 0;
    const badge = cfg.enabled
      ? formatTierDisplayWithSpeed(s.currentTier, s.currentModelId, speed)
      : "⛔";
    ui.setStatus("shift-router", badge);
  }

  // ── Session start ───────────────────────────────────────────
  //
  // Observe only: read config, init state, update status bar.
  // Do NOT call pi.setModel() — respect the user's default model.
  // The router only changes models during before_agent_start.

  pi.on("session_start", async (_event, ctx) => {
    await init(ctx);
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

    const result = processRoute(judgeResult, state, config, ctx.modelRegistry as any);

    if (verbose) {
      console.log(`[ShiftRouter][diag] before_agent_start classify done in ${Date.now() - tDiag}ms`);
      console.log(`[ShiftRouter] decision: ${result.action}${result.switchTo ? ` → ${result.switchTo.provider}/${result.switchTo.modelId}` : ""}`);
    }

    // ── Task-level orchestration (SPEC §9.3) ──────────────────────
    // Judge said "smart" + orchestration mode auto + smart model resolvable +
    // subagent tool available → inject the orchestrator instruction.
    // The Smart main agent then plans/delegates/reviews itself.
    //
    // Backward-compat: all conditions gated by config.orchestration.mode
    // (default "off"); with it off this block is inert.
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
    if (shouldOrchestrate(config, judgeResult.tier, judgeResult.orchestrate, smartResolvable, subagentAvailable)) {
      enterOrchestration(state);
      const orchPrompt = buildOrchestratorPrompt(config, cooldownPredicate(state.modelCooldowns, Date.now()));
      if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter] 🪄 orchestrating: judge=${judgeResult.tier}` +
            (judgeResult.orchestrate !== undefined ? ` orchestrate=${judgeResult.orchestrate}` : "") +
            `, injecting orchestrator prompt (${orchPrompt.length} chars)`,
        );
      }
      // Animate the orchestration badge in the status bar while the Smart
      // agent plans/delegates. updateBar() paints the live worker count;
      // the dots animation keeps it visibly alive between spawn events.
      if (config.ux.statusBar) startLoading(ctx.ui, "🪄 orchestrating");
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
      return { systemPrompt: chainedSystemPrompt };
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
    } else if (!state.currentModelId && state.currentTier) {
      // First turn with no model yet — resolve one for current tier,
      // skipping models in cooldown.
      const m = findBestModelForTier(state.currentTier, config, ctx.modelRegistry as any, cooldownPredicate(state.modelCooldowns, Date.now()));
      if (m) {
        await applyModelSwitch(m, state, ctx.modelRegistry as any, (model) => pi.setModel(model as any));
      }
    }

    if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter][diag] before_agent_start end: systemPrompt=${(event as any).systemPrompt?.length ?? "?"} chars, current=${formatTierDisplay(state.currentTier, state.currentModelId)}`,
      );
    }

    updateBar(ctx.ui, config, state);
    if (state.manualOverride.active) clearManualOverride(state);
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
    if (!config?.enabled) return;
    if (state.manualOverride.active) return; // user forced a model — don't override

    const t0 = Date.now();
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

    // ── Orchestration lifecycle (SPEC §9.3) ────────────────────────
    // MVP is single-turn orchestration: the Smart turn that got the
    // orchestrator prompt is the whole loop (plan + delegate + review inside
    // that turn). On agent_end that turn is done → exit orchestration so the
    // next turn routes normally. Placed BEFORE the `!plan` early return so a
    // healthy orchestration turn still releases its state. (Cross-turn
    // lifecycle is Phase 3.)
    if (state.orchestration.active) {
      stopLoading();
      const o = state.orchestration;
      if (config.ux.routerLogVerbose) {
        console.log(
          `[ShiftRouter] 🪄 orchestration turn ended — exited orchestrator state ` +
            `(workers ${o.done}/${o.spawned}, spend $${o.spend.toFixed(4)})`,
        );
      }
      exitOrchestration(state);
    }

    if (!plan) {
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
    state.orchestration.spawned += 1;
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
    state.orchestration.done += 1;
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

    const usage = msg.usage;
    const outputTokens: number = usage?.output ?? 0;
    state.totalOutputTokens += outputTokens;
    // Cache-aware routing (SPEC §9.2): record the last activity so the
    // session-boundary gate knows whether the prompt cache is still warm.
    state.lastActivityAt = Date.now();

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

    // Compute throughput from wall-clock elapsed (we used Date.now() at
    // message_start, so streamingStartTime is reliably set for any assistant
    // message that ran through streaming).
    const startTime = state.streamingStartTime;
    if (startTime !== null && outputTokens > 0) {
      const elapsed = Date.now() - startTime;
      const tps = tokensPerSecond(outputTokens, elapsed);
      if (tps > 0) {
        recordSpeed(state.recentSpeeds, tps);
        if (config.ux.routerLogVerbose) {
          console.log(
            `[ShiftRouter] ${outputTokens} tokens in ${elapsed}ms = ${tps} tok/s (total ${state.totalOutputTokens.toLocaleString()})`,
          );
        }
      } else if (config.ux.routerLogVerbose) {
        // tokens>0 but elapsed<=0 — defensive log so we can see time-source issues
        console.log(
          `[ShiftRouter] message_end: tokens=${outputTokens} elapsed=${elapsed}ms startTime=${startTime} msgTs=${msg.timestamp}`,
        );
      }
    } else if (config.ux.routerLogVerbose) {
      console.log(
        `[ShiftRouter] message_end: tokens=${outputTokens} startTime=${startTime} usage=${usage ? JSON.stringify(usage) : "undefined"}`,
      );
    }

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
