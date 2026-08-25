# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Renamed from `pi-slim-router` to `pi-shift-router` in v0.4.0.** Earlier versions
> (0.1.0 – 0.3.1) were developed under the `pi-slim-router` working name and never
> published to npm. The plugin was first published to npm as `pi-shift-router` at v0.4.0.

## [1.0.1] — Custom-provider support, branch protection policy, expandEnv fix

### Added

- **Custom providers via `~/.pi/agent/models.json`** (#1) — merge user-supplied providers over the built-in catalog with env-expandable inline `apiKey`. Built-in models survive; same-id custom models replace per pi semantics. Provider-level fields (`baseUrl`, `api`, `apiKey`) supported; custom models are upserted by `id`. Backward-compatible: a missing or empty `models.json` is non-fatal.
- **Branch protection workflow documented** (#3) — `AGENTS.md` now describes the 7-step standard flow for any change (branch off `main`, commit, push, open PR, wait for review, squash-merge, verify), plus five edge cases (hotfixes, version bumps, tag pushes, working-tree-only fixes, reverts) and the rationale for layering Hard Stop on top of GitHub-enforced branch protection.

### Fixed

- **`expandEnv` regex silently consumed `$<digit>` patterns** (#4) — a user pasting an API key with literal `$1`, `$5`, or `$KEY_SUFFIX`-style substrings lost those characters silently; the provider then got a truncated key with no router-side error pointing to the cause. Tightened the regex to require a letter or underscore prefix (`[A-Za-z_]\w*`, POSIX env-var convention). `$1` and `$5` are now preserved literally. Letter-prefixed `$VAR` patterns are still expanded by design (the `$$` escape is recommended for literal substrings). 13 new `expandEnv` test cases document both the fix and the remaining known limitation.
- **Orchestration never triggered in v1.0.0** — the `(event as any).systemPrompt = ...` mutation was dead code (pi only reads `handlerResult.systemPrompt`); `pi.tools?.subagent` was always undefined (pi.tools is an internal Map on Extension, not ExtensionAPI). Switched to `pi.getAllTools()` / `pi.getActiveTools()` with try/catch fallback, plus a Judge `orchestrate` signal that decouples complexity from scale. Shipped pre-v1.0.1 (commit `eac87b0`) but not yet released; will land in v1.1.0 with the verbose-logging work.
- **`/router config` showed a stale model list** — `_modelsStore` was cached for the lifetime of the pi session, so the picker kept showing a startup snapshot even after the user added or removed providers in `~/.pi/agent/models.json` (or after pi-agent updated `models-store.json`). The wizard now calls `invalidateModelsStoreCache()` at entry, forcing a fresh re-read of both files. `invalidateConfigCache()` also clears `_modelsStore` defensively (any config-save signal implies possible catalog changes). `loadModelsStore()` accepts optional path overrides for testing. 4 new tests cover the cached-vs-fresh paths.
- **Status bar stuck on "🪄 orchestrating…"** — after an orchestration turn ended (agent_end) or after `/router orchestrate off`, the status bar continued to show the orchestration label until the next event that refreshed it (next turn, message_end). The `agent_end` handler now calls `updateBar()` after `exitOrchestration`; `/router orchestrate off` now calls `updateStatus()` after `resetOrchestration`. Extracted `formatStatusBarLabel(cfg, s)` as a pure helper for direct testing. 6 new tests cover the lifecycle transitions.

### Changed

- **SPEC.md §5.4** — documented `apiKey` resolution order (auth.json → inline apiKey → skip), `baseUrl` fallback chain (modelInfo → provEntry → `""`), cheapest-fallback eligibility (custom providers with env-set apiKey ARE eligible; `defaultModel` is NOT consulted), and the `_modelsStore` cache-invalidation limitation (editing `models.json` requires a pi restart).
- **Hard Stop rule extended** (#3) — `gh pr create` and `gh pr merge` now require explicit user approval, on par with `git push` and `npm publish`.

### Notes

- 320 tests pass (15 files; +15 since v1.0.0).
- No breaking changes; default behavior for existing configs is unchanged.

## [1.0.0] — Task-level orchestration: the CTO delegates to Fast subagents

### Added

- **Task-level orchestration (SPEC §9.3).** Complex tasks (Judge `smart` verdict) now escalate from *turn-level* routing to *task-level* execution: the Smart tier runs as a CTO that plans the work, delegates implementation to Fast engineer subagents (via the `subagent` tool, `context: "fresh"`, model pinned from the Fast tier chain), reviews each result, iterates with concrete feedback, and does a final acceptance pass. Simple tasks (`fast` verdict) never orchestrate — they stay on the plain router, byte-for-byte unchanged.
- **Orchestrator instruction** (`src/prompts/orchestrator.md`): injected into the Smart agent's system prompt when an orchestrated turn begins, with the current Fast/Smart tier chains rendered in (cooldown-filtered, priority-ordered). Includes the worker task-contract principles (goal / constraints / acceptance criteria / out-of-scope; reference-don't-paste; signal density; executable acceptance; per-phase boundaries).
- **Hard-control state machine.** The plugin owns the caps independent of the Smart agent's judgment: `orchestration.maxRounds` (default 3) and `orchestration.escalationThreshold` (default 2 — after N worker failures on a phase, Smart takes over that phase itself). The loop stops when either the Smart agent says done or a cap is hit.
- **`/router orchestrate auto|off` command.** `auto` (default) = Judge-driven: simple tasks stay on the plain router, complex tasks orchestrate. `off` = plain two-tier routing only (one-command opt-out; `on` kept as a legacy alias mapping to `auto`). Status bar / logs use `🪄` to distinguish orchestration from the judge's `🧭` compass.
- **Backward compatibility contract** (SPEC §9.3): orchestration ships on by default, but existing behavior is preserved — simple tasks never orchestrate, and missing `pi-subagents` degrades to today's smart-tier run (no crash, no deadlock). All `orchestration.*` config fields are optional with defaults; existing configs parse unchanged.
- **Prerequisite documented:** advanced orchestration requires the `pi-subagents` extension; without it the router keeps working as base two-tier routing.

### Changed

- **README×2, SPEC, ROADMAP, TROUBLESHOOTING×2** — comprehensive task-level orchestration documentation: how an orchestrated turn runs, fresh-context worker rationale (verified ~$0.004 narrow task vs ~$0.06 inherited 176k-token fork; thinking stays enabled vs forced-off in fork mode), hard caps, when orchestration doesn't engage, and a four-gate troubleshooting checklist for "orchestration never engages".
- **package.json `pi.image`** — hero image added for the pi package gallery (PNG/JPEG/WebP public URL).

### Removed

- None (orchestration is additive; default behavior for existing configs is unchanged).

## [0.10.0] — Cache-aware routing, judge reason, coverage reporting

### Added

- **Cache-aware routing (default on).** When Fast and Smart tiers share the same provider family, the judge threshold auto-raises from 0.6 to 0.9 so borderline prompts stay on the warm-cache model instead of churning providers; downgrades to a different family are suppressed while the prompt cache is warm (default 5 min idle boundary, configurable). Upgrades are always instant; cross-family setups are untouched. Pure-logic helpers (`shareProviderFamily`, `effectiveThreshold`, `downgradeAllowedAt`) with zero heuristics; `RouterState.lastActivityAt` tracks cache warmth from `message_end`. 20 new tests.
- **Judge `reason` field.** The judge prompt now emits a short `reason` phrase naming the deciding signal; parsed with a 120-char cap and `reason`/`why` aliases, shown in verbose logs and `/router status`. Debug/observation only — never read by the routing algorithm.
- **Coverage reporting.** `@vitest/coverage-v8` + `test:coverage` script; CI runs `vitest --coverage` with thresholds ≥90% lines/functions/statements and ≥85% branches on `src/router.ts` + `src/failover.ts`.
- **Working-spinner fix for TUI stdout pollution.** All judge diagnostics (`Judge fetch failed`, API errors, unparseable responses, LLM-unavailable) are now gated behind `routerLogVerbose` — previously they wrote to stdout even with verbose off, interleaving with pi's TUI frame render and leaving the spinner stuck on screen. `before_agent_start` also restores pi's `workingVisible` flag after the defensive `agent_end` clear, so every turn still shows the spinner normally.

### Changed

- **`/router config` UX fixes.** Cache-aware toggle was unreachable because its emoji prefix collided with the Smart editor match — menu matching refactored to stable text keywords (`Cache-aware > Fast > Smart > UX > Save`) with regression tests; decorative `---` items removed from all panels (pi-tui `SelectList` has no separator concept and treated them as cancel). Cache-aware wizard copy rewritten user-facing (no internal SPEC cross-references). `/router status` now shows cache-aware state (`same-family threshold 0.9, warm-cache guarded`).
- **`judge.md` refined + compressed.** Review-task row added (small well-defined flaw with a routine fix → fast; review as deliverable → smart), with guardrails: security review never downgraded, user explicit intent wins, decision question prompts critical thinking. Prompt compressed from 7509 → 5822 chars (below the pre-reasoning baseline) with all 100 functional phrases verified preserved.
- **Verbose log cleanup.** Single `judge: tier conf=N reason=X window=[..]` line; removed duplicate `Judge → tier` and dead `Judge raw: undefined` debug.

### Fixed

- **Menu-matching emoji collision.** `🧠 Cache-aware routing` matched the Smart editor first, silently making the cache-aware config unreachable. Now matched by text keyword `Cache-aware`.

### Removed

- **`---` menu separators** (unsupported by pi-tui `SelectList`; selecting one exited the wizard silently).

## [0.9.1] — Slogan philosophy unified across docs and judge prompt

### Changed

- **Slogan philosophy pinned down.** Both READMEs now open with a single tagline: *"It's a CTO for the work that matters, an engineer for the workload"* (EN) / *"重要的事它是CTO，跑量的活它是工程师"* (ZH). All body copy — hero alt text, leads, "How it works", "When it pays off" — was rewritten to use the same vocabulary (`important work` / `重要的事` instead of `matters` / `consequential` / `judgment call`), removing the ambiguous scope-shrinking phrasing.
- **Role terminology unified: Programmer → Engineer.** SPEC, AGENTS, `src/types.ts` comments, the `/router config` menu, and the judge prompt now all name the fast tier "engineer" (`engineer mode`), matching the slogan. The smart tier is consistently "CTO" across the same files.
- **CTO role description sharpened in SPEC.** Smart = CTO now explicitly covers direction-setting, course correction, result review, security audit, and hard problems done personally — "high-stakes turns don't get dropped" — instead of the narrower "complex-work driver".
- **`judge.md` audited against the philosophy.** Fast tier described as the cheap, fast, reliable engineer; smart tier as judgment driver that sets direction, corrects course, reviews results, and takes on hard problems itself. Two new signal rows: course correction (wrong approach / reversal) and code review of already-done work. "Complex work" → "important work". Prompt tests updated (`engineer mode` assertion).
- **Project website + See also sections.** README TOC now leads with the project site (🌐) and all 7 TOC items are emoji-prefixed; a new "See also" / "关联项目" section links `obsidian-llm-wiki` (same author). `package.json` `homepage` points at the project site.

### Removed

- **`PLAN.md` deleted as redundant.** Its phase history, file structure, and roadmap were fully superseded by ROADMAP.md + CHANGELOG.md + SPEC.md; its "next step" (npm publish) was already done as of v0.9.0, and the doc had no remaining references.

## [0.9.0] — Cost telemetry, smart-tier savings baseline, cooldown rescale

### Added

- **Cost telemetry — deep view.** `/router stats` now exposes per-tier spend (USD + token counts) and a hypothetical savings baseline. Each `message_end` attributes tokens + `usage.cost.total` to the active tier (`state.currentTier` at the time of the message). The baseline answers "what would this session have cost if every turn ran on your configured Smart-tier model (priority 1)?" — the natural no-router setup — and reports the difference as the savings figure. When pricing is missing for every model used (e.g. fully-local session with no `models-store.json` pricing), the baseline shows `unavailable` instead of a misleading number. New `getModelPricing()` helper in `src/config.ts`; new `computeCostTelemetry()` / `formatUsd()` / `judgeModelDisplay()` in `src/stats.ts`. `src/index.ts` now accumulates `state.tierUsage` and `state.callLog` on every assistant message; `/router config` reset clears them too. SPEC §9.1 documents the data source and baseline definition. 13 new tests in `tests/cost-telemetry.test.ts` covering attribution, smart-tier baseline (with cache tokens), fallback when pricing is missing, and `formatStats` rendering.

### Changed

- **Cooldown backoff rescaled for hour-scale rate windows.** `markModelFailed` now uses multiplier 4 (`BASE * 4^(attempts-1)`) and caps at **6 hours** instead of 30 minutes: 1m → 4m → 16m → 1h4m → 4h16m → 6h. The old 30m cap caused repeated 429 re-hits across hour-long coding-plan rate windows (e.g. M3 quota). Escalation persists across natural expiry — a thawed model that fails again continues from the previous `attempts` tier rather than resetting (verified by new test). `clearModelCooldown` still fully clears on 2xx recovery. **4xx vs 5xx split**: failover-worthy 4xx (429/quota — client-side limits) now skips the first two tiers and starts at 16m via `COOLDOWN_START_ATTEMPTS_4XX`; 5xx keeps the 1m start. SPEC §8.5.2 and README updated.
- **`/router status` reorganized for readability.** Output is now grouped into `Tiers / Session / Stats / Detail / Config` sections: human-friendly turns/upgrades/downgrades summary at the top, raw window/counts moved to a bottom `Detail` section for power users, and the configured tier chains shown first. `formatStats` gains a `Judge: 🧭 <fast-tier chain>` line and drops its duplicate cooldown block (now shown once under Session).

## [0.8.3] — Judge cooldown sharing, packaging, README restructure

### Changed

- **Judge status-bar icon: `⚖` → `🧭`** — the previous scales glyph (U+2696, BMP) rendered as a small monochrome line drawing in most terminals, visually inconsistent with `🦾` and `🧠` (both SMP color emoji). The compass (U+1F9ED, SMP) is a single-codepoint emoji that renders at the same weight as the tier icons across all modern terminals, and semantically fits the judge's job: "decide which direction (tier) this turn goes." Affected: `src/index.ts`, `README.md`, `README.zh-CN.md`, `SPEC.md` §3 ASCII diagram + §7.2. Historical CHANGELOG entries and the SPEC §10 v0.3.1 row intentionally retained the old glyph to preserve an accurate record of past releases (Keep a Changelog convention).
- **README restructured into a landing page + `docs/` split** — `README.md` and `README.zh-CN.md` rewritten as concise landing pages (one-story opening, honest trade-offs, three-line competitor comparison, four-question FAQ). Reference material moved into `docs/CONFIG.md`, `docs/MODELS.md`, `docs/TROUBLESHOOTING.md` (and `.zh-CN.md` variants). SEO/GEO pass: definitional lead sentence ("is a two-tier model router" / "是 pi-coding-agent 的两档模型路由器") so the core entity lands in the first 100 words; FAQ items promoted to `###` headings for question/answer extraction; `last-updated` and `search-intents` (with competitor + use-case queries) added to the metadata comment blocks. `package.json` `files` array now includes `docs/`, `assets/` and `README.md` so npm pages resolve relative image + doc links.
- **`@earendil-works/pi-tui` moved to `peerDependencies`** — previously listed in `dependencies`, which contradicted pi's official packaging rules (`packages.md` L171) and the project's own "zero runtime dependencies" claim (npm was actually installing a separate copy of pi-tui alongside the host's bundled one). Now declared as `peerDependencies: { "@earendil-works/pi-tui": "*" }` (host-provided, not bundled) and kept in `devDependencies: ^0.81.1` for local builds/typechecking. The "zero runtime dependencies" claim is now literally true again. `package-lock.json` synced.
- **`keywords` extended (16 → 20)** — added `model-switching`, `agent-routing`, `auto-router`, `cost-optimization` (npm keyword cap is 20).
- **`publishConfig.registry` added** — `"https://registry.npmjs.org/"` so accidental `npm publish` without `--registry` still targets the public registry; the existing release-flow `--registry` flag remains as the primary guard.

### Fixed

- **Judge no longer wastes 429 calls on a known-broken fast model.** Before this change, the Judge walked the fast-tier chain in priority order on every `before_agent_start`, but only `agent_end` (a full turn failure) wrote into `state.modelCooldowns`. So if the fast-tier's first model was rate-limited, every Judge invocation re-hit it — burning a 429 call before falling back to the next model. If the Judge happened to pick `smart` that turn, the model stayed uncooled indefinitely and the 429-then-retry pattern repeated forever. Now `classify()` surfaces the failover signature (HTTP 429/5xx, body containing `rate_limit` / `quota` / `rate_limit_error`) via a new `onFailure` callback, and `index.ts` wires it to `markModelFailed`. Network errors, timeouts, 401/403 auth errors, and unparseable responses still do **not** cool down — they are not failover signatures and would over-block the turn path (SPEC §8.5.3). Affected files: `src/judge.ts`, `src/index.ts`, `SPEC.md` §4.6 + §8.5.2(5). 7 new tests in `tests/judge-fallback.test.ts`.

## [0.8.2] — Docs + Judge prompt clarity

### Changed

- **Smart tier is a role that drives the whole turn, not a judge.** The previous wording in `README.md`, `README.zh-CN.md`, `SPEC.md`, and `src/prompts/judge.md` implied that the smart tier "judges" or "sets direction before execution happens", which is misleading. In reality (see `processRoute` in `src/router.ts` and `SPEC.md` § 2.1), the LLM Judge is a small one-shot classification call in `before_agent_start`; the chosen tier then drives the **entire** agent run — all thinking, all tool calls, all message content. The smart model is not a judge that signs off; it is the model that actually does the complex work when the CTO role is chosen.
  - `README.md` / `README.zh-CN.md` TL;DR, What it does, and the role table
  - `SPEC.md` § 1 Core Value + § 2.2 Tiers table
  - `src/prompts/judge.md` opening paragraph, tier definitions, and Examples table
  - `AGENTS.md` Architecture Principle "Two tiers, not three" updated to reflect the role-not-judgment framing

### Documentation

- **Added "Recommended Model Pairings" section** to `README.md` and `README.zh-CN.md` — four patterns (token-plan bundles / local by VRAM / same-provider tier ladder / cross-provider pairing) that help users pick concrete fast / smart combos without prescribing provider-specific JSON. All model IDs verified against HuggingFace's `safetensors` total weight size + `models.dev` release dates on 2026-08.
- **Generalized absolute install paths** — replaced three hard-coded `/Users/greener/project/slimrouter` references in `README.md`, `README.zh-CN.md`, and `CONTRIBUTING.md` with the portable form `pi install <path-to-this-repo>`.
- **Added Hard-Stop rule to `AGENTS.md`** — the agent must NOT run `git push` or `npm publish` without explicit user approval in the same turn. "Commit" is local and reversible; "push" and "publish" are public and irreversible. The change came from a regression where the agent pushed without confirmation.

## [0.8.1] — Judge crash fix

### Fixed

- **Judge "Cannot read 'slice' of undefined" crash** — when an LLM endpoint returns HTTP 200 with an error-shaped body (no `choices[]`, which some OpenAI-compatible providers do for 429/5xx), `JSON.stringify(undefined)` returned the actual `undefined` value, which then crashed `content.slice(...)` in the verbose log. Wrapped all `.slice()` calls in a `jsonStr()` helper that returns the literal string `"undefined"` for `undefined` input. Regression tests added for "200 + error body" and "200 + empty choices" scenarios.
- **README badges restored** — TypeScript + Pi Agent badges removed in the earlier SEO pass are back. They signal language stack and that this is a pi-coding-agent extension.

## [0.8.0] — Token throughput + `/router stats` + Tuning Guide

### Added

- **Status bar shows tokens/sec** — when a message finishes streaming, the footer displays `[🧠 kimi-k3 • 23 tok/s]` based on `usage.output / elapsed_ms`. Hooked via `message_start` (records stream start timestamp) + `message_end` (computes throughput, pushes into a 5-sample sliding window).
- **`/router stats`** — new command showing:
  - window size + confidence distribution (high/mid/low/none buckets)
  - cumulative `↑upgrade` / `↓downgrade` counts
  - cumulative output tokens + current / average tokens-per-second
  - active cooldowns with remaining time
- **New pure module `src/stats.ts`** — `computeStats(state, config, now?)` for testable snapshots; `formatStats(state, config)` for the command output.
- **`RouterState` extended** with `totalOutputTokens`, `recentSpeeds`, `streamingStartTime`, `upgradeCount`, `downgradeCount`. Backwards-compatible defaults (zero).
- **Pure helpers in `src/failover.ts`**: `tokensPerSecond(output, elapsedMs)`, `recordSpeed(speeds, tps)` + `SPEED_WINDOW_SIZE = 5`. Unit-tested.
- **`formatTierDisplayWithSpeed(tier, modelId, tps)`** in `src/tier.ts` — drops the suffix when speed is 0.
- **Tuning Guide section** in both READMEs: workload-to-recommendation table, knob-by-knob explanation, sample `/router stats` reading guide.
- **14 new tests** (188 → 202): stats snapshot, confidence bucketing, speed helpers, status-bar formatting.

### Changed

- `processRoute` now increments `state.upgradeCount` / `state.downgradeCount` on tier transitions (for stats).
- `/router` autocomplete now includes `stats`.

### Fixed

- **Judge "Cannot read 'slice' of undefined" crash** — when an LLM endpoint returns HTTP 200 but with an error-shaped body (no `choices[]`, some custom OpenAI-compatible endpoints do this for 429/5xx), `JSON.stringify(undefined)` returned the actual `undefined` value, which then crashed `content.slice(...)` in the verbose log. Wrapped all `.slice()` calls in a `jsonStr()` helper that returns the literal string `"undefined"` for `undefined` input. Regression test added.

---

## [0.7.0] — Confidence-weighted sliding window

### Added

- **Confidence-weighted sliding window** — Judge now emits `{"tier":"...","confidence":0.0-1.0}` instead of just the tier. Entries whose confidence is below `routing.window.minConfidence` (default `0.5`) are ignored by the downgrade gate. The downgrade ratio is the **sum of confidences for fast entries / count of considered entries**, so a single low-confidence vote can't nudge the gate either way.
- **New config field** `routing.window.minConfidence` (default `0.5`). Entries below this threshold are skipped entirely. Set to `0` to restore pure-count behavior.
- **`JudgeResult.confidence?: number`** and **`WindowEntry.confidence?: number`** propagate confidence from the Judge through the window.
- **Judge prompt** now explicitly requests a `confidence` field with the rationale ("higher = clearer signal, low means mixed signals"). The strict `must appear on its own with no extra prose` wording is preserved.
- **12 new tests** (176 → 188): confidence parsing, weighted downgrade, low-confidence skip, threshold gating, default 1.0 for legacy entries, window-size cap interaction with confidence.

### Changed

- `routing.window.minConfidence` added to `DEFAULT_CONFIG.routing.window`.
- `analyzeDowngrade` now exported (was internal) for direct unit testing.
- `parseResponse` returns `ParsedJudgeResponse` (`{tier, confidence?}`) instead of bare `Tier`.

---

## [0.6.0] — Runtime failover (exponential backoff)

### Added

- **Runtime failover** (SPEC §8.5): when a model fails mid-turn with a
  transient provider error, the router takes over after pi's own retries
  give up.
  - `agent_end` hook inspects the transcript for a failover signature
    (429 / 5xx / `rate limit` / `quota` / `rate_limit_error` /
    `insufficient_quota` / `Token Plan` / `用量上限`), marks the model
    into exponential-backoff cooldown (1m, 2m, 4m, … capped at 30m),
    and immediately calls `setModel` to the next healthy model **in the
    same tier** — pi's pending retry then continues with the fallback.
  - Cooldown-aware selection in `before_agent_start` (`processRoute` and
    first-turn resolution) skips models in cooldown.
  - `after_provider_response` hook clears a model's cooldown on a 2xx
    response (immediate recovery).
  - **Judge uses the full fast-tier chain** — `resolveFastEndpoints()`
    resolves every fast model (priority order) and `classify()` walks it:
    a 429/5xx/timeout on the primary fast model falls back to the next
    one instead of giving up. The Judge shares the same cooldown map, so
    a model that fails the Judge is also skipped by routing.
  - `detectFailoverError` is signature-matching only (not a routing
    decision) — auth/config errors (400/401) never trigger failover.
  - `/route-force` (manual override) always bypasses cooldowns.
  - Toast notification on failover
    (`⚠️ M3 unavailable (429), switching to deepseek-v4-flash — retry in 1m`);
    `/router status` lists active cooldowns (`⏳ minimax/MiniMax-M3 — retry in 3m12s`).
  - New `src/failover.ts` module (pure functions, unit-tested):
    `markModelFailed`, `isModelInCooldown`, `clearModelCooldown`,
    `remainingCooldownMs`, `detectFailoverError`, `findFailoverModel`,
    `planTurnFailover`, `findTierForModel`.
- **56 new tests** (114 → 176): cooldown state machine, error signatures,
  same-tier fallback selection, turn-failure detection, cooldown-aware
  routing, manual-override bypass, tier reverse-lookup, Judge fast-chain
  fallback (429/5xx/timeout/unparseable), `resolveFastEndpoints` chain
  resolution.
- **`vitest.config.ts`**: sandbox-compatible worker pool (single-thread
  `threads`) + explicit `css: false`; added a valid empty `postcss.config.js`
  so vite stops searching parent directories.

### Changed

- `RouterState` gains `modelCooldowns: Map<string, CooldownEntry>`.
- `findBestModelForTier()` accepts an optional `isCooldown` predicate.
- `processRoute()` accepts an optional `now` parameter (testability).

## [0.5.0] — Multi-model fallback chain editor

### Added

- **Multi-model per tier with a hotkey-driven chain editor (TUI)** —
  `/router config <tier>` now opens a new in-TUI editor instead of single-model pick.
  - `a` add (opens the existing type-to-filter model picker)
  - `x` remove current
  - `K` / `J` swap current with previous / next (vim-style)
  - `d` save, `Esc` cancel
  - `↑↓` navigate, type-to-filter for adding
  - Schema already supported `models: ModelRef[]`; this surfaces the capability.
  - Non-TUI mode (non-interactive sessions) keeps the previous provider-grouped flow.
- **21 new tests** on chain-editor operations (59 → 80 total): add, remove,
  move-up, move-down, reassign-priorities, plus immutability and edge cases.

### Changed

- **License: Apache 2.0 → MIT** (more permissive for downstream use).
- **README.md + README.zh-CN.md:**
  - Tagline rewritten for SEO/GEO keywords (Pi coding agent, LLM judge,
    multi-model fallback, zero runtime deps).
  - JSON config example now shows multi-model per tier (priority array).
  - New **Fallback chains** subsection explaining chain semantics + hotkeys.
  - Module Map updated with `tui/fallback-chain-editor.ts`.
  - Roadmap updated: v0.4.0 / v0.4.1 marked shipped; v0.5.0 added.
- "How It Compares" table: removed `~$0.0006/call` pricing claim (kept neutral
  "a few thousand tokens per call") to comply with pricing-sensitivity guidelines.
- Chinese README: comparison-table "路由维度" column corrected from "复杂度"
  to "心智模式" (was inconsistent with the English version).
- Chinese README `命令` table: added `/route-force <provider>/<model>` variant.
- `scripts/pack-check.mjs`: dropped unused `typeImportPatterns` (LSP hint).

### Fixed

- **Judge prompt now respects user explicit intent about model quality.**
  When the user asks for "use the strongest model", "think carefully",
  "最强大模型", "仔细想想", or any equivalent phrasing in any language,
  the Judge classifies the turn as `smart` regardless of whether the
  underlying task is execution-heavy. Conversely, explicit asks for speed
  ("just give me a quick answer", "别想太多") route to `fast`. The prompt
  now lists four classification signals (task content, user intent,
  stakes/reversibility, ambiguity) with explicit conflict-resolution
  priority. This is implemented at the prompt level (LLM-as-classifier),
  not via regex/keyword matching, to keep the LLM as the sole classifier.
- **Chain editor reorder hotkey silently failed on many terminals.**
  The first attempt matched `data === "K"` (uppercase Shift+k), which only
  worked when the terminal emitted Shift+k as a literal `"K"`. The second
  attempt used the ANSI Shift+↑/↓ escape sequences (`\x1b[1;2A` /
  `\x1b[1;2B`), but macOS Terminal.app and several other terminals send
  the *same* sequence for Shift+↑ and plain ↑, so reorder still did not
  fire. Root cause: any modifier+arrow chord (Shift/Alt/Ctrl+arrow) is
  not portable across terminals. **Final fix: reorder now uses plain
  `J` / `K` keys** (vim-style: `k` = up, `j` = down) — no Shift needed,
  identical on every terminal, case-insensitive (`j`/`J`/`k`/`K` all
  work). Shift+↑↓ escape sequences are still accepted as a best-effort
  fallback where the terminal supports them. The J/K check runs before
  navigation (pi-tui's vim-mode may also bind j/k to select-up/down).
  Single-letter keys display uppercase (TUI convention) while remaining
  case-insensitive at the input layer.
- README's **Local install** section rewritten to avoid the
  `.pi/extensions/<name>.ts` symlink pattern — the original guidance caused
  duplicate plugin instances (`router:1` + `router:2`) when developing from a
  project directory that already contained the local bridge file alongside the
  npm-installed copy. New flow uses `pi install <path>` for dev iteration.
- Added README section **Releasing a new version** documenting the publish flow
  (npm version bump → prepublishOnly → publish → tag → push).

## [0.4.1] — 2026-08-16

### Fixed

- **`/router config` failed with `Cannot find package '@earendil-works/pi-coding-agent'`**
  when installed via `pi install npm:pi-shift-router` (the canonical install path).
  Three coupled mistakes caused the runtime failure:
  1. `@earendil-works/pi-coding-agent` was declared as `peerDependencies` (npm does
     not auto-install peer deps in pi's isolated extensions subtree).
  2. `src/tui/model-picker.ts` used a value-import for `getSelectListTheme`, so
     TypeScript compiled it into the runtime JS.
  3. Local development masked the bug because the `.pi/extensions/` bridge loads
     extensions through pi-agent's own loader, which has access to its host deps.
  Fix:
  - Move `@earendil-works/pi-coding-agent` from `peerDependencies` to `devDependencies`
    (runtime does not need it; only types do via `import type`).
  - Switch all pi-coding-agent imports to `import type`.
  - Reimplement `getSelectListTheme` locally using the `Theme` instance that
    `ctx.ui.custom()` injects as a factory parameter.

### Added

- **`pack:check` script** (`scripts/pack-check.mjs`) — a publish-state validator
  that catches the same class of bug above automatically. Checks: host packages
  are not in `dependencies`, compiled output contains no runtime value-imports of
  host packages, required files (README / LICENSE / CHANGELOG / dist/index.js /
  dist/prompts/judge.md) exist and are matched by `files`, `pi.extensions` paths
  resolve on disk, `engines.node` is declared. Wired into `prepublishOnly` and CI.

## [0.4.0] — 2026-08-15

### Added

- **Comprehensive unit test suite** (47 new tests): tier management, config validation,
  judge JSON parser. Total 59 tests covering the core algorithm and edge cases.
- **GitHub Actions CI** on Node 24 (matrix extensible). Runs typecheck, test, build,
  and a smoke check that `dist/` and `dist/prompts/judge.md` exist.
- **Chinese README** (`README.zh-CN.md`) with bilingual language navigation.
- **Troubleshooting section** in README: common Judge parse errors, missing models,
  aggressive downgrade threshold.

### Changed

- **Documentation overhaul**: AGENTS.md, PLAN.md, SPEC.md, README.md all rewritten
  in idiomatic English (was previously mixed Chinese/English). Adds TOC, Prerequisites,
  Install, Demo, Roadmap, Acknowledgements.
- **Project rename**: `pi-slim-router` → `pi-shift-router` (npm name, GitHub repo,
  internal identifiers, all references). The rename reflects the project's core
  "shift gears between execution and judgment" mental model.
- **Install instructions** updated to `pi install npm:pi-shift-router` (the actual
  pi package manager command), with link to pi's packages docs.
- **Pricing claims removed**: README no longer cites specific per-call cost numbers
  (varies by provider/time). Now uses qualitative "a few thousand tokens at your
  Fast-tier pricing".
- **Author attribution**: explicit credit to green-dalii in README.
- **`@earendil-works/pi-tui` moved from devDependencies to dependencies** because
  it is a runtime import (`src/tui/model-picker.ts`).

### Removed

- `typebox` from peerDependencies (was never used).
- Outdated references to three-tier architecture and heuristic Judge from docs.

## [0.3.1] — 2026-08-12

### Added

- **`routerLogVerbose` UX flag** — prints router decisions, judge calls, window state
  to console for advanced users. Toggle via `/router verbose`, `/router config` → UX
  settings, or directly in JSON.
- **Transient `⚖ judging…` status badge** — shown during the Judge API call so the
  user sees the router is working instead of a silent delay between message send and
  first response token. Restored via `try/finally`.

### Changed

- **Judge prompt asks for JSON**: `{"tier":"fast"}` or `{"tier":"smart"}`.
- **API-level JSON constraints** (hard, not just prompt):
  - OpenAI-compatible (DeepSeek, OpenAI): `response_format: { type: "json_object" }`.
  - Anthropic: assistant prefill `{"` to force JSON-start output.
- **`max_tokens: 200 → 4000`** to leave room for CoT reasoning on DeepSeek Reasoner-class
  models (whose `reasoning_content` is bounded by `max_tokens`).
- **`parseResponse` three-layer fallback**: JSON parse → loose JSON → bare keyword.
  Falls back from `content` to `reasoning_content` for CoT models.

### Fixed

- DeepSeek V4 Flash responses were returning `content:""` with `finish_reason:"length"`
  because `max_tokens:10` was too small for chain-of-thought. Now reliably returns
  valid JSON.

## [0.3.0] — 2026-08-09

### Changed (Breaking)

- **Three tiers → Two tiers**: `light`/`medium`/`flagship` → `fast` (🦾 programmer) / `smart` (🧠 CTO).
  Classification dimension changed from **task topic** (QA vs coding vs design) to **mental mode**
  (execution vs judgment). See SPEC §2.2 for the new framing.

- **`session_start` no longer calls `pi.setModel()`** — the router is now read-only at session start.
  It respects whatever model the user has configured in pi. Model switching only happens during
  `before_agent_start` when the routing decision demands it.

- **Config format flattened**: removed `judge.provider`/`judge.model`/`judge.timeout` (Judge always
  uses Fast tier's model). Removed `routing.upgrade` / `routing.downgrade.flagship` / `routing.downgrade.medium`
  / `routing.downgrade.maxWindowSize`. Replaced with `routing.window: { size, threshold }` and
  `routing.judgeTimeout`.

- `resolveJudgeEndpoint()` → `resolveFastEndpoint()`. Judge model = Fast tier's model.

### Added

- Proper CTO/Programmer framing throughout documentation — README, SPEC, AGENTS.

### Removed

- `classifyHeuristic()` — no more regex/keyword fallback. LLM Judge is the sole classifier.
  On failure, simply holds position (fast tier, no switch).
- `UpgradeConfig`, `DowngradeConfig`, `DowngradeTierConfig`, `JudgeConfig` interfaces.
- Light/Medium/Flagship tier references from all source files, config files, and tests.

### Tests

- Rewrote all 12 tests for two-tier: upgrade (fast→smart), downgrade (smart→fast with window),
  stay, window cap, manual override, judge fallback.
- Removed three-tier-specific tests (multi-step downgrades, cross-tier upgrade window cleanup).

## [0.2.0] — 2026-08-01

### Added

- **TUI model picker** (`src/tui/model-picker.ts`) matching pi's native `/model` UX: real-time fuzzy filtering, sliding 10-item viewport, scroll indicator, arrow keys / Enter / Esc. Built on `@earendil-works/pi-tui`'s `Container` + `Input` + `fuzzyFilter` primitives, following the same pattern as pi's `ModelSelectorComponent`.
- Provider-first wizard flow: pick provider → enter the new picker.
- Selected model (●) and judge model (⚖) indicators in the picker.

### Changed

- Wizard model selection now uses the TUI picker in interactive mode; non-TUI modes fall back to a flat list via `ctx.ui.select()`.
- Replaced `ctx.ui.textInput()` (does not exist) with `ctx.ui.input()`.
- Internal: `pickModel` now consumes the TUI picker factory; the legacy letter-index and pagination-button flows are removed.

### Dependencies

- `devDependencies`: added `@earendil-works/pi-tui@^0.81.0` for type definitions and local builds. At runtime the package is resolved through the host pi-coding-agent installation.

## [0.1.0] — 2026-07-23

### Added

- Initial release of Slim Router for pi-agent.
- Three-tier routing architecture: Flagship (🧠), Medium (🦾), Lightweight (⚡).
- Two-stage judge: LLM classification with heuristic fallback.
- Sliding window trend detection for upgrade/downgrade decisions.
- Interactive configuration wizard (`/router config`) with model selection.
- `/router` commands: on, off, status, quiet, config.
- `/route-force` command for manual model override.
- Status bar integration showing current tier and model.
- Automatic judge endpoint resolution from Light tier model.
- All tiers start empty — zero interference with pi default behavior.

### Changed

- License: MIT → Apache 2.0.
- Project documentation: README, CONTRIBUTING, SPEC, CHANGELOG.

### Removed

- Auto-assignment of models by price on first launch.
- Separate `/route-config` command (merged into `/router config`).
- Separate Judge model configuration (always uses Light tier's model).
- Multi-select model picker (replaced with single-select radio).
