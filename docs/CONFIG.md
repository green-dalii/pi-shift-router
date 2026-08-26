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

- `routing.judgeTimeout`, `routing.window.minConfidence`, `routing.window.threshold`
- `ux.quietMode`, `ux.routerLogVerbose`

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
│   │   ├── size               sliding-window length; default 5
│   │   ├── threshold          fast-share weight that triggers downgrade; default 0.6
│   │   └── minConfidence      votes below this are ignored; default 0.5
│   └── cacheAware
│       ├── enabled            raise downgrade threshold + guard warm cache; default true (same-family only)
│       ├── sameFamilyThreshold  downgrade threshold when enabled; default 0.9
│       └── idleBoundaryMs     idle gap that means "cache expired"; default 300000 (5 min)
└── ux
    ├── quietMode              suppress inline toasts; default false
    ├── statusBar              show 🦾 / 🧠 badge; default true
    ├── inlineToast            model-switch toasts; default true
    └── routerLogVerbose       debug logging; default false
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
    - { provider: deepseek,   model: deepseek-v4-flash, priority: 1 }
    - { provider: z.ai,       model: glm-5.2,           priority: 2 }
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
| `routing.window.size` / `threshold` | `5` / `0.6` | Sliding-window downgrade gate. |
| `routing.window.minConfidence` | `0.5` | Votes below this confidence are ignored. |
| `routing.cacheAware.enabled` | `true` | When fast & smart share a provider, raise the downgrade threshold and suppress mid-session switches while the prompt cache is warm (SPEC §9.2). Off for cross-family setups (no shared cache). |
| `routing.cacheAware.sameFamilyThreshold` | `0.9` | Downgrade threshold used when cache-aware is enabled (replaces `window.threshold`). |
| `routing.cacheAware.idleBoundaryMs` | `300000` | Idle gap after which the prompt cache is considered expired; downgrades are allowed again. |
| `ux.quietMode` / `statusBar` / `inlineToast` / `routerLogVerbose` | various | Display / logging controls. |
| `orchestration.mode` | `"auto"` | Task-level orchestration mode. `"auto"` (default): Judge-driven — simple tasks (fast verdict) keep the plain router; complex tasks (smart verdict) escalate to Smart-orchestrated execution (requires the `pi-subagents` extension; without it, behavior degrades to the plain smart-tier run). `"off"` (via `/router orchestrate off`): never orchestrate — byte-for-byte today's router. There is no "always" mode. |
| `orchestration.maxRounds` | `3` | Hard cap on delegate→review rounds per task; the loop stops when this is hit regardless of what the Smart agent wants. |
| `orchestration.escalationThreshold` | `2` | A worker failing ≥N times on a phase → Smart takes over that phase itself. |
| `orchestration.requireSmartModel` | `true` | When true and the Smart tier model can't be resolved, orchestration is skipped and the turn runs as today's smart-tier run (no crash). |

## Tuning guide

Every knob is a trade-off. Pick by workload:

| Your session looks like… | Try… | Why |
|---|---|---|
| Lots of routine work (CRUD, tests, docs); little architecture | `threshold: 0.5`, `minConfidence: 0.7` | Aggressive downgrade — fewer spurious Smart hits |
| Heavy architecture / planning / code review | `threshold: 0.8`, `minConfidence: 0.4` | Conservative downgrade — stay on Smart longer |
| Mixed — 20 fast turns then a planning burst | Defaults (`threshold: 0.6`, `minConfidence: 0.5`) | Balanced |
| Judge tends to over-confident (most votes ≥0.9) | `minConfidence: 0.7` | Strip the over-confident votes |
| Judge tends to uncertain (many 0.3–0.6 votes) | `minConfidence: 0.3` | Don't drop uncertain votes |
| Primary fast model keeps 429'ing | Add a second provider as `tiers.fast.models[1]` | v0.6.0 runtime failover picks it up |
| Heavy streaming / long agent runs | Watch `/router stats` tokens/sec | See per-turn throughput |

### Knob reference

**`routing.judgeTimeout`** (ms) — Judge API call timeout. Default `5000`. Raise on slow providers, lower on flaky networks.

**`routing.window.size`** — Sliding-window length. Default `5`. Larger is more stable (less reactive); smaller is more agile (more jitter).

**`routing.window.threshold`** (0–1) — weighted fast-share threshold for downgrade. Default `0.6`.
- `0.5`: a slight fast majority downgrades
- `0.6`: balanced (default)
- `0.8`: a strong fast majority required to downgrade
- `1.0`: never downgrade (sliding window disabled)

**`routing.window.minConfidence`** (0–1) — votes below this confidence are discarded. Default `0.5`. Set `0` to restore v0.6.0's equal-weight counting; `0.7+` counts only confident votes.

**`routing.cacheAware`** — cache-aware routing (SPEC §9.2). Prompt caches belong to a model: switching tiers mid-session forfeits the warm cache (cache reads bill 0.1x–0.5x of base input), so routing to a cheaper model can cost more, not less. When `enabled: true` **and** fast & smart share a provider family (auto-detected):
- the downgrade threshold is raised to `sameFamilyThreshold` (0.6 → 0.9) — fewer mid-session downgrades, and
- downgrades are suppressed within `idleBoundaryMs` (default 5 min) of the last message — the cache is warm; they only fire after the idle gap long enough that the cache has already expired.
Upgrades (fast → smart) are never affected. Cross-family setups are untouched. Toggle with `/router config → 🧠 Cache-aware routing`.

**`tiers.<tier>.models[]`** — ordered by priority. First is primary; rest are runtime fallbacks (v0.6.0). Put the cheapest healthy model first.

**`ux.routerLogVerbose`** — set `true` (or `/router verbose`) to log every decision to the console. Useful while calibrating `threshold`.

## Reading `/router stats`

> **Native model picks are display-only (Scheme A).** pi's own `/model` or
> `Ctrl+P` switcher only syncs the status bar — the router keeps per-turn
> model authority, so a native pick can be re-routed on the very next turn.
> Use `/route-force` for a one-turn pin, or `/router off` for full manual
> control. (v1.2.0+; documented as the explicit contract.)

```text
Tier: smart / p/claude-opus-5
Window: 3 entries (confidence: high=2 mid=1 low=0 none=0)
Transitions: ↑upgrade=1 ↓downgrade=0
Tokens: total 12,345 | speed current=23 avg=25 tok/s
Cooldowns: none
```

- **`high` / `mid` / `low` / `none`** — confidence distribution of the sliding-window entries. If `none` is high, your Judge isn't returning a confidence field (older prompt or old binary). Re-run `/router config` to refresh.
- **`avg tok/s`** — recent per-turn throughput. Use it to spot provider slowdowns.
- **`upgrade` / `downgrade`** — tier-switch counts. Too many downgrades → raise `threshold`; too few → lower it.
