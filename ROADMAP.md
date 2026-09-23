# Roadmap

Release history and planned work for **pi-shift-router**.

## Released

| Version | Highlights | Status |
|---------|-----------|--------|
| v0.1.0 | Core engine + LLM Judge | ✅ |
| v0.2.0 | TUI model picker + wizard | ✅ |
| v0.3.0 | Two-tier redesign (CTO / Programmer) | ✅ |
| v0.3.1 | Judge JSON-mode + judging indicator + verbose log | ✅ |
| v0.4.0 | First npm publish (international docs + i18n + CI) | ✅ |
| v0.4.1 | Runtime `Cannot find package` fix + `pack:check` guard | ✅ |
| v0.5.0 | Multi-model fallback chain editor | ✅ |
| v0.6.0 | Runtime failover (exponential backoff, same-tier) | ✅ |
| v0.7.0 | Confidence-weighted sliding window | ✅ |
| v0.8.0 | Token throughput + `/router stats` + Tuning Guide | ✅ |
| v0.8.1 | Judge crash fix + README badges restored | ✅ |
| v0.8.2 | Docs + Judge prompt clarity (role-not-judgment framing) | ✅ |
| v0.8.3 | Judge cooldown sharing + README restructure + packaging | ✅ |
| v0.9.0 | Cost telemetry + `/router status` restructure + cooldown rescale (4xx/5xx split) | ✅ |
| v0.9.1 | Slogan philosophy + CTO/Engineer terminology unification | ✅ |
| v0.10.0 | Cache-aware routing (same-family threshold + warm-cache guard) + coverage reporting | ✅ |
| v1.0.0 | Task-level orchestration: Smart CTO delegates to Fast subagents | ✅ |
| v1.0.1 | Custom-provider support, expandEnv fix | ✅ |
| v1.1.0 | Orchestration works end-to-end; full status-bar telemetry | ✅ |
| v1.1.1 | Logging & status-bar display fixes | ✅ |
| v1.2.0 | Orchestration hardening: hard caps, convergence protocol, stale-model cleanup | ✅ |
| v1.3.0 | Orchestration acceptance audit + prompt overhaul | ✅ |
| v1.3.1 | pi-tui runtime dependency + release gates | ✅ |
| v1.4.0 | EV economics routing, gear presets, doc-aware judge | ✅ |
| v1.4.1 | Failover on 402 Insufficient Balance / 余额不足 | ✅ |
| v1.4.2 | Judge-outage hold, retry-aware audit, TPS smoothing, status dashboard | ✅ |
| v1.4.3 | Codex usage-limit failover + housekeeping | ✅ |
| v1.5.0 | Per-worker cost attribution (`orchestration $X (N workers)`) | ✅ |
| v1.5.1 | Verbose logs to a file; wizard emoji consistency | ✅ |

## Planned

**Priority order:** **Judge modes (v1.7.0)** → routing asymmetry (§2.3) → config-layer switch (§5) → Phase 3 breadth. The Judge-modes feature is orthogonal to the other two and is the enabler for the threshold re-derivation later (see sub-plan below); the routing-asymmetry revision must **not** be folded into it (θ stays untouched until real confidence data exists).

| Feature | Version | Notes |
|---------|---------|-------|
| **Judge modes: fast-chain / dedicated LLM / decision model (Jev)** | **v1.7.0 — implemented, awaiting e2e** | SPEC §8. Additive: the LLM judge is retained. `routing.judge.mode` with `fast-chain` (default, current behaviour), `custom` (dedicated Judge chain, reuses the chain editor), `decision` (typed-answer models — Jev/System One class). See the sub-plan below. |
| Routing asymmetry (§2.3) — directional θ, fast-band removal, hold semantics, cache gate | v1.8.0 | The upgrade-eager / downgrade-sticky fix: today any decisive `smart` verdict upgrades (θ always < minConfidence) while downgrades need conf > 0.78 **and** 2 consecutive verdicts **and** a 5-minute cache gate. Re-derive thresholds from measured confidence data once Judge modes ship. |
| Config-layer switch (§5) — pick the layer the wizard edits, patch writes | v1.9.0 | Layer picker + provenance badges + override warning; write only changed keys so the other layer is never polluted (today `saveConfig` writes the whole merged snapshot). |
| Examples directory | ongoing | Sample configs (frontend / ML / cross-provider cost-saving) for documentation. |
| Pi model-registry alignment | v1.6.0 ✅ done | The wizard/Judge/telemetry now read pi's own model registry (`ctx.modelRegistry.getAvailable()` / `find()` / `getProviderAuthStatus()` / `getApiKeyForProvider()`) instead of re-deriving a catalog from `models-store.json`. Fixes the picker showing a different, smaller list than `/model` (measured drift: 5 providers/413 models vs 39/1354; env-var and `models_json_command` credentials were invisible). Store paths remain as fallback. `src/model-source.ts`. |
| Cost attribution (per-worker) | v1.5.0 ✅ done | Bounded per-worker ledger (`recordWorkerSpend`, cap 20) + task-spend accumulation; `/router status` Money section shows `orchestration $X (N workers)`. Aggregate spend was already in the status bar since v1.1. |
| Context discipline | TBD | Orchestrator digests between phases (reuse compaction ideas); worker tasks self-contained. Gather real-usage data first. |
| §9.2 warm-cache interplay | TBD | Main agent stays Smart across orchestration turns → cache invalidation; decide whether cacheAware should be orchestration-aware. Gather usage data first. |
| Parallel worker fanout | Phase 3 | Specialized workers (frontend / backend / tests) from the Fast chain; independent phases fan out via `runs.all` with `worktree: true` isolation. |
| Cross-turn orchestration lifecycle | Phase 3 | `orchestration.active` session state; main model stays Smart across turns while active. MVP is single-turn. |
| Tool-result classification | TBD | SPEC §9: classify tool calls (long shell output may indicate debugging, not a question). |
| ~~Verbose logs to file~~ | ✅ done | `routerLogVerbose` now appends to `~/.pi/agent/logs/shift-router.log` via `src/log.ts` instead of stdout. stdout writes interleaved with pi's TUI frames and split assistant text mid-sentence (reported 2026-09-17 with a CTO summary). pi ships no logging channel, so a file is the sink; `PI_SHIFT_ROUTER_LOG` overrides the path. |
| Coverage reporting | ✅ done | `vitest --coverage` in CI (v8 provider, thresholds ≥90% lines/functions/statements, ≥85% branches on `src/router.ts` + `src/failover.ts`). Current: router 100% / failover 95.5%. |

### Judge modes — implementation sub-plan (SPEC §8, v1.7.0)

**Goal.** Keep the current LLM judge exactly as it is; add two more ways to run it — a dedicated Judge LLM chain, and a decision-model protocol (Jev and future System One-class models). Selecting a decision model must be done **inside the wizard** and must be validated before it is saved.

**Config (types.ts).**
```jsonc
"routing": {
  "judge": {
    "mode": "fast-chain",        // "fast-chain" (default) | "custom" | "decision"
    "models": [ { "provider": "…", "model": "…", "priority": 1 } ]   // used by custom + decision
  }
}
```
One `models` list; `mode` only selects the source. Absent `judge` ⇒ `fast-chain` ⇒ byte-identical to today.

- [x] **Phase A — config + resolver.** `routing.judge` schema + defaults; `resolveJudgeEndpoints()` selects `tiers.fast.models` (fast-chain) or `judge.models` (custom/decision); cheapest-model fallback applies to `fast-chain` only — a dedicated/decision chain with no resolvable endpoint **holds** instead of silently running an arbitrary model.
- [x] **Phase B — protocol adapter.** New `apiType: "typesafe-decisions"`: `POST {baseUrl}/v1/systemone`, body `{model, state, questions:{tier:{type:"choice",instructions,criteria:{fast,smart}}, orchestrate:{type:"noul",instructions,criteria:{true,false}}}}`; response mapping `tier = answers.tier.choice`, `confidence = answers.tier.probabilities[tier]` (tolerate a bare top-level map and a `confidence` field), `orchestrate = answers.orchestrate.noul >= 0.5`, no `reason`. Failures ⇒ hold; the existing chain failover/cooldown machinery is protocol-agnostic and needs no change.
- [x] **Phase C — wizard.** New `🧭 Judge` row → sub-menu: `🦾 Reuse Fast tier chain (default)` / `🔬 Dedicated Judge models…` / `🧮 Decision model (Jev-style)…`（`●` 标记当前模式）. The latter two reuse `createChainEditor`. Candidates come from pi's registry (v1.6.0 alignment); the decision path filters to decision-capable endpoints, and **if none exist** it opens a dismissible setup screen (why + the exact `api` value + where to put it, not a vanishing toast) and returns without writing. On selection, validate locally (route resolves + `api: "typesafe-decisions"` marker present) — no network call at save time; the save-time probe was removed in v1.7.0 because it blocked the config UI and only proved the endpoint worked at that instant.
- [x] **Phase D — validation & tests.** Request-shape fixtures; Choice/Noul mapping incl. envelope tolerance; probability→confidence; Noul boundaries (0.49/0.5/0.51); malformed/missing answers ⇒ hold; back-compat (no `judge` key ⇒ fast-chain); resolver tests; decision-candidate filter + probe helper tests.
- [x] **Phase E — docs.** SPEC §8 (protocol), §5.2 (schema), §2.3 (confidence semantics note: native probabilities when mode=decision), §6 (wizard); docs/CONFIG ×2 + MODELS ×2; README ×2 + command table; CHANGELOG; MEMORY.md entry.

**Risks / open items.** Response envelope must be confirmed against a live key (parse tolerantly meanwhile); gateway routes (OpenRouter / Vercel / Cloudflare) may differ — treat `baseUrl` as configurable; Jev's Chinese quality on our prompts is unmeasured → the retained LLM judge is the fallback; early access via TypeSafe console, so the probe must fail gracefully with an actionable message.

### Task-level orchestration — implementation sub-plan (SPEC §9.3)

**Phase 0 — Spike (no code):**
- [x] Confirm `subagent` tool per-run `model` override works with `provider/model-id` refs from the tier config (e.g. `minimax-cn/MiniMax-M3`). **Verified 2026-08-13**: `runs.run({ agent: "worker", model: "minimax-cn/MiniMax-M3" })` → `attemptedModels: ["minimax-cn/MiniMax-M3:off"]` — override wins over inherited parent model. Key finding: without the override, worker inherits the *parent session's current* model (which is Smart mid-orchestration) → **Tier injection is mandatory**, not optional.
- [x] Worker end-to-end: fork spawns, tools run (ls), result + `usage.cost` ($0.069, 163k in) returned — §9.1 telemetry attribution feasible.
- [x] **Thinking control (user-flagged + verified)**: with `context: "fork"`, any model using the anthropic-messages API (e.g. MiniMax-M3 via `api.minimaxi.com/anthropic`) is **force-forced to `thinking: off`** by pi-subagents' safety sanitizer (`forkedChildRequiresThinkingOff`, fork-context.ts:61-71) — run params cannot override it. **Fix: spawn workers with `context: "fresh"`** → thinking override honored (`minimax-cn/MiniMax-M3:high` verified) AND context shrinks 176k→8.3k tokens (cost $0.064→$0.004, 3× faster). Fresh-context narrow workers are the right shape for Fast-tier execution.
- [x] Manually run `/review-loop` with a real task; verify worker/reviewer model behavior against the Fast/Smart tiers (worker override + reviewer Smart pin). **Verified 2026-08-13**: worker created `/tmp/pi-router-review-loop-test.md` with the exact task contract (goal/constraints/acceptance), reviewer verified each criterion read-only and reported PASS; both ran `minimax-cn/MiniMax-M3:high` (fresh + override + thinking honored); repo tree untouched (git status clean). The implement→review→synthesize loop works end-to-end with per-run model injection.
- [x] Verify cooldown-state rendering (tier chain with current cooldowns filtered) can be expressed in the orchestrator prompt. **Verified 2026-08-13**: `renderTierChain` skips cooled models and reports "all models in cooldown" when nothing is usable; `buildOrchestratorPrompt` injects the filtered chain (unit-tested in `tests/orchestrate.test.ts`).

**Phase 1 — Orchestration entry (plugin):** ✅ implemented (local commit, pending user e2e)
- [x] Judge verdict `complex` → switch main agent to Smart model (existing `applyModelSwitch` path) + inject orchestrator instruction.
- [x] Orchestrator instruction template (`src/prompts/orchestrator.md`): "you are the CTO — plan, delegate to `worker` subagents (Fast tier chain with priority/cooldown filtered), review with `reviewer` (Smart tier), loop until clean (cap N), take over yourself if a worker fails ≥N times, final acceptance pass".
- [x] Tier injection: render `config.tiers.fast` / `config.tiers.smart` (healthy-only, priority order) into the instruction; per-run `model` override guidance.
- [x] **Worker task-prompt design principles** (SPEC §9.3): task-contract structure (goal/constraints/acceptance/out-of-scope), reference-don't-paste for large files, signal density, executable acceptance criteria, per-phase boundaries, budget-aware self-check. These shape the orchestrator template's delegation guidance.
- [x] **Hard-control state machine** (plugin code): `currentPhase`, `attempts`, `maxRounds` cap, escalation threshold N, elapsed/cost budget — the loop stops when code says stop, not just when Smart says so.
- [x] Simple tasks unchanged (fast direct run — degraded default).
- [x] `/router orchestrate auto|off` toggle; default **auto** (v1.0.0 feature on by default; one-command opt-out). `auto` = Judge-driven: simple tasks stay on the plain router, complex tasks orchestrate (requires pi-subagents; without it degrades to today's smart run). Status bar `🪄` indicator.
- [x] Abort semantics: user message / `/router orchestrate off` mid-loop cancels and resets.
- [x] **Backward-compat tests** (SPEC §9.3 contract): orchestration-off byte-identical behavior; simple task never orchestrates; config without `orchestration.*` parses unchanged; pi-subagents missing → prompt injection skipped, smart-tier run proceeds; abort mid-loop → clean reset; existing features (failover/telemetry/cache-aware) unaffected.

**Phase 2 — Loop hardening:**
- [x] **Review-loop convergence (v1.2.0)**: only-blocking-issues rule + **convergence protocol** — every re-delegation must carry a structured failure report (what failed / where / acceptance test to re-run); repeating the same feedback triggers takeover instead of re-delegation. Prompt: `src/prompts/orchestrator.md` + fallback.
- [x] **Escalation threshold N (v1.2.0, plugin-enforced)**: `recordWorkerOutcome(state, config, ok)` consumes a round per subagent result and advances the consecutive-failure streak; at N the phase escalates. `tool_call` blocks new spawns via `{ block: true }` once `capHit()` fires — the caps are hard, not prompt-side suggestions. Status bar shows `⛔cap` when hit.
- [x] **Acceptance audit (v1.3.0, safety-net review)**: post-turn audit in `agent_end` — deterministic checks always run (workers all reported back, CTO-summary present, hard-cap flag) + optional small fast-tier LLM audit (`src/prompts/auditor.md`) that verifies the acceptance claim is grounded in worker results. Findings surface via warn/toast + `/router status` → `Last audit`; never blocks the finished turn. Files: `src/audit.ts`, `src/prompts/auditor.md`; config `orchestration.audit.*` (default on).
- [x] **Cost attribution (v1.5.0)**: subagent `usage` from the tool result routed into §9.1 telemetry — `recordWorkerSpend` keeps a bounded per-worker ledger (cap 20) and the `/router status` Money section shows `orchestration $X (N workers)`. Aggregate spend had been in the status bar since v1.1.
- [ ] Context discipline: orchestrator digests between phases (reuse compaction ideas); worker tasks self-contained.
- [ ] Interplay with §9.2 warm-cache guard for main-agent switches.

**Phase 3 — Breadth:**
- [ ] Multiple specialized workers (frontend / backend / tests) derived from the Fast chain; parallel fanout via `runs.all` for independent phases.
- [ ] Worktree isolation (`worktree: true`) for parallel writers.
- [ ] **Cross-turn orchestration lifecycle**: `orchestration.active` session state (set on complex entry, cleared on sentinel completion / budget cap / abort) — main model stays Smart across turns while active; resumes auto routing after exit. (MVP is single-turn: plan+delegate+review+accept inside one Smart turn; cross-turn is this extension.)
- [ ] Examples directory entry (orchestration config + orchestrator prompt).

**Design decisions recorded in SPEC §9.3 (Open design decisions):** entry trigger (auto vs confirm), worker mapping, review loop style, escalation threshold, default auto (settled), §9.2 interplay. **Hard/soft control split + backward-compatibility contract** (§9.3): plugin owns caps/budget/abort, Smart owns plan/review/accept; orchestration default auto (one-command opt-out), simple tasks never orchestrate, missing pi-subagents degrades to today's smart run.

> **Withdrawn from earlier drafts.** Per-tier thinking level was proposed but is largely redundant — tier classification already encodes prompt complexity, so a static per-tier thinking rule rarely saves more than it complicates. Adaptive (per-prompt) thinking adds machinery without a clear win because the smart tier is already gated on real complexity. Dropped from v0.8.x.
>
> **Multilingual Judge prompt/input work** was dropped on ROI grounds — LLMs are multilingual; generating zh / ja / es / fr versions of `judge.md` solves a problem that doesn't exist.

**Follow-ups (v1.7.x), from the live measurement (MEMORY 2026-09-18):**

- [ ] **Decision-mode latency re-measurement (beta capacity).** Live calls returned
      in 1.4–6.6 s (median ~5 s) because of provider-side capacity during Jev's
      public beta — a 5x smaller payload was no faster, so this is not payload or
      integration overhead. Re-measure as capacity comes online; when it drops, lower
      the wizard's 15 s `judgeTimeout` floor and 20 s probe timeout with it. If
      seconds persist, position decision mode as batch/background-only.
- [ ] **Threshold re-derivation for calibrated probabilities** (the v1.8.0
      routing-asymmetry work). Decision mode returns a calibrated distribution, not
      an LLM `confidence`; θ and `minConfidence` are still on the LLM scale.

## Explicitly excluded (by design)

These are deliberate non-goals, kept consistent with SPEC §0 ("Design Philosophy") and `AGENTS.md`:

- **3-tier routing** — execution vs judgment is the only meaningful axis (SPEC v0.3.0).
- **Keyword/custom rules** — would violate "LLM Judge is the sole classifier" principle.
- **USD budget cap** — pi-shift-router is a routing layer, not a billing layer.
- **Heuristic Judge fallback** — the LLM Judge either returns or holds position; no keyword/length heuristics substitute.
- **Cross-session persistent state** — `session_start` is read-only by design; profile state stays session-scoped.
- **Local ML / ONNX inference** — a different design space; `pi-smart-router` already occupies it.
- **Runtime npm dependencies** — would violate "zero runtime deps" principle.

## See also

- [README.md](README.md) — user-facing docs
- [CHANGELOG.md](CHANGELOG.md) — per-version change log
- [SPEC.md](SPEC.md) — full design contract
- [AGENTS.md](AGENTS.md) — development principles