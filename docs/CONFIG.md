# Configuration & Tuning Reference

> The recommended way to configure is the TUI wizard (`/router config`) — you normally won't need to touch JSON. This page is for scripting, sharing config across machines, or pinning config to a project repo.

## Config file locations

```text
~/.pi/agent/pi-shift-router.json         (user scope — wins by default)
<cwd>/.pi/pi-shift-router.json           (project scope — wins on conflict)
```

## Configurable from the TUI (`/router config`)

- Master on/off (`/router on` / `/router off`)
- Per-tier model chain — add / remove / reorder (`a`, `x`, `J`/`K`, `d` to save, `Esc` to cancel)
- Save scope: user or project

## JSON-only settings (advanced, not in the TUI)

- `routing.judgeTimeout`, `routing.window.minConfidence`, `routing.economics.reworkPenalty`
- `routing.judge.mode` / `routing.judge.models` (Judge LLM chain or a decision model — see below)
- `ux.quietMode`, `ux.routerLogVerbose` (verbose writes to `~/.pi/agent/logs/shift-router.log`)

After hand-editing, re-run `/router config` once to reload, or restart pi.

## JSON schema

Two layers: the TUI wizard writes the "configurable from TUI" block; the advanced block is hand-edited. Layout:

```text
pi-shift-router.json
├── enabled                    boolean  master switch; default true
├── tiers
│   ├── fast
│   │   └── models[]           ordered list; first is primary, rest are fallbacks
│   │       ├── provider       string   must match a provider in pi-agent's auth.json
│   │       ├── model          string   model ID within that provider
│   │       └── priority       integer  1 = primary, 2 = first fallback, …
│   └── smart                  same shape as fast
├── routing
│   ├── mode                   "auto" | "manual"; default "auto"
│   ├── judgeTimeout           ms; default 5000
│   ├── window
│   │   ├── size               decision-history cap; default 5
│   │   ├── threshold          LEGACY explicit θ override (raw pSmart bar); prefer economics
│   │   └── minConfidence      below this = no signal (hold); default 0.5
│   ├── economics
│   │   ├── mode               named preset (/router eco|default|sport): eco | default | sport; overrides reworkPenalty when set
│   │   ├── reworkPenalty      wrong-downgrade cost in price-deltas; θ = 1/R; default 3
│   │   └── downgradeMemory    consecutive decisive fast decisions to downgrade; default 2
│   └── cacheAware
│       ├── enabled            divide θ by sameFamilyPenalty + guard warm cache; default true (same-family only)
│       ├── sameFamilyPenalty  θ divisor when same family; default 1.5
│       ├── sameFamilyThreshold  LEGACY knob → implies strong penalty 3.0
│       └── idleBoundaryMs     idle gap that means "cache expired"; default 300000 (5 min)
└── ux
    ├── quietMode              suppress inline toasts; default false
    ├── statusBar              show 🦾 / 🧠 badge; default true
    ├── inlineToast            model-switch toasts; default true
    └── routerLogVerbose       debug logging to ~/.pi/agent/logs/shift-router.log; default false
├── orchestration             (SPEC §9.3, v1.0.0; all optional)
    ├── mode                   "auto" | "off"; default auto (opt-out via /router orchestrate off)
    ├── maxRounds              delegate→review rounds cap; default 3
    ├── escalationThreshold    worker fails ≥N → Smart takes over; default 2
    └── requireSmartModel      skip orchestration if Smart model unresolvable; default true
```

**Minimal working config** (one model per tier, everything else default):

```text
enabled:  true
tiers:
  fast:   [{ provider: openai, model: gpt-5.6-luna }]
  smart:  [{ provider: openai, model: gpt-5.6-sol }]
```

**Multi-provider with per-tier fallback chains** (typical production setup):

```text
enabled:  true
tiers:
  fast:
    - { provider: deepseek,   model: deepseek-v4.1-flash, priority: 1 }
    - { provider: z.ai,       model: glm-5.3-flash,           priority: 2 }
    - { provider: xai,        model: grok-4.5-fast,     priority: 3 }
  smart:
    - { provider: anthropic,  model: claude-opus-5,     priority: 1 }
    - { provider: openai,     model: gpt-5.6-sol,       priority: 2 }
    - { provider: moonshotai, model: kimi-k3,           priority: 3 }
```

### Field-by-field defaults

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Use `/router off` to disable. |
| `tiers.<tier>.models[]` | `[]` | Ordered by `priority`. First hit wins; rest are runtime fallbacks. |
| `routing.judgeTimeout` | `5000` | ms. Judge API call timeout. |
| `routing.judge.mode` | `"fast-chain"` | Judge chain source: `fast-chain` (reuse the Fast tier — default), `custom` (dedicated `routing.judge.models` LLM chain), `decision` (typed-answer decision models, Jev/System One class). |
| `routing.judge.models` | `[]` | Model chain used by `custom` / `decision` (priority order, same shape as a tier chain). Ignored by `fast-chain`. |
| `routing.window.size` | `5` | Decision-history cap (window entries kept for display + streak analysis). |
| `routing.window.minConfidence` | `0.5` | Judge confidence below this = no signal (hold: never switch, breaks a fast streak). |
| `routing.economics.mode` | *(unset)* | Named gear preset from `/router mode` — `eco` (R=2, θ=0.5, cheaper: only clearly-needed turns run smart), `default` (R=3, θ≈0.33), `sport` (R=5, θ=0.2, eager: any real chance escalates). Higher R → lower θ → more eager Smart (θ = 1/R). When present it is **authoritative** over `reworkPenalty`; clear it (or edit the file) to go back to a manual R. A legacy `window.threshold` (non-default value only) still wins over both. |
| `routing.economics.reworkPenalty` | `3` | Wrong-downgrade cost in price-deltas. θ = 1/R: the expected-cost smart bar (SPEC §2.3). Ignored while `economics.mode` is set. |
| `routing.economics.downgradeMemory` | `2` | Consecutive decisive fast decisions required to downgrade smart → fast. |
| `routing.cacheAware.enabled` | `true` | When fast & smart share a provider, divide θ by `sameFamilyPenalty` and suppress mid-session switches while the prompt cache is warm (SPEC §9.2). Off for cross-family setups (no shared cache). |
| `routing.cacheAware.sameFamilyPenalty` | `1.5` | θ divisor when cache-aware is on for a same-family setup (fewer downgrades → cache survives). |
| `routing.cacheAware.sameFamilyThreshold` | legacy | Pre-v1.4.0 knob. **Smooth migration:** the old default `0.9` is dead (wizard snapshots fall back to `sameFamilyPenalty` 1.5); only a value that *differs* from `0.9` implies the strong penalty `3.0` — old configs that explicitly tuned it keep their conservative intent. |
| `routing.cacheAware.idleBoundaryMs` | `300000` | Idle gap after which the prompt cache is considered expired; downgrades are allowed again. |
| `ux.quietMode` / `statusBar` / `inlineToast` / `routerLogVerbose` | various | Display controls; `routerLogVerbose` appends diagnostics to `~/.pi/agent/logs/shift-router.log`. |
| `orchestration.mode` | `"auto"` | Task-level orchestration mode. `"auto"` (default): Judge-driven — simple tasks (fast verdict) keep the plain router; complex tasks (smart verdict) escalate to Smart-orchestrated execution (requires the `pi-subagents` extension; without it, behavior degrades to the plain smart-tier run). `"off"` (via `/router orchestrate off`): never orchestrate — byte-for-byte today's router. There is no "always" mode. |
| `orchestration.maxRounds` | `3` | Hard cap on delegate→review rounds per task; the loop stops when this is hit regardless of what the Smart agent wants. |
| `orchestration.escalationThreshold` | `2` | A worker failing ≥N times on a phase → Smart takes over that phase itself. |
| `orchestration.requireSmartModel` | `true` | When true and the Smart tier model can't be resolved, orchestration is skipped and the turn runs as today's smart-tier run (no crash). |
| `orchestration.audit.enabled` | `true` | Run the post-turn acceptance audit (safety-net review) after every orchestrated turn **that actually delegated to workers (`spawned ≥ 1`)**. Deterministic checks (workers all returned; CTO summary; cap flag) always run on delegated turns; when `true` an LLM pass on the fast tier verifies the CTO's acceptance claim is grounded in the worker results. Self-executed turns (`spawned = 0`) are exempt — no violations, no warnings, marked `self-executed` in `/router status`. Never blocks the turn — findings surface via `console.warn` + toast and `/router status` → `Last audit`. |
| `orchestration.audit.timeoutMs` | `5000` | Max time for the audit LLM call (best-effort; a failure degrades to a warn, never a crash). |

## Tuning guide

Every knob is a trade-off. Pick by workload:

| Your session looks like… | Try… | Why |
|---|---|---|
| Lots of routine work (CRUD, tests, docs); little architecture | `reworkPenalty: 2`, `minConfidence: 0.6` | Conservative (θ=0.5): only clearly-needed turns run smart |
| Heavy architecture / planning / code review | `reworkPenalty: 5`, `minConfidence: 0.4` | Eager (θ=0.2): any real chance of needing Smart escalates — wrong downgrades cost more than the saved delta |
| Mixed — 20 fast turns then a planning burst | Defaults (`reworkPenalty: 3`, `minConfidence: 0.5`) | Balanced (θ≈0.33); borderline verdicts lean smart |
| Judge tends to over-confident (most votes ≥0.9) | `minConfidence: 0.7` | Strip the over-confident votes |
| Judge tends to uncertain (many 0.3–0.6 votes) | `minConfidence: 0.3` | Fewer holds — more decisions follow the judge |
| Primary fast model keeps 429'ing | Add a second provider as `tiers.fast.models[1]` | v0.6.0 runtime failover picks it up |
| Heavy streaming / long agent runs | Watch `/router status` tokens/sec | See per-turn throughput |

### Knob reference

**`routing.judgeTimeout`** (ms) — Judge API call timeout. Default `5000`. Raise on slow providers, lower on flaky networks.

**The judge ladder.** Whatever mode you pick, the router walks two rungs and never guesses:

1. **Your judge chain** — a Jev decision model (`decision`), a dedicated LLM chain (`custom`), or the Fast chain (`fast-chain`).
2. **Your LLM judge** — the Fast-tier chain (the pre-v1.7.0 default). Rung 1 lands here when it cannot resolve (retired model, removed key, gone provider) **or** when it fails at call time (429 / 5xx / timeout / cooldown) — the same turn, not the next one.
3. If rung 2 is exhausted too: **routing stops** for the turn — no model switch, no orchestration, and the model you started the session with is restored (a manual `/route-force` override is respected). One notice per session. The worst case is "as if this plugin were not installed".

**Old configs need no migration.** A pre-v1.7.0 config has no `routing.judge` at all, and the default is `fast-chain` — identical behaviour to before. Two other shapes are handled: a `judge.models` list without a `mode` is migrated to `custom` (otherwise the merged default would silently ignore it), and an unknown/typo'd `mode` degrades to `fast-chain` rather than breaking routing. The wizard displays the normalized mode, so the menu always matches what the router does.

**Decision mode needs more than the default.** Measured against `api.typesafe.ai` (2026-09-18): **1.4–6.6 s** (median ~5 s), and a 5× smaller payload is no faster — the wait is provider-side compute during Jev's public beta, not payload or integration overhead. So `/router config` → `🧭 Judge` → `🧮 Decision model` **raises this to 15000 ms** if your value is lower, and says so in its notification. Below ~15 s, most decision calls abort on timeout and the router silently holds every turn. Expect this to fall as beta capacity comes online.

**`routing.judge`** — the Judge runs in one of three modes (wizard: `/router config` → 🧭 Judge):

1. `fast-chain` (default) — reuse the Fast tier chain. Nothing extra to configure; identical to earlier versions. If the chain resolves to nothing, the router falls back to the cheapest authenticated model (legacy behaviour).
2. `custom` — a dedicated Judge LLM chain in `routing.judge.models`, edited with the same chain editor as the tiers. Useful when you want a cheaper or stricter classifier than your Fast tier. **No** cheapest-model fallback: an unresolvable chain holds position instead of judging on a model you did not pick.
3. `decision` — a **decision model** (TypeSafe Jev / System One class) that returns typed answers with calibrated probabilities instead of text. The wizard offers only decision-capable endpoints and validates the choice **locally** (auth + baseUrl) — there is no save-time network probe. If the endpoint turns out to be unusable at runtime, the router degrades instead of stalling: **Jev → your LLM judge → routing off** (no model switch, no orchestration, one notice). Decision-mode failures never hold a fabricated verdict.

**Model id: use `jev-latest`.** Jev returns the resolved version in every response (`"model": "jev-1.13.0"` even when asked for the alias), and the router logs it when it changes, so an alias move is visible rather than silent. Pinning (`jev-1.13.0`) trades that resilience for byte-identical reproducibility — and fails hard on the day the vendor retires the build. Prefer the alias; watch the log.

Decision transport (used by mode 3): `POST {baseUrl}/v1/systemone` with `{model, state, questions:{tier:{type:"choice",…}, orchestrate:{type:"noul",…}}}`. The router reads `tier.choice`, uses `tier.probabilities[tier]` as the confidence, and thresholds `orchestrate.noul >= 0.5`. There is no `reason` for decision mode (the model generates no prose), so the dashboard's "Last:" line shows the tier + probability only.

**Order: legacy default first, Jev last as Beta.** The wizard lists `🦾 Reuse the Fast tier chain (default)`, then `🔬 Dedicated Judge LLM chain`, then `🧮 Jev — decision model (Beta)`. Jev is public beta — less independently validated than an LLM judge, with provider capacity still ramping — so it is opt-in rather than the recommended default. The config default stays `fast-chain`, so an upgrade never re-judges you with a different model class. If a dedicated or decision chain resolves to nothing (model retired, key removed, provider gone), the router **falls back to the LLM judge and logs it** rather than holding every turn — and the wizard row tells you what is actually judging (`Jev unavailable — LLM judge active`). Per-call failures still hold: those are transient, not config rot.

Note: switching to a decision model changes the *distribution* of confidence values. Thresholds (`θ`, `minConfidence`) were tuned for LLM confidence; re-tune them once you have measured data from the decision model (`/router status` shows the recent verdict window).

**`routing.window.size`** — Decision-history cap. Default `5`. Larger keeps more context for the downgrade streak; entries beyond it are discarded.

**`routing.economics.reworkPenalty`** (≥1) — how many price-deltas a wrong downgrade costs (rework multiplier). **θ = 1 / reworkPenalty** is the expected-cost smart bar (SPEC §2.3): the judge's confidence is read as `pSmart` (smart verdict: `c`; fast verdict: `1−c`), and the turn runs smart whenever `pSmart ≥ θ`. Because rework costs more than the saved delta, borderline verdicts lean smart. NOTE the direction: **higher R → lower θ → MORE eager Smart**.
- `5` → θ=0.2 (`/router sport`): eager/sticky — most borderline turns escalate, stays on Smart
- `3` → θ≈0.33 (default `default`): balanced
- `2` → θ=0.5 (`/router eco`): conservative/cheap — only clearly-needed turns run smart

**`routing.economics.downgradeMemory`** (≥1) — consecutive decisive fast decisions required to downgrade smart → fast. Default `2` (two independent judge agreements). A hold (confidence < `minConfidence`) or a smart decision breaks the streak.

**`routing.window.threshold`** (0–1, LEGACY) — pre-v1.4.0 knob. **Smooth migration:** the old default `0.6` is **dead** — a config carrying it (e.g. a wizard snapshot) silently falls back to the new rule `θ = 1/reworkPenalty` instead of being reinterpreted as a conservative `θ=0.6`. Only a value that *differs* from `0.6` is honored as a **raw θ** override (and shown in `/router status`). Prefer `economics.reworkPenalty` / `/router eco|default|sport`; remove `threshold` to use the economics default.

**`routing.window.minConfidence`** (0–1) — below this, the judge's confidence is treated as **no signal** (hold): never switch tiers, and the hold breaks a fast streak. Default `0.5`. Set `0` to always follow the judge.

**`routing.cacheAware`** — cache-aware routing (SPEC §9.2). Prompt caches belong to a model: switching tiers mid-session forfeits the warm cache (cache reads bill 0.1x–0.5x of base input), so routing to a cheaper model can cost more, not less. When `enabled: true` **and** fast & smart share a provider family (auto-detected):
- effective θ is divided by `sameFamilyPenalty` (default 1.5) — fewer fast decisions → fewer mid-session downgrades, and
- downgrades are suppressed within `idleBoundaryMs` (default 5 min) of the last message — the cache is warm; they only fire after the idle gap long enough that the cache has already expired.
Upgrades (fast → smart) are never affected. Cross-family setups are untouched. Toggle with `/router config → 🧠 Cache-aware routing`.

**`tiers.<tier>.models[]`** — ordered by priority. First is primary; rest are runtime fallbacks (v0.6.0). Put the cheapest healthy model first.

**`ux.routerLogVerbose`** — set `true` (or `/router verbose`) to log every decision, judge call, and turn diagnostic to **`~/.pi/agent/logs/shift-router.log`** (append-only; the directory is created on demand). Diagnostics deliberately do **not** go to the console: pi owns the terminal, and stray writes corrupt the TUI frame — the assistant's own message text gets split and wrapped lines overlap. Keeping diagnostics in a file is what prevents that. Override the path with the `PI_SHIFT_ROUTER_LOG` env var. Useful while calibrating `reworkPenalty` / mode.

## Reading `/router status`

> **Native model picks are display-only (Scheme A).** pi's own `/model` or
> `Ctrl+P` switcher only syncs the status bar — the router keeps per-turn
> model authority, so a native pick can be re-routed on the very next turn.
> Use `/route-force` for a one-turn pin, or `/router off` for full manual
> control. (v1.2.0+; documented as the explicit contract.)

```text
pi-shift-router — Mode: AUTO ✅
Current: [🦾 deepseek-v4.1-flash]

Tiers:
  🦾 Fast — MiniMax-M3, meta/muse-spark-1.2-contributor, deepseek-v4.1-flash, ...
  🧠 Smart — deepseek-v4.1-flash, meta/muse-spark-1.2-contributor

Session:
  Turns: 12   Upgrades: ↑2   Downgrades: ↓1
  Manual override: ✗
  Orchestration: 🪄 auto (idle)
  Last audit: ✓ clean (self-executed)
  Cache-aware: 🎯 same-family (θ ÷ 1.5, warm-cache guarded)
  Economics: 🚗 mode default  R=3 (θ=0.33 → 0.22 eff (same-family ÷1.5))  downgrade streak ≥ 2 fast
  Cooldowns: none

Stats:
  ...

Detail:
  Window: [f, f, s]  (3 entries)
  Counts: S=1 F=2

Config: /…/.pi/pi-shift-router.json
```

- **`Economics`** — the money line: the active **mode** (`eco` / `default` / `sport` / `custom`), **R** (rework penalty), the base θ `1/R`, and — when Fast & Smart share a provider — the **effective θ** after the same-family cache divisor. Too many downgrades → lower R (`/router eco` or a higher R); too few → raise R (`/router sport`). A legacy `window.threshold` (non-default value) still active is flagged here.
- **`Cache-aware`** — same-family setups divide θ by `sameFamilyPenalty` and suppress warm-cache downgrades; cross-family shows `—`.
- **`Last audit`** — the most recent delegated-run acceptance audit. `(self-executed)` means the turn did the work itself and was exempt.
- **`Cooldowns`** — models currently in exponential backoff after failover signatures, with retry ETA.
