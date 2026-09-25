# pi-shift-router — Pi-agent Intelligent Model Router

## 1. Overview

**pi-shift-router** is a [pi-agent](https://github.com/earendil-works/pi-coding-agent) extension that performs **cross-provider, cross-model intelligent routing**. On every turn it classifies the task's **mental mode** (execution vs judgment) and selects the best-fit model automatically.

**Project:** `pi-shift-router` (npm) · Repository: [green-dalii/pi-shift-router](https://github.com/green-dalii/pi-shift-router)

### Core Value

- **Quality**: complex, high-stakes, or irreversible work (planning, architecture, review, security audit) automatically uses the higher-intelligence model — the smart tier. When the task is complex, the smart model **drives the entire turn**: it writes the code, calls the tools, runs the loop, just at a higher intelligence level.
- **Cost**: everyday execution (well-defined tasks, established patterns) automatically uses the cheaper model — the fast tier. The fast tier is execution-heavy and covers the bulk of routine work.
- **Speed**: cheap models respond faster on execution tasks; strong models think more carefully on complex tasks.
- **Zero interference by default**: both tiers start empty. The router does nothing until you assign models via `/router config`.

### The CTO / Engineer Role

> **Smart = CTO** (small workload, critically important): when the work matters — direction-setting, course correction, result review, security audit, or a hard problem that needs doing right — the smart model acts as the CTO who drives the whole turn: it writes the code, calls the tools, runs the loop, at a higher intelligence level. High-stakes turns don't get dropped. It does not merely "judge"; it executes the entire turn at high intelligence.
>
> **Fast = Engineer** (large workload, well-defined patterns): when the path is clear, the fast model acts as the engineer who executes the whole turn — writing code, fixing bugs, adding tests, writing comments — cheap, fast, and accurate.

Not every task needs CTO-level intelligence. But projects without CTO oversight don't sustain quality. The LLM Judge is a small, one-shot classification call — the chosen tier then drives the entire agent run, including all thinking, tool calls, and message content.

---

## 2. Architecture

### 2.1 End-to-End Flow

```
User sends message
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  Pi-agent before_agent_start event                          │
│                                                              │
│  ┌─── pi-shift-router ──────────────────────────────────┐       │
│  │                                                    │       │
│  │  ① Status bar: "🧭 judging…" (transient)           │       │
│  │      ↓                                              │       │
│  │  ② LLM Judge (uses Fast tier's model, ~$0.0006/call) │       │
│  │      ↓                                              │       │
│  │  ③ processRoute()                                   │       │
│  │     ├─ judge→smart  & current=fast → UPGRADE (now)  │       │
│  │     ├─ judge→fast   & current=smart → check window  │       │
│  │     └─ otherwise                                STAY │       │
│  │      ↓                                              │       │
│  │  ④ pi.setModel() if switchTo                         │       │
│  │      ↓                                              │       │
│  │  ⑤ Status bar restored + optional toast              │       │
│  │                                                    │       │
│  └────────────────────────────────────────────────────┘       │
│                                                              │
│  Agent starts working                                        │
│  (multiple thinking + tool calls — model stays fixed)        │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

`before_agent_start` fires once per turn. The **model does not change during a turn**, even across multiple tool calls and thinking steps.

### 2.2 Tiers

| Tier | Role | What it does for the whole turn | Use Cases |
|------|------|------------------------------|-----------|
| **🧠 Smart (CTO)** | Judgment driver: direction-setting, correction, review, and hard problems handled personally — and when chosen, executes the entire turn at high intelligence | Architecture design, technology selection, code review, security audit, performance optimization, multi-step planning, any irrecoverable action. **Small workload, critically important.** |
| **🦾 Fast (Engineer)** | Execution driver: follows known patterns, drives the whole turn with the simpler model | Writing code, fixing bugs, adding tests, writing docs, adding comments, small refactors. **Large workload, well-defined patterns.** |

**Document & bulk work is Fast.** Document handling — reading, checking,
updating, formatting, translating, cross-doc consistency — and tedious
batches (mechanical replace, renaming, same edit across many files) are
`fast`: they follow established patterns and don't need frontier judgment.
Only **direction-setting** doc work escalates to `smart` — a new
design/architecture doc, or a review whose findings drive rework (e.g.
security). The Judge prompt carries this as explicit guidance + few-shots
(*“检查文档的更新修订” → fast*).

### 2.3 Transition Rules

Transitions are driven by an **expected-cost (EV) decision rule** over the Judge's
verdict + confidence — not by raw vote counting. The two error directions have
asymmetric cost: a wrong **downgrade** (fast fumbles a complex task) costs the
price-delta times a rework multiplier and is worse than a wrong **upgrade**
(simple task on smart, bounded extra spend). This asymmetry is encoded in a
single knob.

```
θ (smart bar) = 1 / economics.reworkPenalty      (default R=3 → θ≈0.33)

pSmart = confidence          if Judge says smart
       = 1 − confidence      if Judge says fast

if confidence < window.minConfidence  → hold (no signal, never switch)
else if pSmart ≥ θ                     → run smart
else                                   → run fast
```

| Direction | Condition | Rationale |
|-----------|-----------|-----------|
| **↑ fast → smart** | Single decisive smart decision (pSmart ≥ θ) | Upgrades cost only the price delta — cheap enough to act immediately on a confident-enough signal. An **uncertain fast verdict** (`pSmart ≥ θ`) also upgrades: not-sure-it's-simple leans smart because rework is pricier. |
| **↓ smart → fast** | `downgradeMemory` consecutive decisive fast decisions (default 2) + cache-aware idle gate | Downgrades are the expensive direction (rework risk + cache forfeit). Two independent judge agreements dampen noise; holds break the streak. |

Price cancels out of the rule: `θ = Δ/(Δ·R) = 1/R`, so no pricing lookup is
needed — `reworkPenalty` is the whole economics knob. When cache-aware routing
is active on the same provider family, the effective bar lowers (fewer
downgrades) to protect the warm prompt cache.

**Gear presets (`/router eco|default|sport`).** R is the only knob the presets touch:
`eco` (R=2, θ=0.5 — cheaper: only clearly-needed turns run smart),
`default` (R=3, θ≈0.33), `sport` (R=5, θ=0.2 — eager: any real chance
of needing Smart escalates). Recall θ = 1/R: higher R lowers the bar. The command sets
`economics.mode`, which is authoritative over a manual `reworkPenalty` (legacy
fallback); a legacy `window.threshold` still overrides both. The preset is
persisted to the config file, so a mode survives restarts.

---

### 2.4 Model Authority (Strict Takeover)

The router **owns model selection** while enabled. The model on the wire must
match the routed tier's chain — a tier label without model enforcement is
fiction (a `fast` decision running on a smart-tier model is a price/behavior
mismatch).

- Every `before_agent_start`, after the routing decision, the router guarantees:
  the active model = best available model (priority order, cooldown-aware) of
  the **running tier** (the tier the turn actually executes on, after any
  upgrade/downgrade). If the current model differs → `setModel`; if it is
  already that model → no-op (no redundant `setModel`).
- `session_start` remains read-only (no `setModel`); the first takeover happens
  during the first turn's `before_agent_start`.
- `/model` (native picker) is overridden at the next routing point: the model
  the user picked runs for the current turn, then the router re-asserts the
  tier chain. Restoring fully native `/model` behavior = `/router off`.
- Persistent manual overrides are the explicit escape hatches:
  `/router smart` / `/router fast` (manual override for the session, bypasses
  takeover) and `/router off` (router disabled entirely → native model control).

---

## 3. Sliding Window Trend Detection

### 3.1 Design Principle

Two-tier design reduces the window problem to a single question: **when is it safe to drop from smart back to fast?**

- Upgrades are always immediate — no window needed.
- Downgrades require trend confirmation, to prevent a single "ok" / "thanks" from triggering an unnecessary model switch.

### 3.2 Window

```
Window size = config.routing.window.size           (default 5, history cap)
minConfidence = config.routing.window.minConfidence (default 0.5)
downgradeMemory = config.routing.economics.downgradeMemory (default 2)

Per-turn decision (EV rule, see §2.3):
  pSmart = c (smart) or 1−c (fast); θ = 1 / economics.reworkPenalty
  confidence < minConfidence → hold (no signal, no switch, breaks fast streak)
  pSmart ≥ θ → smart; else fast

Downgrade condition (smart → fast):
  trailing decisive entries are all fast AND count ≥ downgradeMemory
  AND downgradeAllowedAt(state, config)  (cache-aware idle gate)

Window lifecycle:
  - Each processRoute pushes a decisive entry (hold entries also pushed, marked).
  - When size is exceeded, the oldest entries are discarded.
  - On upgrade, the window is cleared.
```

`window.threshold` (legacy) — **smooth migration:** the old default `0.6` is
dead (configs carrying it fall back to `θ = 1/reworkPenalty`); only a value
that differs from `0.6` acts as a raw θ override. Prefer `economics.reworkPenalty`.
`cacheAware.sameFamilyThreshold` (legacy) is superseded by
`cacheAware.sameFamilyPenalty` (multiplier on reworkPenalty); the old default
`0.9` is dead too — only a differing value implies the strong default 3.0.
Migrated-away legacy knobs are surfaced in `/router status` when a non-default
value is still active.

### 3.3 Worked Example

```
Initial: Fast

t1: "Write a sort function"           Judge→fast   stay Fast     window=[fast]
t2: "Design the auth architecture"    Judge→smart  upgrade Smart  window=[] (cleared)
t3: "Add the auth to the routes"      Judge→fast   stay Smart    window=[fast]
t4: "Add comments"                    Judge→fast   stay Smart    window=[fast, fast]
t5: "Write unit tests"                Judge→fast   DOWNGRADE Fast window=[fast, fast, fast]  (3/5 ≥ 60%)
t6: "Is this approach correct?"       Judge→smart  upgrade Smart  window=[] (cleared)
```

---

## 4. LLM Judge

### 4.1 Why an LLM Judge

- **Semantic understanding**: regex can't distinguish "design this payment system's architecture" from "what's the weather".
- **Multi-lingual out of the box**: one prompt serves Chinese, English, Japanese, etc.
- **Zero maintenance**: change the prompt to change behavior — no code changes.
- **Cost is negligible**: with Fast tier models at ~$0.15/M tokens, a 4K-token judge call is ~$0.0006.

### 4.2 Judge Prompt

The Judge classifies by **mental mode**, not topic. The prompt lives in [`src/prompts/judge.md`](src/prompts/judge.md) and is loaded at module init.

**Output format (enforced at API level):** the Judge must respond with valid JSON:

```json
{"tier": "fast"}
```

or

```json
{"tier": "smart"}
```

The prompt explicitly requests JSON-only output, and the API call adds a hard constraint:
- **OpenAI-compatible** (DeepSeek, OpenAI, etc.): `response_format: { type: "json_object" }` — the API rejects non-JSON completions.
- **Anthropic**: assistant message prefill of `{` — forces the model to start its response with the JSON opener.

The prompt classifies by **task shape**, not topic. Review-type tasks are split by what the turn actually does: a review whose findings set direction or drive rework is `smart`; a quick observation that leads straight into a routine fix with a clear path ("this separator is selectable, remove it") is `fast`. Security review is never downgraded, and explicit user intent for depth (signal 2) always wins.

### 4.3 Judge Model Selection

The Judge uses the **Fast tier's first model**:

1. Primary: `config.tiers.fast.models[0]` — the user-chosen execution model, usually the cheapest.
2. Fallback: any model with a valid API key (cheapest first).

**Why use the Fast model for judging?**

- The Fast model may be optimized for execution, but **classification is far simpler than code generation**. DeepSeek V4 Flash / Claude Sonnet handle the binary split reliably.
- Cost gap is enormous (Smart at $15/M vs Fast at $0.15/M ≈ 100×). Using Smart for judging would defeat the routing purpose.
- Avoids a circularity: "use the most expensive model to decide when to use the most expensive model."

### 4.4 API Call

The Judge calls the provider API directly (not through pi's agent loop):

```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), config.routing.judgeTimeout); // 5s default
const result = await fetch(url, { /* headers + body */, signal: controller.signal });
clearTimeout(timer);
```

Both OpenAI-compatible (`/chat/completions`) and Anthropic (`/v1/messages`) API formats are supported. `max_tokens: 4000` leaves enough room for chain-of-thought reasoning on DeepSeek Reasoner-class models.

### 4.5 Parse Strategy

`parseResponse()` uses a three-layer fallback:

1. **JSON parse**: matches `{"tier":"fast"}` or `{"tier":"smart"}` anywhere in the response.
2. **Loose JSON**: tolerates missing quotes (`{tier:fast}`).
3. **Bare keyword**: extracts the first occurrence of `fast` or `smart`.

For CoT models (e.g., DeepSeek Reasoner) that emit a separate `reasoning_content` field, the parser first tries `content`, then falls back to `reasoning_content`.

### 4.6 Judge Failure Fallback

There is **no heuristic rule** as a fallback — no keyword list, no scoring rule. A
judge call produces either a measured verdict or nothing, and "nothing" is never
converted into a tier guess.

Two mechanisms handle failure, both specified in one place elsewhere:

- **Which endpoint is asked** — the availability ladder (§8.6): the configured
  judge chain, then the LLM judge, then no routing at all.
- **Which endpoint is skipped next time** — a call that fails with a *failover
  signature* (HTTP 429/5xx, or a body carrying rate-limit / usage-limit / quota /
  `rate_limit_error`) writes the model into the shared `modelCooldowns` map via
  `onFailure`, so the next call skips it instead of re-burning the error
  (§8.5.5). Network errors, timeouts and auth failures do **not** cool a model:
  they are not failover signatures, and cooling on them would over-block the turn
  path (§8.5.3).

---

## 5. Configuration System

### 5.1 Config File Locations

| Layer | Path | Priority | Use |
|-------|------|----------|-----|
| Default | `DEFAULT_CONFIG` in `types.ts` | Lowest | Code-embedded defaults |
| User | `~/.pi/agent/pi-shift-router.json` | Medium | Personal preferences, not git-tracked |
| Project | `<cwd>/.pi/pi-shift-router.json` | **Highest** | Team-shared, git-tracked |

**Load order:** defaults ← user ← project (project wins on conflict).

### 5.2 Config Structure

```typescript
interface ShiftRouterConfig {
  enabled: boolean;
  tiers: {
    fast:  TierConfig;   // execution model
    smart: TierConfig;   // judgment model
  };
  routing: {
    mode: "auto" | "manual" | "off";
    judgeTimeout: number;                                  // ms, default 5000
    judge?: {                                              // v1.7.0, additive
      mode: "fast-chain" | "custom" | "decision";          // default "fast-chain"
      models?: ModelRef[];                                 // used by custom + decision
    };
    window: { size: number; minConfidence: number; threshold?: number };
                                                            // size 5, minConfidence 0.5;
                                                            // threshold LEGACY (0.6 = dead)
    economics: { reworkPenalty: number; downgradeMemory: number; mode?: "eco" | "default" | "sport" };
                                                            // R default 3 (θ = 1/R); mode
                                                            // preset authoritative when set
    effort?: {                                              // proposed v1.8.0 — semantics in §9.5
      enabled: boolean;                                     // default false ⇒ router never sets a level
      band: number;                                         // marginal band on |pSmart − θ|
      static?: { fast?: ThinkingLevel; smart?: ThinkingLevel };
                                                            // pin any supported level, unaffected by the band
      dynamic?: { fast?: "up" | "off"; smart?: "down" | "off" };
                                                            // direction permission; one notch, never more
    };
  };
  ux: {
    quietMode: boolean;
    statusBar: boolean;
    inlineToast: boolean;
    routerLogVerbose: boolean;
  };
}
```

### 5.3 Validation

`validateConfig()` issues warnings only — never blocks startup:

| Case | Action |
|------|--------|
| Empty tier | No warning (empty tier means that tier simply isn't routed) |
| Provider missing | Warning |
| Model missing in provider | Warning |
| Both tiers identical | Warning (routing becomes a no-op) |

### 5.4 Model Catalog Sources

**The catalog source is pi's own model registry** (`ctx.modelRegistry`, the
public extension API) — the same list `/model` shows:

| Source | Role | Auth semantics |
|--------|------|----------------|
| `ctx.modelRegistry.getAvailable()` | **Primary** — every model of every provider pi has configured auth for (`AuthStatus.source` ∈ `stored` / `environment` / `models_json_key` / `models_json_command` / `runtime` / `fallback`) | pi's own `checkAuth` |
| `~/.pi/agent/models-store.json` + `models.json` | **Fallback** — used only when no registry is available (headless invocations, unit tests), and for pricing when the registry has none | `auth.json` key, else inline `apiKey` with env expansion |

`src/model-source.ts` is the single entry point (`listAvailableModels`,
`isProviderAvailable`, `modelPricingFor`, `refreshRegistry`). Rationale: the
registry-first path removes the drift that made the wizard show a *different,
smaller* list than `/model` — measured on one machine as 5 providers / 413
models (store) versus 39 providers / 1354 (pi's catalog), with 13 openrouter and
2 deepseek models existing only in pi's copy, plus providers whose credentials
(env vars, `models_json_command`, runtime login) the local auth heuristic cannot
see. `/router config` calls `refreshRegistry()` first so a just-edited
`models.json` is reflected.

Model *resolution* (which concrete provider/model a tier runs) has always gone
through `ctx.modelRegistry.find()`; the catalog/reporting surfaces listed above
now use the same source, so listing and resolution can no longer disagree.

Custom provider entries may set provider-level `baseUrl`, `api`, and `apiKey`; custom models are upserted by `id`. `apiKey` supports pi env-var expansion (`$VAR` / `${VAR}`, `$$` → `$`, `$!` → `!`). Variable names must start with a letter or underscore (POSIX env-var convention); patterns like `$1` or `$5` are preserved literally to avoid silent API-key truncation. Shell commands (`!cmd`) are resolved by pi at request time and are not available to the router, so such providers are skipped unless `auth.json` has a key — which always wins over an inline `apiKey`.

**Resolution order for `apiKey`** (see `resolveFastEndpoints` in `src/config.ts`):

1. `auth.json[<provider>].key` (raw, verbatim) — always wins.
2. Inline `apiKey` from `models.json` after env expansion — used only if `auth.json` has no entry.
3. If neither resolves, the provider is skipped.

**`baseUrl` resolution order** (for `ProviderEndpoint.baseUrl`):

1. `modelInfo.baseUrl` (per-model, from `models-store.json` or `models.json`)
2. `provEntry.baseUrl` (per-provider)
3. `""` (empty string — caller must reject)

Trailing slashes are trimmed.

**Cheapest-fallback eligibility** (used when the user's fast tier is empty or all models fail auth — see §4.3 step 2):

The cheapest-fallback pool includes **all providers** that have a valid API key — whether from `auth.json` or from an env-expanded inline `apiKey` in `models.json`. Cost is measured by `cost.input` (USD per 1M tokens). The cheapest model wins; **`defaultModel` from `settings.json` is NOT consulted in this path** — users who want to protect their default-model preference must configure the fast tier explicitly rather than leaving it empty.

**Cache invalidation**: `loadModelsStore()` caches the merged store in module-local state. The cache is invalidated in two places:

- **Decision endpoints are judge-only.** `chatCapableModels()` removes
  `typesafe-decisions` entries from the Fast/Smart pickers: pi has no streaming
  implementation for that api value, so a decision model chosen as a tier would
  fail at stream time on every turn.
- **At the entry of `/router config`** — the wizard always re-reads `models-store.json` and `models.json` from disk so the picker shows the current catalog, not a startup snapshot (avoids the stale-list bug: providers may have been added or removed since pi started).
- **In `invalidateConfigCache()`** — when the user saves config via `/router config` or `saveConfig()`, the merged-store cache is also cleared so the next read reflects current disk state.

`models-store.json` is owned by pi-agent; the router's invalidation only affects the fallback read path. With a registry present the picker mirrors pi's live registry, so edits to `models.json` show up after `refreshRegistry()` without a pi restart.

`_authStore` is never invalidated by the router — it reflects pi-agent's own auth state.

---

## 6. Commands

### 6.1 Command Reference

| Command | Function |
|---------|----------|
| `/router status` | Open the status dashboard (TUI panel): live model, last decision, money, chains with cooldowns, health, config layer |
| `/router on` | Enable routing |
| `/router off` | Disable routing — pi falls back to its default model |
| `/router config` | Open the interactive configuration wizard (TUI) |
| `/router quiet` | Toggle inline toast notifications |
| `/router verbose` | Toggle verbose logging to console (for advanced debugging) |
| `/route-force <tier\|model>` | Manually override the next turn's model |

### 6.2 `/router status` Output (TUI dashboard)

`/router status` opens a blocking, theme-colored TUI panel (q / Esc closes).
Sections, top-down by question: live state → last decision → money → chains
→ health → how routing decides (plain language) → config layer. Per-model
gauges: context-window usage (bar turns warning >80%) and cache hit rate
(`cacheRead / (input + cacheRead)`, session-cumulative for the live tier;
`n/a` when the provider reports nothing). Cooldowns render inline on the
matching chain entry (⏳ + countdown); the running entry is marked `← live`;
tier badges sit on their own line above each chain.

```
pi-shift-router v1.4.2 — routing ON (auto)
Now: 🧠 commandcode/deepseek/deepseek-v4-flash
  Context  ▓▓▓░░░░░░░  19% · 38.2k / 200.0k
  Cache hit 84%  (12.4k of 14.8k prompt tokens from cache)
Last: judge smart (conf 0.95) → ↑ upgrade to Smart — "explicit smart request"

Money · this session
  saved   $0.155 of $0.210  (74%)  vs all-smart: …
  spent   $0.055  fast ▓░░░░░░░░░ 6% · smart ▓▓▓▓▓▓▓▓▓▓ 94%
  speed   125 tok/s (avg 98) · 45.2k tokens

Chains (priority ↓ · price per Mtok in)
  🦾 Fast
     1  minimax-cn/MiniMax-M3  $0.28/M
     2  commandcode/deepseek/deepseek-v4-flash  $0.11/M ⏳3m12s
  🧠 Smart
     1  commandcode/deepseek/deepseek-v4-flash  $0.11/M ← live

Health
  judge 🧭 minimax-cn/MiniMax-M3 · cooldowns: 1
  recent turns  ●●●●●   ● smart · ● fast
  orchestration: 🪄 auto, idle · audit: ✓ clean (LLM pass)

How routing decides
  Gear: default — a turn goes to Smart when the judge is at least 22%
  confident; back to Fast after 2 straight fast turns. Cache-aware is on:
  switching within the same model family keeps your prompt cache warm.

Config: project (/proj/.pi/pi-shift-router.json) — user layer merged underneath
```

### 6.3 Manual Override

`/route-force fast` | `/route-force smart` | `/route-force provider/model`:

- Forces the specified model/tier for **one turn**.
- Auto-clears after `before_agent_start` completes.
- Use cases: temporary need for a specific intelligence level, debugging.

---

## 7. UX Design

### 7.1 Core Principle

> The user should only be notified when the routing state **changes**.

| Situation | Notify? | Why |
|-----------|---------|-----|
| **Upgrade** (fast → smart) | ✅ Yes | User should know the model upgraded for a complex task |
| **Downgrade** (smart → fast) | ✅ Yes | Cost optimization, user should perceive |
| **Stay** | ❌ No | "Same as before" carries no information |

### 7.2 Three-Channel Notification

| Channel | Location | Content | Behavior |
|---------|----------|---------|----------|
| **Status Bar** (persistent) | Bottom footer | `[🧠 kimi-k3]` | Always visible. User can glance. |
| **Inline Toast** (on change) | Message stream | `[🧠 kimi-k3]` | Appears on tier change, non-intrusive |
| **Detail View** (on demand) | `/router status` | Full state | User queries explicitly |

### 7.3 Transient Judging Indicator

While the Judge API call is in flight, the status bar shows **`🧭 judging…`** instead of the current model badge. This gives the user feedback that the router is working during the 200ms–2s Judge latency, instead of a silent delay between "press enter" and "first token streams".

The indicator is restored via `try/finally`, so even if `classify()` throws, the status bar returns to its normal state.

### 7.4 Quiet Mode

`/router quiet` or the UX settings toggle suppresses inline toast. Status bar still shows the current model. For users sensitive to notifications.

### 7.5 Verbose Logging

For advanced users debugging routing decisions:

- Toggle: `/router verbose`, `/router config` → UX settings, or directly in JSON (`ux.routerLogVerbose: true`)
- Output: prints prompt preview, judge call details (URL, raw response), decision, and model switch result on every turn.
- Output destination: console (visible when running pi in a terminal).

### 7.6 TUI Model Picker (Wizard)

**Indicator vocabulary — one idiom per semantics, never mixed on a row.**

| Row kind | Glyphs | Reads as |
|----------|--------|----------|
| Exclusive picker (provider, Judge mode) | `●` current / `○` other | "exactly one of these is chosen" (radio) |
| Independent toggle (UX settings, cache-aware) | `☑` on / `☐` off | "this row is on/off by itself" (checkbox) |
| Action row (Done, Back, Save) | none | — |

Unifying everything on `●`/`○` was considered and **rejected**: the toggle menus
allow all-on, all-off and every combination, so a filled circle would read as
"the selected one" (radio semantics) and five filled circles wipe out the
"which is current?" signal. The evidence points the same way: pi's UI documents
`●` as a status *indicator* and its official extension example marks item state
with `☑`/`☐`.

What *was* the real inconsistency is the `✔`-suffix style (a second glyph pair
for the same "current item" meaning as `●`) — that is gone. Toggle menus name
their glyphs in the title (``(☑ on · ☐ off)``) because a bare box is easy to
misread. Rows are produced by `toggleRow()` / `judgeModeOptions()` so a new menu
cannot invent a third style, and tests assert the two idioms stay separate.

`/router config`'s model selection step uses **pi's own model registry** (SPEC §5.4), so the list is the same set `/model` offers — not a locally re-derived catalog. UX:

- `Input` (search box) + 10-item viewport list, all events routed by a `ModelPickerComponent` container (implements `Focusable`).
- Type-to-filter via `fuzzyFilter` from pi-tui.
- Up/Down navigation, Enter to confirm, Esc to cancel.

**Implementation:** `src/tui/model-picker.ts`, built on `@earendil-works/pi-tui`.

**Non-TUI modes:** automatically falls back to `ctx.ui.select()` flat list with full `${provider}/${model}` keys in labels.

---

## 8. Implementation Status

| Phase | Status | Version | Notes |
|-------|--------|---------|-------|
| SPEC authoring | ✅ | — | Initial SPEC written |
| Project bootstrap (tsconfig, package.json, build) | ✅ | v0.1.0 | TypeScript strict mode, vitest |
| Config system (load/validate/cache) | ✅ | v0.1.0 | User + project layers |
| Tier management (model lookup, priority) | ✅ | v0.1.0 | `findBestModelForTier()` |
| LLM Judge (direct API call) | ✅ | v0.1.0 | Originally heuristic + LLM |
| Sliding window algorithm | ✅ | v0.1.0 | Three-tier version |
| pi-agent lifecycle integration | ✅ | v0.1.0 | `session_start` + `before_agent_start` |
| TUI model picker | ✅ | v0.2.0 | Mirrors pi's `/model` UX |
| Provider-first wizard flow | ✅ | v0.2.0 | Pick provider → pick model |
| Two-tier redesign (CTO / Programmer) | ✅ | v0.3.0 | Removed `light`/`medium`/`flagship` |
| Judge JSON-mode enforcement | ✅ | v0.3.1 | API-level hard constraints |
| Transient judging indicator | ✅ | v0.3.1 | Status bar `⚖ judging…` |
| Verbose logging | ✅ | v0.3.1 | `ux.routerLogVerbose` |
| **Publish to npm** | ✅ | v0.4.0 | First release |
| Runtime `Cannot find package` fix + `pack:check` guard | ✅ | v0.4.1 | npm install path |
| Multi-model fallback chain editor (TUI) | ✅ | v0.5.0 | Hotkey add/remove/reorder |
| Judge respects user explicit intent | ✅ | v0.5.0 | 4-signal prompt |
| **Runtime failover (exponential backoff)** | ✅ | v0.6.0 | See §8.5; 4xx/5xx split + 6h cap refined in v0.9.0 |
| Confidence-weighted sliding window | ✅ | v0.7.0 | `minConfidence` gate, weighted downgrade ratio |
| Token throughput + `/router status` + Tuning Guide | ✅ | v0.8.0 | `src/stats.ts`, 5-sample speed window |
| Judge cooldown sharing (429 no longer re-hit) | ✅ | v0.8.3 | `classify()` `onFailure` callback → `markModelFailed` |
| **Cost telemetry — deep view** | ✅ | v0.9.0 | Per-tier spend + savings baseline; SPEC §9.1 |
| Cooldown backoff rescale (4×, 6h cap, 4xx/5xx split) | ✅ | v0.9.0 | §8.5.2; 4xx starts at 16m, 5xx at 1m |
| Slogan + CTO/Engineer terminology unification | ✅ | v0.9.1 | Docs, SPEC, judge prompt, tests |
| **Coverage reporting (≥90% on router/failover)** | ✅ | v0.9.x (dev) | `vitest --coverage` in CI; router 100% / failover 95.5% |
| **Cache-aware routing** | ✅ | v0.10.0 | §9.2: same-family threshold raise + warm-cache downgrade suppression |

### 8.5 Runtime Failover (Exponential Backoff)

**Problem**: when the active model returns a rate-limit / server error (429,
5xx), pi-agent retries internally (provider layer ×3, then agent layer ×3)
and eventually fails with `Error: Retry failed after 3 attempts`. The router
currently has no hook into this, so the user sees the error instead of a
fallback model taking over.

**Design goal**: use pi's own retry machinery for the primary model, then
have the router take over with the next model in the tier's chain when pi's
retries are exhausted.

### 8.5.1 pi-agent retry layering (verified against source)

| Layer | Trigger | Behavior | Router intervention |
|-------|---------|----------|---------------------|
| L1 provider | `retryProviderRequest()` sees 429/5xx | exponential backoff, default 3× | None — `after_provider_response` fires only on success (429 is caught and retried internally) |
| L2 agent | `agent_end` → `_prepareRetry()` | backoff → `agent.continue()` using current `this._state.model` | `agent_end` hook can `pi.setModel(fallback)` → next continue uses it |
| L3 next turn | user sends new message | `before_agent_start` runs | Cooldown-aware model selection |

### 8.5.2 Core mechanism

1. **`agent_end` hook**: inspect the last assistant message (`errorMessage`,
   `stopReason === "error"`). If it matches a failover signature (429, 5xx,
   rate limit / quota exhausted), mark the current model into cooldown and
   immediately `pi.setModel(next available model in the same tier)`.
   pi's pending `agent.continue()` then retries the turn with the fallback
   model — **immediate failover within the same turn**. No cross-tier fallback.
2. **Cooldown state**: `RouterState.modelCooldowns: Map<string, { until: number; attempts: number }>`
   keyed by `provider/model`. `until` grows exponentially with multiplier 4:
   `backoffMs = BASE * 4^(attempts-1)` where `BASE = 60_000` (1 min), capped at
   **6 hours** (`COOLDOWN_MAX_MS`). Each new failure of the same model
   quadruples the wait: 1m → 4m → 16m → 1h4m → 4h16m → 6h(cap).
   The 6h cap is sized for hour-scale coding-plan rate windows (~5h),
   not per-minute RPM limits — a 30m cap caused repeated 429 re-hits
   throughout the window. Escalation persists across natural expiry: when a
   model thaws (its `until` passes) and fails again, `attempts` continues
   from the previous tier rather than resetting.
   **4xx vs 5xx**: a failover-worthy **4xx** (429 rate limit / quota — a
   client-side limit) skips the first two tiers and starts at 16m
   (`COOLDOWN_START_ATTEMPTS_4XX = 3`), because client limits usually
   outlive server blips — probing at 1m/4m wastes calls. **5xx** keeps the
   1m start for fast recovery. `markModelFailed(…, code)` derives the
   start tier from the failover signature; both paths share the same cap.
3. **`before_agent_start` cooldown-aware selection**: `findBestModelForTier()`
   accepts an `isCooldown(key)` predicate and skips models currently in
   cooldown, picking the next healthy model in the chain.
4. **Recovery**: `after_provider_response` with `status` 2xx clears the
   cooldown for the responding model (it works again). Cooldowns are
   session-scoped; a session restart resets all.
5. **Judge-side writes**: the Judge's `classify()` loop writes failed
   models into the same map via an `onFailure` callback, so the next
   Judge call (and the next turn-path `findBestModelForTier`) skips them.
   Without this, a rate-limited fast model would be re-hit by every Judge
   invocation until a full turn failed — and if the Judge happens to pick
   `smart` that turn, the failure never happens and the model stays
   uncooled indefinitely. Only failover signatures (429/5xx/quota) write
   to the map; network errors, timeouts, auth errors, and unparseable
   responses do not cool down (they are not failover signatures, see §8.5.3).

**Judge endpoint resolution (registry-first, v1.6.0).** `resolveFastEndpoints()`
prefers `ctx.modelRegistry.find()` + `getApiKeyForProvider()` over the local
store, so a Judge endpoint may live on a provider authenticated through env
vars / `models_json_command` / runtime login even when it is absent from
`models-store.json`; the cheapest-fallback pool is likewise drawn from
`getAvailable()`. Without a registry (headless, tests) the store + `auth.json`
path is used unchanged. See §5.4.

### 8.5.3 Failover signatures

- **Trigger cooldown**: HTTP 429, 402, 5xx (500/502/503/504); body containing
  `rate limit`, `usage limit` / `usage_limit_reached` (Codex
  subscription-exhaustion wording), `quota`, `rate_limit_error`, `insufficient_quota`,
  `insufficient balance` / `余额不足` (402 billing-exhausted — e.g.
  OpenRouter-style "Insufficient Balance" wrapped in `Error: 402: {…}`).
  The 4xx bucket (429 + 402) inherits the longer 16m backoff start because
  both are client-side limits (rate window / account balance) that
  typically outlive server-side blips; 5xx keeps the 1m start.
- **Do NOT trigger**: 400 (invalid request — config error, not transient),
  401 (auth — user must fix credentials), 403 (permission — user/role
  fix, not transient), network/timeout errors, unparseable responses.

### 8.5.4 User-visible feedback

On failover, show a toast notification (unless `quietMode`):
`⚠️ <model> unavailable (429), switching to <fallback> — retry in Ns`.
`/router status` inlines cooldowns onto the matching chain entry
(warning-colored, with the countdown):
`2 commandcode/deepseek/deepseek-v4-flash $0.11/M ⏳3m12s`.

### 8.5.5 Edge cases

- All models in a tier are in cooldown → keep current model (do not guess
  across tiers), surface a warning toast.
- Manual override (`/route-force`) bypasses cooldown (user explicitly asked).
- A 2xx success for a model in cooldown clears it immediately (recovery).

### 8.6 Judge Modes and Protocols (v1.7.0)

The Judge is a high-frequency, latency- and cost-sensitive classifier whose
output is **thresholded** (`pSmart >= θ`, §2.3). The LLM judge stays the
default; two more modes were added without changing it.

`routing.judge.mode` selects where the Judge chain comes from:

| Mode | Chain source | Notes |
|------|--------------|-------|
| `fast-chain` (default) | `tiers.fast.models` | Byte-identical to pre-v1.7.0 behaviour. Absent `routing.judge` ⇒ this mode. Cheapest-authenticated-model fallback applies (§4.3 step 2). |
| `custom` | `routing.judge.models` | A dedicated Judge LLM chain (same chain-editor UX as Fast/Smart). No cheapest-model fallback: an unresolvable chain **holds position**. |
| `decision` | `routing.judge.models` (decision-capable endpoints) | Typed-answer models (Jev / System One class). No cheapest-model fallback; failures **hold**. |

**Decision protocol (`apiType: "typesafe-decisions"`).** `POST {baseUrl}/v1/systemone`,
Bearer auth, one round trip for all questions:

```jsonc
{
  "model": "<model id>",
  "state": "<recent messages, assembled like the LLM judge prompt>",
  "questions": {
    "tier":        { "type": "choice", "instructions": "<rubric>",
                     "criteria": { "fast": "…", "smart": "…" } },
    "orchestrate": { "type": "noul", "instructions": "…",
                     "criteria": { "true": "…", "false": "…" } }
  }
}
```

Response mapping (tolerant — accept an `answers` envelope or a bare top-level
map):

- `tier = questions.tier.choice` (must be one of the declared options, else hold)
- `confidence = questions.tier.probabilities[tier] ?? questions.tier.confidence`
  — a **calibrated probability**, not an elicited LLM confidence. `reason` is
  absent by design (decision models do not generate prose; the dashboard omits it).
- `orchestrate = questions.orchestrate.noul >= 0.5` (Noul returns 0–1, no confidence field)

Failover/cooldown machinery is protocol-agnostic and unchanged (§8.5): a
failover signature cools the endpoint; anything else holds.

**Mode semantics.** `JudgeResult.source` records `"llm"` for `fast-chain`/`custom`
and `"decision"` for decision endpoints (telemetry/logs; the routing algorithm
treats both as measured signal). **θ is deliberately untouched by this feature**:
switching to calibrated probabilities changes the confidence distribution, so
thresholds (§2.3) must be re-derived from measured data in the follow-up
routing-asymmetry work — see MEMORY.md.

**Mode precedence: the LLM judge is the default path, Jev is opt-in Beta
(v1.7.0).** The wizard orders the modes so the legacy behaviour leads and the
unproven option comes last:

| Order | Row | Status |
|-------|-----|--------|
| 1 | `🦾 Reuse the Fast tier chain (default)` | the pre-v1.7.0 behaviour (default config value) |
| 2 | `🔬 Dedicated Judge LLM chain` | opt-in, same machinery as the default |
| 3 | `🧮 Jev — decision model (Beta)` | **public beta**: limited independent validation, provider capacity still ramping |

`JUDGE_MODE_ORDER` maps rows to modes, so presentation and dispatch stay
independent. Jev is deliberately **not** a first-class judge: it is a decision
model in public beta, its `confidence` is a rescaling of the top probability
rather than a calibration claim, and a September 2026 evaluation found decision
models trailing the per-task best LLM on 14 of 15 annotation tasks. Making it the
default or the first row would push an unproven model class onto users who never
asked for it; the honest presentation is "third, labelled Beta, with a fallback
that always works". The default config value remains `fast-chain`, so no upgrade
silently re-judges anyone with a different model class.

**Unusable judge config degrades, it does not stall.** When a `custom` or
`decision` chain resolves to zero endpoints — the model was retired, the key was
removed, the provider disappeared — `resolveJudgeEndpoints()` falls back to the
LLM judge (the Fast chain, i.e. the pre-v1.7.0 default) and **always logs the
degradation**. Rationale: this is not the "cheapest authenticated model"
substitution we rejected — it is a chain the user configured, and a rotted judge
config must not hold every turn forever. The boundary stays sharp elsewhere:
per-call failures (timeout, 5xx, malformed answer) still **hold**, because those
are transient rather than config rot, and a verdict is still never fabricated.
The wizard says which judge is actually in effect (`Jev unavailable — LLM judge
active`), and the setup screen states that routing continues meanwhile.

**Model id policy: alias by default, and make moves visible.** The Judge is
configured with `jev-latest`, not a pinned build. Rationale: a pin fails the worst
way (the day the vendor retires that build the Judge stops working and the router
holds forever until a human edits config), whereas the alias cannot be retired.
The alias's own hazard — a version change shifting the probability distribution
behind θ — is answered with observability instead of immobility: Jev reports the
resolved id in every response, so `resolvedModelOf()` records it on
`JudgeResult.resolvedModel` and the verbose log emits a "version moved" line when it
differs from the requested id. Pin only for byte-identical reproducibility, and
accept the retirement failure mode that comes with it.

**Judge availability ladder — never stall, never guess (v1.7.0+).** Resolution
degrades in order, and the wizard does **no network I/O** at save time:

| Rung | Condition | Behaviour |
|------|-----------|-----------|
| 1 | the chain the user configured for judging resolves | judge with it — a decision model in `decision` mode, a dedicated LLM chain in `custom`, the Fast chain in `fast-chain` |
| 2 | that chain **resolves to nothing** (retired model, removed key, gone provider) **or fails at call time** (429 / 5xx / timeout / cooldown) | continue into the **LLM judge** — the user's own Fast chain, i.e. the pre-v1.7.0 default. The degradation is logged when rung 1 is unusable |
| 3 | rung 2 is exhausted too (nothing resolves, or every endpoint failed this turn) | **stop routing**: no model switch, no orchestration (an active one is cleared), and the user's own `sessionModel` restored if an earlier turn switched it — *unless* a manual override is active, which is an explicit instruction the bottom rung must not undo. One user-visible notice per session |

**Both rungs are one ordered list.** `resolveJudgeEndpoints()` returns
`[configured chain…, LLM judge…]` (deduped), so a single `classify()` walk covers
resolvability *and* call-time failure in the same turn — a 429 on the decision
rung falls through to the LLM judge immediately rather than holding the turn. The
walk's existing cooldown skipping and failover-signature cooling apply unchanged.
`fast-chain` mode returns just the Fast chain (no duplicate rung). A verdict is
never fabricated, and a malformed answer still holds rather than becoming a tier.

**Backward compatibility / migration.** Pre-v1.7.0 configs carry no
`routing.judge`; the merged default is `fast-chain`, so they keep byte-identical
behaviour with no migration step. `normalizeJudgeMode()` defines the contract for
the other shapes: the three known modes are honoured; a **models list with no
mode** becomes `custom` (a merged default would otherwise silently ignore the
list, so the resolver logs the inference); an **absent or unknown** mode becomes
`fast-chain` — the safe legacy reading, never a bricked router. The wizard uses
the same normalization, so the menu cannot display a mode the resolver would not
honour.

Rung 3 is implemented as the pure `planNoJudge()` so the policy is testable
without the pi lifecycle.

**Why the save-time probe was removed.** A probe proves the endpoint answers
*this second* — and Jev is in beta, where capacity, revoked keys and regional
flakiness all move — while costing a blocking round trip on the config UI (it
showed up to the user as the Config screen vanishing for ~1 s: the chain editor
had already closed, so there was nothing to render while a network call blocked
the handler). With rungs 1–3 covering unreachable endpoints *and a notice*, the
probe's only unique value — immediate feedback on a misconfiguration — is served
better by local static validation (endpoint resolves: auth + baseUrl + the
decision api marker) plus rung 2/3 at runtime. Feedback is not lost; it moves
from save-time to first-turn, where it is actually true.

**Wizard gate (no network at save time).** The two chain modes reuse the tier
chain editor. For `decision`, candidates are filtered to decision-capable
endpoints from pi's registry (SPEC §5.4); when none exists the wizard shows a
**dismissible setup screen** (why it is unavailable, the exact `"api"` value to
add, where it goes) and returns **without writing** — a toast is too transient
for instructions the user must act on, and a permanently disabled row would hide
the fix. A selection is then validated **locally** (the endpoint resolves: auth,
baseUrl, and the decision api marker) and persisted; correctness against the live
service is the runtime ladder's job, with a notice when it degrades.

**Operational floors (measured).** Live calls to `api.typesafe.ai` (2026-09-18,
3–8 calls per variant, 458–2265 input tokens) returned in **1.4–6.6 s**, median
~5 s, with `output_tokens` reported (50) but unbilled. This is **provider-side
capacity during Jev's public beta**, not a property of decision models and not
payload or integration overhead (a 5× smaller payload was no faster). Treat it as
temporary and re-measure rather than designing around it. Consequences:

- The wizard raises `routing.judgeTimeout` to `DECISION_MIN_JUDGE_TIMEOUT_MS`
  (15000) when decision mode is selected and the current value is lower, and
  reports the change in its notification. With the LLM-judge default (5000) most
  decision calls would be aborted and the router would hold every turn.
- There is no save-time network probe (see the availability ladder above): the
  wizard validates locally, and unreachable endpoints are handled at runtime.
- Measured cost per call: ~$0.000095 (2265 input @ $0.042/M, output unbilled) vs
  ~$0.00033 for the fast-tier LLM judge on the same rubric — cheaper, but ~3.5x
  slower in this environment. Latency is the open question (ROADMAP: decision-mode
  latency follow-up).

**Judge UX contract.** The Judge is the compass `🧭` project-wide (status bar
`🧭 judging…`, stats, status panel, wizard row) — never the scales `⚖️`. Inside
the Judge menu the three modes carry the glyph of what they reuse or are:
`🦾` reuse the Fast chain (the Fast tier's own glyph), `🔬` dedicated Judge LLM
(`routing.judge.models`), `🧮` decision model (computes an answer, generates no
text). The current mode is marked `●`, the others `○` (project convention), and
every glyph is followed by exactly one space: advance width differs per glyph and
font, so a missing separator reads as a layout bug (same class as the `🛡`→`🔒`
fix of v1.5.1). These labels are pure functions (`judgeModeOptions`,
`decisionSetupGuide`) so the copy stays under test.

## 9. Deep Dives and Future Direction

Sections 9.1–9.3 are **delivered** capabilities whose design detail is too long
for the §8 status table. §9.4 lists what is still open; withdrawn ideas are
recorded in MEMORY.md rather than kept here as a graveyard.

### 9.1 Cost telemetry — deep view (delivered v0.9.0)

`/router status` exposes per-tier spend (USD + token counts) plus a hypothetical baseline.

**Orchestration worker spend (v1.5.0)**: delegated workers are attributed
separately from the main agent. Each completed `subagent` tool result folds
its `usage.cost.total` into `orchestration.spend` **and** appends a bounded
per-worker record (`recordWorkerSpend`: cost, output tokens, spawn→result
wall time; ledger cap 20, oldest dropped; reset per orchestration task).
The dashboard Money section renders `orchestration $X (N workers)` whenever
the task spent anything, so delegation cost is never buried in the
main-agent totals.

**Pricing source**: the registry's `Model.cost` (input / output / cacheRead /
cacheWrite, USD per 1M tokens) is authoritative; `models-store.json` pricing is
the fallback when no registry is present (§5.4).

**Data source**: pi-agent's `message_end.usage` carries `input`, `output`, `cacheRead`, `cacheWrite`, and `cost.total` (USD) for every assistant message. The router attributes each message to whichever tier was active when it ran (`state.currentTier` at message_start).

**Baseline definition**: "what would this session have cost on the most expensive model you actually used?" — across `state.callLog`, the max input / output / cacheRead / cacheWrite prices set the per-token rates; every message's tokens are priced at those rates and summed. When the most-expensive-model lookup succeeds, the difference `hypothetical - actual` is the **savings** figure.

**Fallback**: when pricing is missing for every model used (e.g. fully-local session with no `models-store.json` pricing), the baseline shows `unavailable` instead of a misleading savings number.

**Display** (Money section of the `/router status` dashboard):

```
Money · this session
  saved   $2.742 of $3.210  (85%)  vs all-smart: anthropic/claude-opus-5
  spent   $0.465  fast ▓▓░░░░░░░░ 10% · smart ▓▓▓▓▓▓▓▓░░ 90%
```

### 9.2 Cache-aware routing (delivered v0.10.0)

**Problem**: a prompt cache belongs to a model — it is the model's own key-value state,
addressed by a byte-identical prefix. Crossing a model boundary is therefore a
guaranteed cache miss. When a router downgrades mid-session (smart → fast on a
different model), the new model re-reads the entire conversation at full input
price, forfeiting the accumulated cache discount on every subsequent turn until
the new cache warms.

**Motivating data** (industry measurements, 2026):

- Cache reads bill at **0.1x–0.5x** of base input (Anthropic 0.1x, OpenAI 0.5x).
  Anthropic's first write costs 1.25x; a 1-hour TTL write costs 2x.
- Agentic sessions are cache-dominated: **by Turn 3, cached tokens are the vast
  majority of the payload**; tool-result steps hit **97.9% prefix-cache hit rates**
  (Claude) vs 86.9% on user-initiated steps; overall 95.8% (Claude) / 95.7%
  (Codex) across sessions averaging 9.2 requests and 73.6 tool steps.
- A worked TraceLab-style example: a 126k-token prefix staying on a warm cache
  costs **$0.0631/step**; routing one step to a model that is 2.5x cheaper on list
  price but cold-cache costs **$0.2541** for the same prefix — **3.5x more**, not
  less. Break-even rule: a downgrade target only wins if its base input price is
  **> 10x cheaper** than the model you leave (Anthropic's 0.1x cache discount
  makes the threshold 1/0.1). GPT-5.6 Luna at $0.20/MTok qualifies (25x); Claude
  Haiku 4.5 at $1/MTok does not (1.7x more than staying).
- RouteLLM-style validation (85% cost reduction) was measured on MT Bench —
  short, independent, single-turn prompts with no reusable prefix. Agentic
  workloads are the exact inverse; the cache discount is the bigger lever.

**Design** (pure logic, no heuristics):

1. Detect whether both tiers resolve to the **same provider family**
   (`resolved.provider` family, e.g. both `anthropic` — same provider = same
   cache domain; different providers never share a cache).
2. When they do, raise the downgrade threshold for the session:
   `routing.window.threshold` 0.6 → **0.9** (fewer mid-session downgrades →
   fewer cache forfeits). Threshold is the *downgrade* gate only — upgrades
   (fast → smart) stay immediate, because the smart tier's superior output
   quality is the point of the upgrade.
3. **Session-boundary routing**: downgrades only apply when the cache is
   naturally cold anyway — after a session break (>5 min idle kills the cache;
   >1 hour almost all steps miss it), or after `/compact`. Implement by
   checking `state.lastMessageAt` age; if the gap exceeds the provider's cache
   TTL window, the cache is already gone and downgrading costs nothing extra.
4. Config: `routing.cacheAware` (`boolean`, default `true` when same-family
   detected; user can force-off). No new magic numbers — the 0.9 threshold
   reuses the existing `window.threshold` semantics.

**Expected effect**: in same-family setups (e.g. Anthropic fast+smart, or
OpenAI fast+smart) the router stops trading a 10x discount for a 2.5x one.
Downgrades still happen, but only when the cache is already cold or the window
majority is unambiguous. Cross-family setups are untouched (cache domains
already distinct).

### 9.3 Task-level orchestration (delivered v1.0.0)

**Vision (user-driven)**: stop at *per-turn model routing* and graduate to a
*task-level closed loop* — a virtual dev team. On a user task, Judge decides
(reusing §4): simple tasks route to fast as today; complex tasks escalate to a
**Smart main agent that orchestrates multiple Fast subagents** — Smart plans,
delegates implementation to Fast subagents (parallel where independent),
reviews each result, sends failed work back with concrete feedback, takes over
directly when a subagent repeatedly fails past a threshold, and does the final
acceptance pass. This is the Teams / Orchestra pattern.

**Two architectural layers.** Orchestration *authority* lives in the **LLM
layer**, not in the extension. The Smart main agent owns planning, delegation,
review, escalation and acceptance, using pi's subagent tool to spawn isolated
Fast worker processes. The plugin stays a *router*: it runs the Judge, decides
*when* to enter orchestration, switches the main model to Smart, and injects the
orchestrator prompt — then the Smart agent's own loop takes over. (Why the plugin
must not re-implement the loop, and the extension-API limits that force this
split, are recorded in MEMORY.md.)

**Why the plugin must NOT re-implement orchestration.** The extension API gives
no control over pi's agent loop, so a plugin-side state machine would have to
chain phases with `pi.sendUserMessage(…, { deliverAs: "followUp" })` and hold
`currentPhase`/`attempts` state — duplicating the subagent machinery
(process spawn, JSON parsing, concurrency, worktree isolation, intercom) that
pi already ships. The subagent tool already provides verified isolation and
parallelism; re-building it in the plugin violates AGENTS.md
(simplicity / DRY / delete-before-adding).

**Verified mechanisms (pi 0.84.1 source).** The subagent tool spawns an isolated
`pi` process with its own model, tools and session; the plugin can pin the worker
model per spawn, and `worktree` isolation plus parallel fanout are available. No
plugin-side process management is required — the plugin's whole job is (a) Judge,
(b) decide complex vs simple, (c) on complex: switch the main agent to the Smart model and
inject an orchestrator instruction that says "you are the CTO — plan, then
delegate implementation to `worker` subagents and review with `reviewer`
subagents, loop until clean (cap N), take over yourself if a worker fails ≥N
times, then do the final acceptance pass". Everything else is the Smart agent
using the `subagent` tool + the shipped prompts.

**Tier injection — how Fast/Smart tiers reach the subagents (user-driven
design).** The tiers defined in `pi-shift-router.json` are the *single source
of truth* for models; pi-subagents must NOT be configured separately. Instead,
the plugin carries the tier info into the orchestration dynamically:

- When Judge says complex, the plugin reads `config.tiers.fast` and
  `config.tiers.smart` and renders them into the injected orchestrator
  instruction as concrete per-role model guidance:
  - `worker` → the Fast tier chain (priority order, incl. failover chain);
  - `reviewer` / the final acceptance pass → the Smart tier chain;
  - the escalation note: "if a worker fails ≥N times, take over the phase
    yourself (you are running the Smart model)".
- The Smart orchestrator then spawns each subagent with a **per-run model
  override** via `runs.run(key, { agent: "worker", model: "<fast-model>", … })`
  — verified supported by the `subagent` tool schema
  (`model: "Override model for this task"`, schemas.ts:147).
- **Workers must use `context: "fresh"` (verified 2026-08-13).** With
  `context: "fork"`, pi-subagents force-forces `thinking: off` for any model
  whose API is `anthropic-messages` (MiniMax-M3 included — safety sanitizer
  `forkedChildRequiresThinkingOff`, fork-context.ts:61-71), which degraded
  output quality in testing; run params cannot override it. `context:
  "fresh"` honors the `thinking` override (`minimax-cn/MiniMax-M3:high`
  verified) and shrinks the worker context from ~176k inherited tokens to
  ~8k task-local tokens (cost $0.064 → $0.004, 3× faster) — the right shape
  for narrow Fast-tier execution. The orchestrator prompt should instruct
  workers to be self-contained (include all needed context in the task).

**Worker task prompt.** A fresh worker inherits nothing, so the task string *is*
its world. It must be a contract — goal, constraints, acceptance criteria, files
to touch, explicit out-of-scope — and self-contained enough that the worker never
needs to ask a question (it may still escalate a genuine decision via
`contact_supervisor`). Reference large files by path rather than pasting them,
include only facts needed to decide correctly (interfaces, conventions, the exact
error text), and make acceptance criteria something the worker can execute. The
concrete wording lives in `src/prompts/orchestrator.md`, not here.

**Proposed flow:**

```
[Idle] ──Judge──▶ simple → fast agent run as today (degraded default)
                 complex → Smart main agent + orchestrator prompt
                             │
                             ▼
              Smart: plan → decompose into phases (with acceptance criteria)
                             │
                             ▼
              Smart: delegate phase(s) → Fast subagents via subagent tool
                             │   (parallel fanout for independent phases)
                             ▼
              Smart: review each subagent result
                 ┌────┴─────┐
               pass       fail (concrete feedback)
                 │            │
                 ▼            ▼
         next phase /   Smart re-delegates to Fast subagent (or fixes inline)
         final accept       │ fail ≥N times
                             ▼
                   Smart takes over the phase itself (full agent loop)
```

**Economics (when it pays).** Implicit assumption:
`cost(smart review) + Σ cost(fast subagent) × (1 + fail-rate × retries) <
cost(smart end-to-end)`. Fast subagents are spawned fresh with a narrow task
→ small context, fast, cheap; Smart review reads artifacts + context, cheaper
than Smart implementing. Escalation threshold N (default 2) is the economic
safety valve. Holds for *implementation tasks* (verifiable acceptance:
tests/lint/behavior). For *judgment tasks* (architecture trade-offs,
direction) Fast has no useful implementation — Judge routes them to Smart
directly, which the existing complexity axis already encodes.

**Orchestration control — hard/soft split (how the loop is actually
governed).** pi-subagents ships the *execution primitives* (runs.run / runs.all,
worker & reviewer agents, worktree isolation, workflowScript) but NOT the
*content decisions* of the loop. Those must be defined by us and split across
two control layers, matching the existing Judge philosophy (LLM does content
judgment, code does boundary control):

| Control layer | Owns | Responsibilities |
|---|---|---|
| **Hard (plugin code)** | pi-shift-router state machine | entry gate (Judge complex), main-model switch to Smart, **max rounds cap**, **escalation threshold N** (v1.2.0: plugin-enforced via `recordWorkerOutcome` + `tool_call` block), **elapsed/cost budget**, abort/reset semantics, per-phase state (`currentPhase`, `attempts`, `spend`, `workerSpends`) |
| **Soft (Smart main agent)** | CTO judgment | plan (phase list + per-phase acceptance criteria), delegation (which worker, what task), review pass/fail, final acceptance |

**"Should the loop continue?" is a double judgment**: the *content* answer
("phase X still has a blocking bug" / "all acceptance criteria met") is Smart's
LLM review; the *quantity* answer (reached max rounds / N escalations / budget
spent) is the plugin's hard cap. The loop stops when either one says stop —
Smart's judgment decides *what* is wrong, the plugin's caps decide *how long*
we keep paying for it.

**Acceptance audit (v1.3.0, safety-net review; v1.4.0 domain-restricted)** — because
the *content* judgment is Smart's alone, the plugin adds a post-turn safety net.
**The audit's domain is DELEGATED orchestration runs (`spawned ≥ 1`)** — its
invariants (workers spawned ↔ results reported; acceptance grounded in worker
outputs) only engage when delegation actually happened. Deterministic checks
(workers all reported back; final message carries a CTO summary; hard-cap flag)
always run, and an optional small fast-tier LLM audit (`orchestration.audit.enabled`, default true) checks three dimensions against the **captured
user goal** + worker results: **grounding** (acceptance claim backed by
results), **goal alignment** (delivered work addresses the request), and
**delivered quality** (no placeholder/empty/aborted results passed off as
done). **Self-executed orchestration turns (`spawned = 0`, the sanctioned
"if it's actually simple, just do it yourself" path) are exempt from the
audit entirely — no violations, no warnings** (their evidence is the CTO's
own tool trail, visible to the user in the transcript). They are still
marked `self-executed` in `/router status` for transparency. The
CTO-summary output contract only engages when workers were actually
spawned (`spawned ≥ 1`).
Evidence extraction reads pi's native message schema
(`role: "toolResult"` + `toolName`), filtering worker results to
`toolName === "subagent"`. The audit never blocks the finished turn — it
flags via warn/toast and `/router status` → `Last audit`. Files:
`src/audit.ts` (pure deterministics + `callAuditLLM`), `src/prompts/auditor.md`,
wiring in `agent_end`; goal snapshot in `OrchestrationState.goal`.

**Retry-aware audit deferral + cooldown-aware LLM pass (v1.4.2):** pi emits
`agent_end` *before* its auto-retry continuation when a turn fails with a
provider error, and the extension-facing event carries no `willRetry` flag.
When an orchestration turn ends on a **failover-signature error tail**, the
audit and orchestration exit are therefore **deferred**: auditing a truncated
transcript would false-flag "no CTO summary" on what is really a retry, and
the retry continuation must keep worker accounting, caps, and the wand. The
failover block cools the dead model so the retry lands on the fallback; the
real end (healthy tail) runs the normal audit + exit, and the
`before_agent_start` sweep closes any leaked state after a permanent failure
(the bar then shows a static Done/Total label until the next turn — bounded,
cosmetic). Within the audit itself, the LLM pass is **cooldown-aware**: the
caller injects the cooldown predicate, cooled endpoints are excluded, and an
all-cooled chain skips the pass (deterministic checks still ran) — the audit
must not re-burn an endpoint the same turn just cooled down.

**Backward compatibility contract.** Orchestration ships on by default (`auto`
mode) and must not change any turn that is not a complex task with subagents
available:

1. **Simple tasks never orchestrate.** A `fast` verdict keeps the byte-identical
   direct fast run; only `smart` verdicts enter the orchestration path.
2. **Missing `pi-subagents` degrades silently.** Without the extension the
   orchestrator injection is skipped and the complex turn runs exactly as the
   pre-orchestration smart-tier run — no crash, no deadlock, no partial state.
3. **Config parses unchanged.** Every `orchestration.*` field is optional with a
   default (§5 merge behaviour); old configs need no migration.
4. **Abort/reset always available.** A user message or `/router orchestrate off`
   mid-loop cancels pending runs and resets orchestrator state; the session
   continues as a normal routed session. `resetOrchestration()` also runs on
   `session_start` so a new session never inherits a stale planning frame.

**Risks, and how each is contained.** Review-loop convergence: only blocking
issues may be flagged, every re-delegation carries a structured failure report
(what failed / where / the acceptance test to re-run), and repeating the same
feedback twice triggers takeover instead of re-delegating. Worker-output variance:
each worker is fresh-context, so the task prompt must be self-contained.
Runaway cost: `orchestration.maxRounds` and `escalationThreshold` are enforced
**plugin-side** (`recordWorkerOutcome` + `tool_call` blocking), not suggested in
the prompt. Interrupts mid-orchestration: cancel/reset semantics via
`resetOrchestration`.

### 9.4 Future work

- **Tool-result classification.** Classify tool calls, not just user messages —
  long shell output may indicate debugging rather than a question, which is
  signal the current prompt-only Judge cannot see.
- **Threshold re-derivation for calibrated probabilities** (§8.6). Decision
  models return a calibrated distribution, not an LLM `confidence`; θ and
  `minConfidence` are still on the LLM scale, so the switch rate shifts under
  decision mode until they are re-derived from measured data.
- **Decision-mode latency re-measurement.** The 1.4–6.6 s currently measured is
  provider-side beta capacity, not a property of the model class. Re-measure as
  capacity comes online; if seconds persist, position decision mode as
  batch/background-only.

Withdrawn ideas (multilingual Judge-prompt translations) are recorded in MEMORY.md
with their rationale, not kept here. The effort-control idea that was withdrawn in
v0.8.x is **not** on that list: it is revived and specified in §9.5, with the reason
the earlier objection no longer applies.

### 9.5 Effort control (proposed, v1.8.0)

**Status: designed, not implemented.** Opt-in and off by default — absent config means
the router never calls `setThinkingLevel`, so upgrades stay byte-identical.

**What it is for.** Tier routing carries most of the value: the price and capability gap
between the tiers *is* the feature. Effort exists for the one region where tier routing
is least decisive — a verdict that lands just inside a tier's boundary, where the
alternatives are a tier switch (loses the prompt cache, 4–50× price) or leaving a
marginal task on a tier that may be wrong either way. Effort changes *how much the
already-chosen model thinks*, never which model, so it is cache-safe by construction and
cannot overlap with tier routing. The measured evidence behind the shape of this section
(Artificial Analysis, Intelligence Index vs cost per task) is one MEMORY entry:
2026-09-23 *Effort control revived*.

**Three directions, relative rather than absolute.**

| Direction | Meaning |
|---|---|
| `default` | Do not intervene; restore the session baseline |
| `high` | One supported notch **up** from the current level |
| `low` | One supported notch **down** from the current level |

These are not pi level names. The ladder is the model's own supported list, derived the
way pi derives it: no `reasoning` ⇒ `["off"]`; a `thinkingLevelMap` entry of `null`
removes a level; `xhigh`/`max` require an explicit map entry. One notch is therefore
capability-correct on every model, needs no knowledge of the model's configured default,
and can never ask for a level pi would silently clamp. `ThinkingLevel` is pi's 7-value
union (`off|minimal|low|medium|high|xhigh|max`), redeclared in `types.ts` — the package
root does not re-export it, and `pi-ai` is not an allowed runtime dependency.

**Trigger: the boundary band only.** Effort moves if and only if the verdict is marginal
— `|pSmart − θ| < band` — and then only in the direction of the margin: a fast verdict
inside the band steps **up**, a smart verdict inside the band steps **down**. Outside the
band, and on any hold (`confidence < minConfidence`), the router does not intervene. The
sharp distribution is therefore structural rather than requested: effort can only be
spent where the router is genuinely undecided.

**One direction per tier, one notch, never more.**

| Tier | Allowed dynamic direction | Why |
|---|---|---|
| fast | `up` only | Cheap insurance for a fast-tier task that is harder than typical. `low` is **forbidden**: a weak model with less thinking produces rework, and rework costs more than the thinking it saved (measured: a model's low-effort setting can be dearer than its max). |
| smart | `down` only | The "expensive model on a task that did not need it" case. `up` is deliberately *not* dynamic: when a model's `high` is nearly free, that is a configuration fact (`static` pin), not a per-turn judgment. |

**The dynamic ladder is bounded to `[low … high]`.** One notch up from a model whose
ladder supports `xhigh`/`max` would otherwise land on them, so the bound is explicit: if
the next notch lies outside `[low, high]`, the router does not move. The excluded range is
not merely cautious — `xhigh`/`max` are the flat-and-dominated end of the measured curve,
and `off`/`minimal` is where a weak model starts producing rework. Anything outside the
bound is a **configuration** decision, not a per-turn one.

**Static pinning.** `static.fast` / `static.smart` accept any supported level — including
`off`, `minimal`, `xhigh` and `max` — and apply regardless of the band. This is where
"this model's `high` is nearly free" and "this model's `max` is dominated" belong.

**Invariants.**

1. Effort never changes the tier, and a wrong tier is never repaired with effort.
2. No intervention on a non-marginal verdict, or on a hold.
3. At most one notch per turn, and never outside `[low, high]`.
4. Only levels from the model's supported ladder are requested (filter before stepping).
5. Effort never enters the θ/EV math or the cache-aware gate.
6. **Cost-crossover guard**: if the adjusted turn is predicted to cost at least as much
   as the neighbouring tier's baseline, the adjustment is abandoned and the tier decision
   stands. Enforcing this needs per-level output-token estimates (ROADMAP Gate 2).

**Session state and ordering.** A baseline level is captured at `session_start`; the
router restores it on `default` turns (pi's level is otherwise sticky), and updates it
whenever a level change originates outside the router (the `thinking_level_select`
event). `setModel()` re-derives the level from pi's own defaults, so **every** model
switch — tier switch, failover, session restore — must funnel through one
`applyModelAndEffort()` that re-applies the intended level afterwards.

**Telemetry.** Per turn: the applied level and its reason
(`baseline|marginal-up|marginal-down|no-capability`). Per task and per session: the
effort distribution, with the sharpness contract **default ≥ 85%, up ≤ 10%, down ≤ 5%**
(after ≥ 20 turns) reported, never auto-corrected. Cost accounting keeps its present
shape: effort is a quality knob, and no effort dimension enters the savings figure until
the cost curve is measured.

**Out of scope.** No effort × tier matrix; no dynamic `xhigh`/`max`; no heuristic trigger
(message length, token counts and tool counts are forbidden inputs, exactly as the Judge
forbids keyword rules); no change to θ, `minConfidence`, or cache-aware behaviour.
