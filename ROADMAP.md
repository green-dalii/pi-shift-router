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

## Planned

| Feature | Version | Notes |
|---------|---------|-------|
| Cost telemetry — deep view | v0.9.0 ✅ done | Smart vs Fast spend breakdown + savings vs **all-turns-on-smart** baseline (`config.tiers.smart.models[0]` pricing × session tokens). Data: pi-agent `message_end.usage.cost.total` + `models-store.json`. |
| Cooldown backoff rescale | v0.9.0 ✅ done | 4× multiplier, 6h cap, **4xx starts at 16m** (client-side rate limits outlive 5xx blips), 5xx keeps 1m. |
| Orchestration hardening (Phase 2) | v1.2.0 ✅ done | Review-loop convergence protocol + plugin-enforced escalation/max-rounds caps (`recordWorkerOutcome` + `tool_call` block + `⛔cap` status). Native /model contract documented (Scheme A). |
| Examples directory | ongoing | Sample configs (frontend / ML / cross-provider cost-saving) for documentation. |
| Tool-result classification | TBD | SPEC §9: classify tool calls (long shell output may indicate debugging, not a question). |
| Verbose logs to file | TBD | `routerLogVerbose` currently writes straight to stdout, which interleaves with pi's TUI frame render and can leave the working spinner on screen after a turn (reported + root-caused in v0.10.0). Plan: route verbose diagnostics to a log file (e.g. `~/.pi/logs/shift-router.log`) instead of stdout, or expose a pi logging channel if one ships. |
| **Task-level orchestration** | v1.0.0 | SPEC §9.3. Complex tasks escalate to a **Smart main agent that orchestrates Fast subagents** (Teams/Orchestra pattern) using pi-subagents. See sub-plan below. |
| Coverage reporting | ✅ done | `vitest --coverage` in CI (v8 provider, thresholds ≥90% lines/functions/statements, ≥85% branches on `src/router.ts` + `src/failover.ts`). Current: router 100% / failover 95.5%. |

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
- [ ] Cost attribution: subagent `usage` from NDJSON routed into §9.1 telemetry (per-worker spend in `/router stats`).
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