<!--
SEO metadata (not user-visible, parsed by crawlers / LLMs):
- name: pi-shift-router
- type: software / npm package / pi-coding-agent extension / model router / LLM classifier
- license: MIT
- language: TypeScript
- runtime: Node.js >= 24
- dependencies: @earendil-works/pi-tui only (host-provided; declared as a dependency for isolated-subtree install)
- npm: https://www.npmjs.com/package/pi-shift-router
- repo: https://github.com/green-dalii/pi-shift-router
- docs: README.md / README.zh-CN.md / docs/CONFIG.md / docs/MODELS.md / docs/TROUBLESHOOTING.md
- first-published: v0.4.0
- latest: v1.7.0
- last-updated: 2026-09
- alternate-names: shift router, pi extension, model router, two-tier router, auto router, tier model router, model failover router
- search-intents: "why route between models", "provider model tiers pricing spread", "LLM routing cost savings", "OpenRouter auto router alternative", "Jev how it works", "TypeSafe Jev decision model", "Jev calibrated probability router", "why a decision model beats an LLM judge", "purpose-built classifier for LLM routing", "judge that answers with a probability", "System One model routing", "decision model HTTP API", "auto-route pi agent turns", "pluggable judge model", "Jev judge pi", "decision model router judge", "LLM as classifier", "two-tier model routing", "model failover on 429", "model failover on 402 insufficient balance", "codex usage limit failover", "cost vs quality model selection", "pi-coding-agent extension", "model cooldown exponential backoff", "JSON-mode classifier", "pi-shift-router vs pi-bifrost", "pi-shift-router vs pi-smart-router", "auto switch models in pi agent", "task-level orchestration pi", "Smart CTO delegates to Fast subagents", "pi agent subagent orchestration", "per-worker cost attribution", "orchestration cost tracking pi", "TUI status dashboard pi", "pi model registry alignment", "router config matches /model", "ModelRegistry available snapshot"
- features: two-tier routing, task-level orchestration (Smart CTO delegates to Fast engineers), pluggable judge (reuse Fast chain / dedicated Judge LLM / decision model such as Jev (Beta, opt-in) — see the Jev section), LLM judge, JSON-mode classifier, sliding-window downgrade gate, multi-model fallback chains, TUI config wizard, exponential-backoff runtime failover (429/402/5xx + Codex usage-limit exhaustion), shared cooldown map between routing and Judge, cache-aware routing (same-provider cache protection), cross-provider native, zero-config defaults, token throughput telemetry, TUI status dashboard (context-window + cache-hit gauges, chains with inline cooldowns, last decision, money), per-worker cost attribution (bounded orchestration ledger, `orchestration $X (N workers)`), EV economics routing with gear presets (eco/default/sport), task-level orchestration (on by default: Smart CTO delegates to Fast subagents; requires pi-subagents), pi model-registry aligned catalog (wizard + Judge + telemetry share `/model`-equivalent list)
- direct-competitor: "@tenchi4u/pi-bifrost (7-stage heuristic + subscription quota) · pi-smart-router (12-stage local pipeline + HyDRA + Virtual Cost v2)"
- author: green-dalii (https://github.com/green-dalii)
- canonical: https://github.com/green-dalii/pi-shift-router/blob/main/README.md
-->

![pi-shift-router hero — routine turns stay on the cheap tier; a judge moment upgrades the work that matters to the strong tier, which plans and delegates to fast engineers](assets/hero.jpeg)

# pi-shift-router

> **Stop paying flagship prices for routine turns — and stop handing your hardest turns to a cheap model.**

[![npm](https://img.shields.io/npm/v/pi-shift-router.svg)](https://www.npmjs.com/package/pi-shift-router)
[![Downloads](https://img.shields.io/npm/dm/pi-shift-router.svg)](https://www.npmjs.com/package/pi-shift-router)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Agent](https://img.shields.io/badge/pi--agent-extension-purple)](https://pi.dev/packages/pi-shift-router)
[![Jev](https://img.shields.io/badge/judge-Jev%20(Beta)-blueviolet)](https://docs.typesafe.ai/introduction/quickstart)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-green)](https://nodejs.org)
[![deps](https://img.shields.io/badge/deps-host--pi--tui--only-blue)](package.json)
[![size](https://img.shields.io/badge/install%20size-~409kB-blue)](https://packagephobia.com/package/pi-shift-router)
[![CI](https://img.shields.io/github/actions/workflow/status/green-dalii/pi-shift-router/ci.yml)](https://github.com/green-dalii/pi-shift-router/actions)
[![Stars](https://img.shields.io/github/stars/green-dalii/pi-shift-router.svg)](https://github.com/green-dalii/pi-shift-router)

[English] | [简体中文](README.zh-CN.md)

[🌐 Project site](https://shiftrouter.greenerai.top) | [⚙️ How it works](#how-it-works) | [🚀 Why now](#why-now) | [🧭 Jev: a judge that answers with a number](#jev-a-decision-model-as-the-judge-beta) | [⚖️ vs. the alternatives](#vs-the-alternatives) | [❓ FAQ](#faq) | [🔧 Configuration](docs/CONFIG.md) | [🩺 Troubleshooting](docs/TROUBLESHOOTING.md)

You pay for two tiers of intelligence and can only use one of them per turn.

Every message you send is a bet: is this task hard enough to deserve the expensive model?
Bet high and you burn flagship money renaming a variable. Bet low and you get a shallow fix
for an architecture problem. So most people pick one model, set it forever, and eat both
losses.

This extension removes the bet. A small judge reads each message and picks a tier; that tier
then runs the whole turn — thinking, tool calls, edits. You configure two chains, and the
expensive one is spent only where it changes the outcome. It runs as a
[pi-coding-agent](https://github.com/earendil-works/pi) extension — no separate server, no
per-call setup.
extension: no server, no per-call setup.

```text
🦾 [deepseek-v4.1-flash] → fix the failing test
🧭 judging…
🧠 [claude-fable-5]              ← "design the auth flow" → upgraded instantly
⚠️ deepseek-v4.1-flash 429 → switching to glm-5.3-flash — retry in 1m
🦾 [glm-5.3-flash]                    ← same-tier failover
```

For genuinely large tasks, picking a model is not enough: the Smart tier turns into a CTO
that plans the work, delegates implementation to Fast subagents, reviews the results and
iterates. That is task-level orchestration, and it is on by default for complex work.

> **Orchestration needs [`pi-subagents`](https://www.npmjs.com/package/pi-subagents)**
> (`pi install npm:pi-subagents`). Without it the router works normally — complex tasks just
> run on the Smart tier directly, with no delegation.

The judge itself comes in three modes, and the third is a different kind of model: **Jev**,
a decision model that returns a probability instead of prose. Nothing to parse, about
$0.0001 per turn, off by default and labelled Beta — [the honest case for it is here](#jev-a-decision-model-as-the-judge-beta).

- Upgrades happen immediately; downgrades wait for two consecutive `fast` turns.
- Each tier is a fallback chain with exponential-backoff cooldown, so a 429 does not end your session.
- One config file. Until you pick models, it does nothing.

```bash
pi install npm:pi-shift-router   # then: /router config → /router status
```

---

## Why now

Three things changed recently, and together they turned per-turn routing from a clever hack into a sensible default.

**1. Providers split their own families, and the price gap within a family is big.**

| Family | Cheapest tier | Strongest tier | Spread |
|---|---|---|---|
| OpenAI | GPT-5.6 **Luna** $0.20/M | GPT-5.6 Sol $5 → GPT-6 Astra $10 | **50×** |
| Anthropic | Haiku 4.5 $1 | Opus $5 → Fable 5 $10 | **10×** |
| Google | Gemini Flash-Lite $0.10 | Flash $0.75 → 3.1 Pro $2 | **20×** |
| GLM | **5.3-Flash** $0.15 | GLM-5.3 $1.40 | **9×** |
| MiMo | $0.14 | $1.31 | **9×** |
| DeepSeek | V4.1 **Flash** $0.30 | V4 Pro $1.32 | **4×** |

Prices are input $/M, from pi's bundled catalog (41 providers, **1443** priced models) — open `/model` and check them. The cheap tier is often enough: one independent comparison found MiMo-V2.6-Flash beating the Pro tier on a benchmark while costing a third as much.

**2. The choice itself got too big to make by hand.**

OpenRouter alone lists **380** priced models, spanning **1579×** from Mistral Nemo ($0.019) to GPT-5.5 Pro ($30). Add Cloudflare AI Gateway (51), Vercel (236), `opencode` (70), Ollama's cloud models, and flat-rate pools like OpenCode Go's 28 models for $10/month, where switching costs nothing extra.

**3. Judging became a model class of its own.**

Classifying a turn used to mean calling a frontier model and parsing JSON out of its prose. In September 2026 TypeSafe shipped **Jev**, a *System One* model: send it a state and typed questions, get typed answers with probabilities, and no generated sentence. Using a classification model for a classification is both cheaper and less fragile — [details, and the catches](#jev-a-decision-model-as-the-judge-beta).

---

## vs. the alternatives

| | What it does well | What it doesn't |
|---|---|---|
| **OpenRouter Auto Router** | Zero-config, market-driven model choice, `cost_tier` knob. Great for a raw API. | It optimizes for *quality*, not your bill — OpenRouter's own docs say routing to an expensive model "is working as designed". You don't set the tiers, see the verdict, or control the failure mode. |
| **Cloudflare AI Gateway Dynamic Routing** | Versioned routing flows with quotas and fallbacks, at the gateway. | You author the graph per gateway, and it sees *requests*, not *tasks* — no notion of "this turn is architecture work". |
| **A single strong model** | Never picks wrong. | You pay flagship rates for `fix the typo`, forever. |
| **Doing it by hand** | Free. | Until the first time you forget to switch back — which is the whole problem. |

The difference in one sentence: this routes on the shape of the task, inside your agent, between two chains you define — and you can see every verdict in `/router status`.

---

## How it works

One cheap call per turn. The fast-tier model (usually your cheapest) reads your message and
marks it `fast` (routine) or `smart` (worth the good model), with a confidence between 0 and 1.
That is the only classification in the system; the chosen tier then runs the whole turn.

**Why the default leans toward spending.** A wrong switch costs very different amounts
depending on which way it goes. Upgrading a simple task wastes the price difference once.
Keeping a hard task on the cheap model costs a redo, plus the smart model anyway, plus your
time. So the router should not split 50/50:

> Run smart when the chance this turn needs it is at least θ. Default **θ ≈ 0.33**.

Confidence is that chance. A `smart` verdict at confidence 0.9 means 90% likely needed; a
`fast` verdict at 0.9 means 10%, so a very confident `fast` is the strongest signal to stay
cheap. A verdict below `minConfidence` (0.5) is ignored and the router stays where it is.

| Judge says | confidence | chance smart is needed | result |
|---|---|---|---|
| `smart` | 0.9 | 0.90 | 🧠 smart |
| `smart` | 0.2 | 0.20 | 🦾 fast — the call was weak |
| `fast` | 0.9 | 0.10 | 🦾 fast |
| `fast` | 0.6 | 0.40 | 🧠 smart — "probably simple" is not simple enough |
| any | < 0.5 | — | hold: stay put rather than guess |

Where 0.33 comes from: the price difference between tiers cancels out of the comparison, so
the only thing that matters is how badly a fumble hurts relative to that difference
(`reworkPenalty`, default 3 — a fumble costs about 3× the price gap, so a one-in-three
chance of needing the good model justifies it). `/router sport` raises the penalty to 5 and
makes routing eager (θ = 0.2); `/router eco` lowers it to 2 and makes it conservative
(θ = 0.5).

**Two things keep it from bouncing.** Upgrades happen immediately; downgrades need two
consecutive `fast` turns. And when both tiers share a provider, the router raises the bar and
refuses to downgrade while the prompt cache is still warm, because switching mid-session
makes the next model re-read the whole conversation at full price.

The verdict has to be machine-readable, so OpenAI-compatible endpoints get
`response_format: json_object` (the API rejects non-JSON) and Anthropic gets a `{` prefill to
force JSON. The status bar shows `🧭 judging…` while it runs. If the call fails, the router
holds the current tier rather than guessing.

**Three judge modes (v1.7.0).** Reuse the Fast tier chain (default, no extra config), a
dedicated Judge LLM chain you edit like a tier, or a decision model — see
[Jev](#jev-a-decision-model-as-the-judge-beta).

### When a provider goes down

429 / 402 / 5xx / quota / token-plan exhausted / Codex `usage limit` / account balance empty? pi retries first (3× provider, 3× agent); if it still fails, the router takes over:

1. The failing model enters exponential-backoff cooldown — 5xx starts at 1m (1m → 4m → 16m → 1h → 4h… capped at 6h), while a failover-worthy 4xx (429 rate limit / 402 Insufficient Balance / quota) skips the first two tiers and starts at 16m, because client-side limits (rate window or account balance) usually outlive server blips.
2. `setModel` switches immediately to the next healthy model in the **same** tier — never across tiers.
3. pi's pending retry lands on the fallback — same-turn failover.
4. Later turns skip cooled models; a 2xx response clears the cooldown; a session restart resets everything.

The judge shares the same cooldown map (it walks the full fast-tier chain before giving up). Manual override (`/route-force`) always bypasses cooldowns; auth/config errors (400/401) never trigger failover.

---

## Jev: a decision model as the judge (Beta)

The judge answers one question per turn: is this hard? Most routers ask an LLM and then
parse JSON out of the reply. Jev is a different kind of model — hand it a question with
options and it hands back the option plus a probability:

```jsonc
// POST /v1/systemone — what actually comes back
{ "model": "jev-1.13.0",
  "answers": {
    "tier":        { "choice": "fast", "probabilities": { "fast": 0.99, "smart": 0.01 } },
    "orchestrate": { "noul": 0.13 } } }
```

That response is everything the router needs. It compares `0.99` against θ and moves on, so
there is no JSON mode and no parse step, which removes the whole "the judge failed because a
model added a comma" category. A missing field means no verdict and the router holds. The same
call also answers the orchestration question (`noul ≥ 0.5`), so a complex turn needs one
judgment rather than two.

It is cheap for the same reason: a verdict costs input tokens only, about **$0.0001** per
turn. LiteLLM added the same idea to its Auto Router in September 2026 and measured a
`jev` classifier **5.43× faster and 96% cheaper** than a Haiku-class one.

### The catch

Jev is in public beta, and the honest version of that is:

- **It is slow right now.** We measure **1.4–6.6 s** per verdict (median ~5 s), and sending
  a 5× smaller prompt does not help — that is provider capacity still ramping, not something
  an integration can fix. The same rubric on a fast LLM judge takes ~1.4 s. Good for batch,
  background and high-volume routing; for interactive turns the LLM judge is still better.
- **The evidence is mixed.** A September 2026 independent evaluation found decision models
  behind the per-task best LLM on 14 of 15 annotation tasks.
- **So it is opt-in.** `/router config` → `🧭 Judge` lists both LLM options first and Jev
  third, labelled Beta. Upgrading does not change your default.

### Setting it up

pi ships no Jev provider, so add one to `~/.pi/agent/models.json`:

```jsonc
{ "providers": { "typesafe": {
    "baseUrl": "https://api.typesafe.ai",
    "api": "typesafe-decisions",     // the marker this router looks for
    "apiKey": "$TYPESAFE_API_KEY",
    "models": [ { "id": "jev-latest", "name": "Jev", "input": ["text"],
                  "contextWindow": 64000, "cost": { "input": 0.042, "output": 0 } } ] } } }
```

Keys come from the [TypeSafe console](https://console.typesafe.ai/settings/keys) (early
access). Then `/router config` → `🧭 Judge` → `🧮 Jev — decision model (Beta)` →
`typesafe/jev-latest`. Saving makes no network call, and the wizard raises `judgeTimeout`
to 15 s for you, because the 5 s default would cut off most decision calls. If Jev stops
answering, the router steps down to your LLM judge rather than stalling, and to plain
routing if that fails too. It never shows up in the Fast/Smart pickers: pi cannot stream
that protocol as a chat model.

---

## Task-level orchestration (v1.0.0)

Routing normally decides which model runs a turn. When the judge says `smart` and orchestration
is in `auto` mode (the default), the Smart tier also takes over *how* the turn runs: it plans
the work, delegates implementation to Fast subagents, reviews each result, and iterates until
the work is clean, then does a final acceptance pass. A `fast` verdict never triggers any of
this — those turns stay on the plain router.

### How an orchestrated turn runs

1. **Enter.** Judge says `smart` → the router switches the main agent to the Smart model and injects an orchestrator instruction (your role, delegation rules, hard caps). The status bar shows live telemetry throughout: `[🧠 deepseek] • 42 tok/s` while the CTO plans (the wand 🪄 appears only once workers are actually spawned), then `🪄 Done(2)/Total(3) • ~30 tok/s` while Fast workers run.
2. **Plan.** The Smart agent decomposes the task into phases, each with acceptance criteria.
3. **Delegate.** For each phase it spawns a Fast subagent via the `subagent` tool — `agent: "worker"`, `context: "fresh"`, model pinned from your **Fast tier** — with a self-contained task contract (goal, constraints, acceptance criteria, files to touch).
4. **Review.** It reads each worker's result against the phase's acceptance criteria. Failed phases go back to a worker with concrete feedback — or the Smart agent takes over the phase itself after N failures.
5. **Accept.** It finishes with a short CTO summary and a final acceptance pass.

### Why workers get a fresh context

Workers run with `context: "fresh"`, inheriting no session history: the task string is all
they get, so it has to be a precise contract (goal, constraints, acceptance criteria,
out-of-scope). That keeps each worker small and cheap — measured ~$0.004 for a narrow task
against ~$0.06 for an inherited 176k-token fork — and avoids the anchoring that makes a
forked agent defend a plan it did not write.

### Hard caps

Two numbers are enforced by the plugin, not by the prompt:
- **`orchestration.maxRounds`** (default 3) — max delegate→review rounds per task.
- **`orchestration.escalationThreshold`** (default 2) — after N worker failures on a phase, the Smart agent takes over that phase itself.

The loop stops when either the Smart agent says done or a cap is hit.

### Acceptance audit

Review is the Smart agent's own judgment, so the plugin adds a second opinion at
the end of any orchestrated turn that actually delegated (`spawned ≥ 1`, checked at
`agent_end`). A turn the CTO did itself (`spawned = 0`) skips the audit entirely —
no warnings, just a `(self-executed)` marker in `/router status`.

1. **Deterministic checks (free):** every spawned worker reported back
   (`done == spawned`), the final message carries a **CTO summary**
   (the output-contract markers), and whether the run ended at a hard cap.
2. **LLM audit (on by default, one small fast-tier call):** the auditor prompt
   reads the **original user goal** (captured when orchestration entered),
   the CTO summary, and the worker results, and checks three dimensions:
   - **Grounding** — the acceptance claim is backed by actual results (no
     "done" without review, no ignored worker failures, no contradictions).
   - **Goal alignment** — the delivered work actually addresses the user's
     request (no scope drift, core ask answered).
   - **Delivered quality** — worker outputs are complete, not placeholders/
     TODOs passed off as done, no empty results, no "could not finish".

An audit finding never blocks the finished turn: it flags (`console.warn` plus a
toast), and `/router status` shows `Last audit` for the most recent run. Turn it off
with `orchestration.audit.enabled` (default `true`). This is the one part of the loop
that does not trust the CTO's own review.

### When it doesn't engage

- **Simple tasks** (`fast` verdict) — plain routing, always. Orchestration is never forced on routine work.
- **`pi-subagents` not installed** — complex tasks run on the Smart tier directly, exactly as before. No crash, no deadlock.
- **Orchestration set to `off`** (`/router orchestrate off`) — plain two-tier routing only.

---

## When it pays off / when it doesn't

**Worth it when**

- Your session is long and mixed: dozens of routine turns with the occasional consequential one. Routine stays on the cheap tier, the important work upgrades automatically — no manual model switching.
- You want a sticky deep mode: planning sessions stay on the strong tier, then drop back once you're editing files.
- You worry about provider rate limits. With 2–3 models per tier, 429/5xx fail over automatically within the tier.

**Not worth it when**

- Your session is uniformly easy or uniformly hard. Every classification is then pure overhead — roughly 200ms–2s plus a few thousand tokens per turn.
- You never configure the tiers. Both start empty and the router is a no-op.
- You don't trust the fast-tier model's judgment. The classification is only as good as the model you give it; when it's wrong, it conservatively stays put.

---

## Quick start

Prerequisites: Node.js ≥ 24, pi-agent ≥ 0.80, a provider account (API key in pi-agent's `auth.json`), and one model for each tier.

**1. Install**

```bash
pi install npm:pi-shift-router
```

Local checkout: `pi install <path-to-repo>`. From git: `pi install git:github.com/green-dalii/pi-shift-router`. Installation registers the extension in `~/.pi/agent/settings.json` and loads it on the next pi launch.

**1.5. (Recommended) Enable orchestration**

```bash
pi install npm:pi-subagents   # Smart CTO → Fast subagent delegation
```

Orchestration is **on by default** (`auto` mode); this installs the subagent machinery it delegates to. Without it, the router still works — plain two-tier routing only.

**2. Configure**

```text
/router config
```

Pick a model for the Fast tier and one for the Smart tier — several per tier also works and forms a fallback chain. Save to user or project scope; when both exist, project wins. **The picker shows the same configured/auth'd models pi's `/model` shows** (since v1.6.0 — reads pi's own `ModelRegistry`, not a re-derived local catalog).

The wizard also exposes **🔒 Cache-aware routing** — on by default when your Fast and Smart tiers share a provider (e.g. both Anthropic). It protects your prompt cache: the effective smart bar θ is divided by `sameFamilyPenalty` (fewer downgrades) and mid-session downgrades are suppressed while the cache is warm, so routing to a cheaper model never costs more than staying put. Toggle it there, or via the config file (`routing.cacheAware.enabled`).

**3. Verify**

```text
/router status
```

A themed dashboard opens (q / Esc closes): your live tier and model, context-window and cache-hit gauges, last routing decision, session savings (plus worker spend when orchestrating), both chains with cooldowns inlined, and a plain-language "how routing decides" section. Your next message triggers the first classification.

---

## Commands

| Command | What it does |
|---|---|
| `/router status` | Open the status dashboard (TUI): live model, last decision, money, chains, health, config layer |
| `/router on` / `/router off` | Enable / disable routing |
| `/router config` | Launch the TUI configuration wizard |
| `/router quiet` | Toggle inline toast notifications |
| `/router verbose` | Toggle verbose logging |
| `/router eco\|default\|sport` | Gear-shift economics presets (persisted): **eco** → R=2 (θ=0.5, cheaper — only clearly-needed turns run smart), **default** → R=3 (θ≈0.33), **sport** → R=5 (θ=0.2, eager — any real chance of needing Smart escalates). Top-level words so pi tab-completes them; `/router status` shows the current gear in plain language |
| `/router orchestrate auto` | Task-level orchestration (default): complex tasks → Smart CTO delegates to Fast subagents; simple tasks stay on the plain router |
| `/router orchestrate off` | Disable orchestration — plain two-tier routing only |
| `/route-force <tier>` | Pin a tier for the next turn |
| `/route-force <provider>/<model>` | Pin a specific model for the next turn |
| `/route-force auto` | Clear manual override |

> **Native model picks vs router authority (strict takeover).** The router owns
> model selection while enabled (SPEC §2.4): on every turn `before_agent_start`
> guarantees the active model is the routed tier's best available model. Using
> pi's own switcher (`/model`, `Ctrl+P`) runs for the current turn, then the
> next routing point re-asserts the tier chain. To take full manual control run
> `/router off` (status bar shows `⛔`); `/route-force` pins a tier/model for
> the session.

`/router status` also reports **cost telemetry** — per-tier spend and how much routing saves you:

```
Money · this session
  saved   $2.742 of $3.210  (85%)  vs all-smart: opencode-go/deepseek-v4.1-flash
  spent   $0.465  fast ▓░░░░░░░░░ 10% · smart ▓▓▓▓▓▓▓▓░░ 90%
  orchestration  $0.0689  (5 workers)
```

The **orchestration** row appears only when delegated workers actually spent
something this task — each worker's `usage.cost.total` lands in a bounded
per-worker ledger (last 20) and accumulates into the task total, so
delegation cost is never hidden inside the main-agent figures.

The baseline asks: *what would this session have cost if every turn ran on your configured Smart-tier model (priority 1) — i.e. no router?* The difference is your savings. If pricing is missing (fully-local session with no `models-store.json` pricing), it shows `baseline: unavailable` instead of a made-up number.

### Other pi routers

|  | pi-shift-router (this) | [@tenchi4u/pi-bifrost](https://pi.dev/packages/@tenchi4u/pi-bifrost?name=router&type=extension) | [pi-smart-router](https://pi.dev/packages/pi-smart-router?name=router&type=extension) |
|---|---|---|---|
| **How it decides** | One LLM prompt you can read in `src/prompts/judge.md` (or a decision model) | 7-step rules plus history heuristics | 12-step local pipeline, no LLM |
| **Tiers** | 2 (`fast` / `smart`) | 4 (`quick` / `general` / `writing` / `frontier`) | 3, including a local one via LM Studio / Ollama |
| **Complex tasks** | Smart tier orchestrates: plans, delegates to Fast workers, reviews | Per-turn routing only | One helper call on the strong model |
| **Cost** | Dollars saved per session, measured against an all-smart baseline | Saves subscription quota rather than dollars | Cost estimate from a formula, not your bill |
| **Provider failure** | Same-tier fallback with cooldown (1m → 6h), shared with the judge | Circuit breaker, may switch tiers | Circuit breaker, within tier only |
| **Prompt cache** | Raises the downgrade bar and holds while the cache is warm | Keeps its own cache | Also protects the cache, different math |
| **Weight** | 0 dependencies, ~409 KB | 0 dependencies, 2.5 MB | Needs a local DB and model, 2.5 MB plus downloads |

All three are real choices; the differences are in how much machinery sits between your
message and the model.

---

## FAQ

### Does the judge add latency or cost?

A classification is a few thousand tokens billed at the fast tier's price (your cheapest), typically 200ms–2s round-trip; the status bar shows `🧭 judging…` while it runs. Against the cost of a missed upgrade, it's usually noise.

### Can tiers mix providers?

Yes. Each tier is an ordered list of `{provider, model, priority}` — combine freely.

### Will it downgrade Smart too early?

Downgrades need **two consecutive decisive fast decisions** (`economics.downgradeMemory`, default 2) plus the cache-aware idle gate — a single routine turn never drops you, and a hold (confidence < `minConfidence`) or any smart decision resets the streak. Tune `economics.reworkPenalty` (default 3, θ ≈ 0.33): raise it to 5 for cheaper routing, lower it to 2 to stay on Smart longer. Upgrades are always immediate on a decisive smart decision.

### How do I set up Jev as the judge?

Three steps:

1. **Get a Jev API key.** Jev is in early access; create one in the [TypeSafe console](https://console.typesafe.ai/settings/keys). Store it like any other provider credential — in `~/.pi/agent/auth.json`, or export `TYPESAFE_API_KEY` in your shell.
2. **Register the provider in `~/.pi/agent/models.json`** — this is what the wizard reads to find Jev:
   ```jsonc
   { "providers": { "typesafe": {
       "baseUrl": "https://api.typesafe.ai",
       "api": "typesafe-decisions",     // the marker this router looks for
       "apiKey": "$TYPESAFE_API_KEY",
       "models": [ { "id": "jev-latest", "name": "Jev", "input": ["text"],
                     "contextWindow": 64000,
                     "cost": { "input": 0.042, "output": 0 } } ] } } }
   ```
3. **Pick Jev in the wizard.** Restart pi, then `/router config` → `🧭 Judge` → `🧮 Jev — decision model (Beta)` → `typesafe/jev-latest`. The wizard validates the choice locally (no network call) and raises `judgeTimeout` to 15 s, because the 5 s default would cut off most decision calls.

### Can I just ask pi to set it up for me?

Yes. The router ships with everything Jev needs to know, so you can hand pi the task and it handles `models.json`, the key resolution and the restart. Send pi something like:

> Add a TypeSafe Jev model to my pi config so pi-shift-router can use it as the judge. I already have `TYPESAFE_API_KEY` exported. After you edit `~/.pi/agent/models.json`, restart the agent and open `/router config` → `🧭 Judge` to confirm `🧮 Jev — decision model (Beta)` is selectable. Tell me what went wrong if anything.

…or, in Chinese:

> 帮我在 pi 里接入 TypeSafe Jev，让 pi-shift-router 用它当判定器。我已经把 `TYPESAFE_API_KEY` 导出了。改完 `~/.pi/agent/models.json` 后重启一次，然后打开 `/router config` → `🧭 Judge`，确认 `🧮 Jev — decision model (Beta)` 能选；任何问题都告诉我。

### Why doesn't Jev show up in my Judge menu?

The wizard only lists decision-capable providers. Check three things, in order:

- The provider entry in `~/.pi/agent/models.json` has `api: "typesafe-decisions"` (not `openai-completions` or anything else). That is the marker the router reads.
- The `models` array contains at least one Jev model id (`jev-latest`, `jev-1.13.0`, `jev-preview`).
- `TYPESAFE_API_KEY` resolves — `echo "$TYPESAFE_API_KEY"` should not be empty.

If all three check, restart and reopen `/router config`; the Jev row should be present and labelled Beta.

### How is this different from OpenRouter's Auto Router?

Auto Router picks from the *whole market* and optimizes for quality — its own docs note that an expensive pick "is working as designed". This router picks between **two chains you defined**, inside your agent, on the *task shape* of the turn. You set the tiers, you see every verdict in `/router status`, and the failure modes (429/402 failover, cooldown) are yours to configure. They compose: point a tier at an OpenRouter model if you like.

### What if the judge picks the wrong tier?

Upgrades are instant, downgrades need two consecutive `fast` verdicts, and a low-confidence verdict is ignored entirely (`window.minConfidence`) rather than acted on. If the judge itself fails, the router holds its current tier instead of guessing — and if your judge *configuration* became unusable (retired model, removed key), it falls back to the LLM judge and says so. `/router status` shows the recent verdict window, so you can see whether the threshold matches your work.

### Do I need multiple providers?

No. Two chains from one provider already pay off — every family spans 4–50× in price, and cache-aware routing keeps same-provider switches from paying full price for a repeated prompt. Multiple providers add failover: when one returns 429 or `Insufficient Balance`, the next in the chain takes the turn.

### Can I disable it without uninstalling?

`/router off` disables it and `/router on` re-enables it; the switch persists in the config file.

### What triggers orchestration?

Only a `smart` verdict on a complex task — with orchestration in `auto` mode (default). Simple tasks (`fast`) never orchestrate; they stay on the plain router. See [Task-level orchestration](#task-level-orchestration-v100).

### Does orchestration cost more?

The Smart tier plans and reviews; the Fast tier implements — workers run `fresh`-context, so each is small and cheap (~$0.004 for a narrow task vs ~$0.06 for an inherited 176k-token fork). The judge still costs its normal single classification call. If a task turns out simple, the orchestration machinery never engages.

### How do I know a turn orchestrated?

`/router verbose` prints `🪄 orchestrating` when the orchestrator instruction is injected. `/router status` shows `Orchestration: 🪄 auto (idle)` normally, `(active)` during an orchestrated run, or `✗ (off)` when disabled.

---

## Reference

- [Configuration & tuning](docs/CONFIG.md) — JSON schema, defaults, `/router status`, economics / θ calibration
- [Model pairings](docs/MODELS.md) — coding plans, local quantized models, same-provider ladder, cross-provider
- [Troubleshooting](docs/TROUBLESHOOTING.md) — judge parse failures, missing models, repeated downgrades
- [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

---

## See also

- **[dsh-shift-router](https://github.com/green-dalii/dsh-shift-router)** — a sister project: the same two-tier routing architecture (LLM Judge, multi-model fallback chains, exponential-backoff failover, task-level orchestration) adapted for the **DeepSeek Harness** instead of pi-coding-agent. Uses `dsh plugin` to install; lives in the `cordis.patch.yml` profile layer. By the same author.
- **[obsidian-llm-wiki](https://github.com/green-dalii/obsidian-llm-wiki)** — an Obsidian plugin that turns your notes into a connected, queryable knowledge base. The Karpathy LLM Wiki idea, built into the editor where you already write. Graph retrieval works without embeddings; ten interface languages; works with every LLM provider. Local-first, no backend, GDPR-friendly. By the same author.

---

## Acknowledgements

- **[pi-coding-agent](https://github.com/earendil-works/pi)** by earendil-works — the host agent.
- **[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)** — TUI primitives used by the config wizard.
- **Peer routers compared above** — [@tenchi4u/pi-bifrost](https://github.com/the-matt-moo/pi-bifrost) and [pi-smart-router](https://github.com/beettlle/pi-smart-router), same problem, different trade-offs; see [vs. the alternatives](#vs-the-alternatives).

**Author & License** — pi-shift-router by [green-dalii](https://github.com/green-dalii), licensed under [MIT](LICENSE) © 2026.
