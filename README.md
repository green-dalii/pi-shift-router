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
- latest: v1.6.0
- last-updated: 2026-09
- alternate-names: shift router, pi extension, model router, two-tier router, auto router, tier model router, model failover router
- search-intents: "why route between models", "provider model tiers pricing spread", "LLM routing cost savings", "OpenRouter auto router alternative", "Jev how it works", "TypeSafe Jev decision model", "Jev calibrated probability router", "decision model HTTP API", "auto-route pi agent turns", "pluggable judge model", "Jev judge pi", "decision model router judge", "LLM as classifier", "two-tier model routing", "model failover on 429", "model failover on 402 insufficient balance", "codex usage limit failover", "cost vs quality model selection", "pi-coding-agent extension", "model cooldown exponential backoff", "JSON-mode classifier", "pi-shift-router vs pi-bifrost", "pi-shift-router vs pi-smart-router", "auto switch models in pi agent", "task-level orchestration pi", "Smart CTO delegates to Fast subagents", "pi agent subagent orchestration", "per-worker cost attribution", "orchestration cost tracking pi", "TUI status dashboard pi", "pi model registry alignment", "router config matches /model", "ModelRegistry available snapshot"
- features: two-tier routing, task-level orchestration (Smart CTO delegates to Fast engineers), pluggable judge (reuse Fast chain / dedicated Judge LLM / decision model such as Jev — explained in the How-Jev-fits-in section), LLM judge, JSON-mode classifier, sliding-window downgrade gate, multi-model fallback chains, TUI config wizard, exponential-backoff runtime failover (429/402/5xx + Codex usage-limit exhaustion), shared cooldown map between routing and Judge, cache-aware routing (same-provider cache protection), cross-provider native, zero-config defaults, token throughput telemetry, TUI status dashboard (context-window + cache-hit gauges, chains with inline cooldowns, last decision, money), per-worker cost attribution (bounded orchestration ledger, `orchestration $X (N workers)`), EV economics routing with gear presets (eco/default/sport), task-level orchestration (on by default: Smart CTO delegates to Fast subagents; requires pi-subagents), pi model-registry aligned catalog (wizard + Judge + telemetry share `/model`-equivalent list)
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
[![Node](https://img.shields.io/badge/node-%E2%89%A524-green)](https://nodejs.org)
[![deps](https://img.shields.io/badge/deps-host--pi--tui--only-blue)](package.json)
[![size](https://img.shields.io/badge/install%20size-~409kB-blue)](https://packagephobia.com/package/pi-shift-router)
[![CI](https://img.shields.io/github/actions/workflow/status/green-dalii/pi-shift-router/ci.yml)](https://github.com/green-dalii/pi-shift-router/actions)
[![Stars](https://img.shields.io/github/stars/green-dalii/pi-shift-router.svg)](https://github.com/green-dalii/pi-shift-router)

[English] | [简体中文](README.zh-CN.md)

[🌐 Project site](https://shiftrouter.greenerai.top) | [⚙️ How it works](#how-it-works) | [🚀 Why now](#why-now) | [🧭 Jev: a judge that answers with a number](#jev-a-judge-that-answers-with-a-number-optional-backend-v170) | [⚖️ vs. the alternatives](#vs-the-alternatives) | [❓ FAQ](#faq) | [🔧 Configuration](docs/CONFIG.md) | [🩺 Troubleshooting](docs/TROUBLESHOOTING.md)

You already pay for two tiers of intelligence. You just can't use them per turn.

Every message you send makes the same silent bet: **is this task hard enough to deserve the expensive model?** Bet high and you burn money on `rename a variable`. Bet low and the model you picked writes a shallow fix for an architecture problem. So most people pick one model, set it forever, and quietly accept both losses.

pi-shift-router removes that bet. Before each turn, a tiny judge reads your message and picks a tier — then that tier drives the whole turn: thinking, tool calls, edits. You configure two chains; the router spends the expensive one only where it changes the outcome.

It runs as a [pi-coding-agent](https://github.com/earendil-works/pi) extension — no separate server, no per-call setup; `pi install`, restart, it just works.

```text
🦾 [deepseek-v4.1-flash] → fix the failing test
🧭 judging…
🧠 [claude-fable-5]              ← "design the auth flow" → upgraded instantly
⚠️ deepseek-v4.1-flash 429 → switching to glm-5.3-flash — retry in 1m
🦾 [glm-5.3-flash]                    ← same-tier failover
```

And when the task is genuinely large, routing alone is not enough — the Smart tier stops being a single model and becomes a **CTO**: it plans the work, delegates implementation to Fast engineer subagents, reviews each result, and iterates. We call that **task-level orchestration**, and it is on by default for complex work.

> **Prerequisite for orchestration:** advanced orchestration (Smart CTO delegating to Fast subagents) requires the [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) extension (`pi install npm:pi-subagents`). Without it, the router keeps working exactly as before — base two-tier routing only; complex tasks run on the Smart tier directly, no delegation.

- **Upgrades are instant**; downgrades need 2 consecutive "fast" turns — no mid-session bouncing.
- Per-tier fallback chains plus exponential-backoff cooldown on 429/5xx — turns keep flowing.
- One config file — a no-op until you pick models; then routing just works. The only runtime dependency is the host-provided `@earendil-works/pi-tui`.

```bash
pi install npm:pi-shift-router   # then: /router config → /router status
```

---

## Why now

Three things changed in the last year, and together they make per-turn routing the obvious default instead of a clever hack.

**1. Providers tiered their own families — the spread is enormous.**

| Family | Cheapest tier | Strongest tier | Spread |
|---|---|---|---|
| OpenAI | GPT-5.6 **Luna** $0.20/M | GPT-5.6 Sol $5 → GPT-6 Astra $10 | **50×** |
| Anthropic | Haiku 4.5 $1 | Opus $5 → Fable 5 $10 | **10×** |
| Google | Gemini Flash-Lite $0.10 | Flash $0.75 → 3.1 Pro $2 | **20×** |
| GLM | **5.3-Flash** $0.15 | GLM-5.3 $1.40 | **9×** |
| MiMo | $0.14 | $1.31 | **9×** |
| DeepSeek | V4.1 **Flash** $0.30 | V4 Pro $1.32 | **4×** |

Prices are input $/M from pi's own bundled catalog (41 providers, **1443** priced models) — open `/model` and check them yourself. The cheap tier is often *enough*: Z.ai ships GLM-5.3-Flash at a ninth of GLM-5.3's price, and one independent comparison found MiMo-V2.6-Flash **beating** the Pro tier on a benchmark while costing a third as much. "Bigger is better" is not a strategy; matching is.

**2. Aggregators pooled hundreds of models — which makes the choice too big to make by hand.**

OpenRouter alone lists **380** priced models, spanning **1579×** from Mistral Nemo ($0.019) to GPT-5.5 Pro ($30). Add Cloudflare AI Gateway (51), Vercel (236), `opencode` (70), Ollama's cloud models, and flat-rate pools like OpenCode Go's **28 models for $10/month** — where the marginal cost of switching is zero, so *not* routing is pure waste.

**3. The judge itself became a model class.**

Classifying a turn used to mean calling a frontier LLM and parsing JSON out of its prose. In September 2026 TypeSafe shipped **Jev**, the first *System One* model: you send a state and typed questions, it returns typed answers with calibrated probabilities, and it never generates a sentence. LiteLLM benchmarked the same idea inside its Auto Router and measured the `jev` classifier at **5.43× faster and 96% cheaper than a Haiku-class LLM classifier**.

The last mile was always "something has to pick, on every single turn." That something is now cheap. Read [why a decision model is a better judge](#jev-a-judge-that-answers-with-a-number-optional-backend-v170) — and what we *don't* claim for it.

---

## vs. the alternatives

| | What it does well | What it doesn't |
|---|---|---|
| **OpenRouter Auto Router** | Zero-config, market-driven model choice, `cost_tier` knob. Great for a raw API. | It optimizes for *quality*, not your bill — OpenRouter's own docs say routing to an expensive model "is working as designed". You don't set the tiers, see the verdict, or control the failure mode. |
| **Cloudflare AI Gateway Dynamic Routing** | Versioned routing flows with quotas and fallbacks, at the gateway. | You author the graph per gateway, and it sees *requests*, not *tasks* — no notion of "this turn is architecture work". |
| **A single strong model** | Never picks wrong. | You pay flagship rates for `fix the typo`, forever. |
| **Doing it by hand** | Free. | Until the first time you forget to switch back — which is the whole problem. |

**Where we differ in one line:** we route on *task shape*, inside your agent, with your chains — and every verdict is visible (`/router status`), with a two-tier split you define, in a place that also survives rate limits and 402s.

---

## How it works

One cheap call per turn: the fast-tier model (usually your cheapest) reads your message, marks it `fast` (routine) or `smart` (consequential), and says **how sure it is** (confidence 0–1). That's the router's only classification — the chosen tier then does the work.

**Start from the asymmetry — everything else follows.** Every switch can be wrong two ways, and they don't cost the same:

- **Upgrade a simple task** (pay smart rates for something routine): you overpay once — small, bounded, visible.
- **Keep a hard task on the cheap model**: it fumbles, you redo the whole turn, and you pay for the smart model anyway — plus your time. Usually several times the first mistake.

So a router that can't perfectly tell "simple" from "hard" shouldn't bet at 50/50. **When a task might be hard, the cheap option is the risky one.** The bar is tilted toward spending:

> **Run smart whenever the chance this turn needs it is ≥ θ; otherwise run fast.** Default **θ ≈ 0.33**.

**Confidence *is* that chance.** The judge says `smart` with confidence `c` → chance `c`. It says `fast` with confidence `c` → chance `1 − c` (a confident `fast` means "almost certainly simple"). So:

| Judge says | confidence | chance smart is needed | vs θ | result |
|---|---|---|---|---|
| `smart` | 0.9 | 0.9 | ≥ | 🧠 smart |
| `smart` | 0.2 | 0.2 | < | 🦾 fast — weak verdict overridden |
| `fast` | 0.9 | 0.1 | < | 🦾 fast |
| `fast` | 0.6 | 0.4 | ≥ | 🧠 smart — "not sure it's simple" |
| any | < 0.5 | (no signal) | — | hold — stay put, don't guess |

**Where 0.33 comes from — the insurance math.** Treat the price difference as a premium you pay to avoid a fumble:

| strategy | expected cost | why |
|---|---|---|
| run smart | `f + Δ` | pays the premium up front; no fumble risk |
| run fast | `f + P·Δ·R` | skips the premium; if the task really needs smart (prob `P`), the fumble costs `R×` the price difference |

`f` = fast-tier cost, `Δ` = smart − fast (the premium), `R` = `reworkPenalty`, `P` = chance smart is needed. Run smart whenever it's cheaper on average:

```
f + P·Δ·R > f + Δ   ⟺   P > 1/R
```

The price difference cancels: **the rule doesn't care how expensive your models are — only how badly a fumble hurts relative to the price difference.** Default `R = 3` → θ ≈ 0.33: a one-in-three chance of needing smart is enough. **Higher R lowers the bar**: `R = 5` → θ = 0.2 (eager — `/router sport`), `R = 2` → θ = 0.5 (conservative — `/router eco`).

**Two guards stop it from bouncing:**

- **Upgrade is immediate** once pSmart ≥ θ; **downgrade needs 2 consecutive turns** below θ — one "thanks" never drops you.
- **Cache guard.** A prompt cache belongs to a model — switching tiers mid-session makes the next model re-read the whole conversation at full price. When Fast and Smart share a provider, the router divides θ further (fewer downgrades) and refuses to downgrade while the cache is warm. Upgrades are never affected; cross-provider setups share no cache, so nothing changes there.

The judge output format is strict so small models parse it reliably: OpenAI-compatible endpoints get `response_format: json_object` (non-JSON is rejected at the API), Anthropic gets a `{` prefill to force JSON output. The status bar shows `🧭 judging…` while it runs. If the judge fails, the router holds its current tier — it never guesses.

**Judge modes (v1.7.0).** `/router config` → 🧭 Judge has three modes: reuse the Fast tier chain (default — no extra config), a **dedicated Judge LLM chain** you edit like a tier, or a **decision model** (TypeSafe Jev / System One class). For how the Jev backend works end-to-end — request shape, response shape, threshold semantics, what the router does with the answer — see [Jev: a judge that answers with a number (Beta)](#jev-a-judge-that-answers-with-a-number-beta-backend-v170) below.

### When a provider goes down

429 / 402 / 5xx / quota / token-plan exhausted / Codex `usage limit` / account balance empty? pi retries first (3× provider, 3× agent); if it still fails, the router takes over:

1. The failing model enters exponential-backoff cooldown — 5xx starts at 1m (1m → 4m → 16m → 1h → 4h… capped at 6h), while a failover-worthy 4xx (429 rate limit / 402 Insufficient Balance / quota) skips the first two tiers and starts at 16m, because client-side limits (rate window or account balance) usually outlive server blips.
2. `setModel` switches immediately to the next healthy model in the **same** tier — never across tiers.
3. pi's pending retry lands on the fallback — same-turn failover.
4. Later turns skip cooled models; a 2xx response clears the cooldown; a session restart resets everything.

The judge shares the same cooldown map (it walks the full fast-tier chain before giving up). Manual override (`/route-force`) always bypasses cooldowns; auth/config errors (400/401) never trigger failover.

---

## Jev: a judge that answers with a number (Beta backend, v1.7.0+)

The Judge has one job: produce `p(smart)`. An LLM writes a sentence and hopes the router
can parse it. Jev — [TypeSafe's decision model](https://docs.typesafe.ai/introduction/quickstart) —
returns the probability itself.

> **Beta — opt-in, never the default.** Jev is in public beta: powerful and cheap, but
> less independently validated than an LLM judge (a September 2026 study found decision
> models trailing the best LLM on 14 of 15 annotation tasks) and its provider capacity is
> still ramping. So it is the **third** row in `🧭 Judge`, labelled Beta, and the default
> stays *reuse the Fast tier chain*. The router falls back either way: Jev → your LLM
> judge → routing off.

### Two kinds of model

| | LLM judge (default) | Jev (decision model) |
|---|---|---|
| Output | prose → parse as JSON | `choice` + probability per option |
| Failure mode | malformed JSON, refusal | a missing field |
| Billed | input **+ output** | input only |
| Explains | a `reason` it wrote | nothing — it writes no text |
| Signal | self-reported `confidence` | calibrated probability |

Jev has three primitives (Choice, Score, Noul). A router needs two: **Choice** for the
tier (`fast` / `smart`), **Noul** for orchestration (calibrated yes/no, read at `≥ 0.5`).
Both ride in one request.

### Why it is a better judge, not just a cheaper one

- **The router thresholds a number.** `pSmart ≥ θ` is arithmetic. Jev's answer needs no
  parsing step — and deleting a step deletes a failure class: no JSON mode, no malformed
  reply, no "judge failed → hold" because a model added a comma.
- **Every turn pays the bill.** The Judge runs before every message. With no output
  tokens, a verdict costs ~$0.0001.
- **Calibration is the input EV wants.** A wrong verdict costs twice — wrong tier, wrong
  spend — and `router.ts` prices it from a probability, not from a model's self-assessment.

The clever part: a classifier whose output *is* its consumer's input — a probability, in
the shape the router already reads.

### The same shape LiteLLM benchmarked

In September 2026 LiteLLM added a `jev` classifier to its Auto Router: **one `questions.tier` Choice whose `criteria` describe the configured tiers**, and the chosen tier then runs the completion — measured at **5.43× faster and 96% cheaper than a Haiku-class classifier**. That is this router's design too, built for a coding agent instead of a gateway: the judge picks a tier, that tier's chain drives the whole turn, and nothing else in the path changes.

### Jev is opt-in Beta; your LLM judge is the default and the fallback

`/router config` → `🧭 Judge` lists `🦾 Reuse the Fast tier chain (default)` first, then `🔬 Dedicated Judge LLM chain`, and Jev last (`🧮 Jev — decision model (Beta)`) — the legacy behaviour leads and the unproven option is opt-in. If Jev cannot be used — no authenticated endpoint, a retired model, a key you removed — **routing keeps working on the LLM judge** instead of stalling, the log records the degradation, and the menu tells you what is actually judging (`Jev unavailable — LLM judge active`).

The boundary stays sharp where it matters: a *configuration* that rotted degrades smoothly, but a *transient* failure (timeout, 5xx, malformed answer) still **holds** rather than silently swapping judges mid-flight. And the default stays `fast-chain`, so upgrading never re-judges you with a different model class unless you ask.

### Where we disagree with the hype

Decision models are a week old (in industry time) and the evidence is mixed: independent work in September 2026 found a decision model trailing the per-task best LLM on **14 of 15** annotation tasks. So we ship it as an explicitly **Beta, opt-in** row — labelled as such in the menu and placed after both LLM judges — while the LLM judge stays the default path. θ is left alone until it can be re-derived from measured data (v1.8.0).

### Request and answer

```jsonc
// POST /v1/systemone — both questions, one round trip
{
  "model": "jev-latest",
  "state": "<recent messages, assembled like the LLM Judge prompt>",
  "questions": {
    "tier":        { "type": "choice",  "instructions": "<judge.md rubric>",
                     "criteria": { "fast": "…", "smart": "…" } },
    "orchestrate": { "type": "noul",    "instructions": "…",
                     "criteria": { "true": "…", "false": "…" } }
  }
}
```

```jsonc
// real response, measured
{ "model": "jev-1.13.0",
  "answers": {
    "tier":        { "type": "choice", "choice": "fast",
                     "probabilities": { "fast": 0.99, "smart": 0.01 },
                     "confidence": 0.97 },
    "orchestrate": { "type": "noul", "noul": 0.13 } },
  "usage": { "input_tokens": 2265, "output_tokens": 50 } }  // output reported, not billed
```

| Field | What it decides |
|---|---|
| `tier.choice` | `fast` or `smart` — anything else ⇒ **hold** |
| `tier.probabilities[tier]` | the number θ eats (`0.99`) |
| `orchestrate.noul` | `≥ 0.5` ⇒ a smart verdict may delegate |
| `usage.input_tokens` | the only billed side |

> `confidence` is not a second opinion: it is `(N·p_max − 1)/(N − 1)` — the top probability
> rescaled (`0.99` → `0.97` above). So the router reads `probabilities[tier]`, and logs the
> **resolved** version, because a version move can shift the distribution behind θ.

### Use `jev-latest`, and watch the version

pi ships no Jev provider — add one to `~/.pi/agent/models.json`:

```jsonc
{ "providers": { "typesafe": {
    "baseUrl": "https://api.typesafe.ai",
    "api": "typesafe-decisions",     // the marker this router looks for
    "apiKey": "$TYPESAFE_API_KEY",   // or a literal key
    "models": [ { "id": "jev-latest", "name": "Jev", "input": ["text"],
                  "contextWindow": 64000, "cost": { "input": 0.042, "output": 0 } } ] } } }
```

`jev-latest` is the default on purpose. A pinned build fails the worst way: the day the
vendor retires it, the Judge stops working. The alias never retires, and its moves are
visible — the response always reports the resolved id, and the router logs it when it
changes. Pin `jev-1.13.0` only if you need byte-identical reproducibility.

Then `/router config` → `🧭 Judge` → `🧮 Jev — decision model (Beta)` → `typesafe/jev-latest`.
The wizard validates the choice locally (no network call at save time) and raises
`judgeTimeout` to 15 s (telling you when it does — the 5 s default would abort most
decision calls). If Jev stops answering, the router steps down the ladder instead of
stalling: **Jev → your LLM judge → routing off**, with the model you started the session
on restored and one notice. Keys come from the
[TypeSafe console](https://console.typesafe.ai/settings/keys); Jev is in early access.
Jev is judge-only here: it is filtered out of the Fast/Smart pickers, because pi cannot
stream that protocol as a chat model.

### Today's latency is beta capacity

Measured: **1.4–6.6 s** per verdict (median ~5 s), and a 5× smaller payload is no faster —
the wait is provider-side compute during Jev's public beta, not something an integration
can optimize away. Same rubric on a fast LLM judge: ~1.4 s.

So use decision mode where determinism and cost beat seconds — batch work, background
tasks, high-volume routing — and keep the LLM judge for interactive turns until beta
capacity improves — nothing here changes when it does, the protocol is the same. Either way, a failure
**holds**: a verdict is never fabricated, and never delegated to a model you did not pick.

### What we don't do

θ and `minConfidence` stay on the LLM scale; re-deriving them for calibrated probabilities
is v1.8.0 work (SPEC §2.3). No `reason` in the dashboard — a decision model writes nothing.
The audit log keeps the full response.

---

## Task-level orchestration (v1.0.0)

Turn-level routing picks *which model* runs a turn. Task-level orchestration picks *how a complex task executes*. When the judge says `smart` and orchestration is in `auto` mode (default), the router hands the turn to the Smart tier as a **CTO**: it plans the work, delegates implementation to Fast engineer subagents, reviews each result, and iterates until the work is clean — then does a final acceptance pass. Simple tasks (`fast` verdict) never trigger this; they stay on the plain router, byte-for-byte unchanged.

### How an orchestrated turn runs

1. **Enter.** Judge says `smart` → the router switches the main agent to the Smart model and injects an orchestrator instruction (your role, delegation rules, hard caps). The status bar shows live telemetry throughout: `[🧠 deepseek] • 42 tok/s` while the CTO plans (the wand 🪄 appears only once workers are actually spawned), then `🪄 Done(2)/Total(3) • ~30 tok/s` while Fast workers run.
2. **Plan.** The Smart agent decomposes the task into phases, each with acceptance criteria.
3. **Delegate.** For each phase it spawns a Fast subagent via the `subagent` tool — `agent: "worker"`, `context: "fresh"`, model pinned from your **Fast tier** — with a self-contained task contract (goal, constraints, acceptance criteria, files to touch).
4. **Review.** It reads each worker's result against the phase's acceptance criteria. Failed phases go back to a worker with concrete feedback — or the Smart agent takes over the phase itself after N failures.
5. **Accept.** It finishes with a short CTO summary and a final acceptance pass.

### Why fresh-context workers

Workers run with `context: "fresh"` — no inherited session history. The task string *is* their world, so it must be a precise contract: goal, constraints, acceptance criteria, out-of-scope. This keeps each worker's context small (fast, cheap, focused — a verified ~$0.004 narrow task vs ~$0.06 for an inherited 176k-token fork) and is the verified way to keep thinking enabled on anthropic-compatible endpoints, which otherwise force `thinking: off` in fork mode.

### Hard caps (the router's part)

The plugin enforces two numbers, independent of what the Smart agent wants:
- **`orchestration.maxRounds`** (default 3) — max delegate→review rounds per task.
- **`orchestration.escalationThreshold`** (default 2) — after N worker failures on a phase, the Smart agent takes over that phase itself.

The loop stops when either the Smart agent says done or a cap is hit.

### Acceptance audit (safety net under the CTO's review, v1.3.0, domain-restricted v1.4.0)

Because review is the Smart agent's own judgment, the plugin adds a **hard
fallback audit** at the end of every orchestrated turn that actually
**delegated to workers** (`spawned ≥ 1`, at `agent_end`). A self-executed
turn (`spawned = 0` — the CTO judged it simple enough to do itself) is
**exempt from the audit entirely**: no violations, no warnings, just a
`(self-executed)` marker in `/router status`. The CTO-summary output
contract only engages when workers were actually spawned.

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

An audit finding never blocks the already-finished turn; it **flags** —
`console.warn` + toast, and `/router status` shows `Last audit` for the most
recent orchestrated run. Toggle with `orchestration.audit.enabled` (default
`true`). The audit is the safety net under the CTO's own review: the loop
terminates hard, and acceptance claims are checked, not trusted.

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

|  | 🦾 **pi-shift-router** (this) | [@tenchi4u/pi-bifrost](https://pi.dev/packages/@tenchi4u/pi-bifrost?name=router&type=extension) | [pi-smart-router](https://pi.dev/packages/pi-smart-router?name=router&type=extension) |
|---|---|---|---|
| **How it decides** | ✅ **One LLM prompt, auditable as plain text** — if it's important, it upgrades; if it's routine, it stays | 7-step rules + history tricks — more cases, harder to reason about | 12-step local pipeline (no LLM) — most complex, heaviest to run |
| **Tiers** | ✅ **2 tiers — `fast` vs `smart`** · One mental model, whole codebase in an evening | 4 tiers (`quick` / `general` / `writing` / `frontier`) — more knobs, more to learn | 3 tiers including a local one (LM Studio / Ollama) — adds a local mode you'll rarely need |
| **Hard task?** | ✅ **The smart model orchestrates as CTO** — plans, splits work to fast engineers, reviews, iterates | Per-turn routing only — no orchestration | One helper call on the strong model — not a team |
| **Cost** | ✅ **Shows dollars saved** — every turn counted vs “what if all ran on smart?” (`/router status`) | Saves subscription quota, not dollars | Estimates cost with a formula (research-grade, not your bill) |
| **When provider fails** | ✅ **Keeps working** — same-tier fallback with smart cooldown (1m→6h), shared with the judge | Circuit breaker, may switch tiers on failure | Circuit breaker, falls back within tier only |
| **Cache** | ✅ **Protects your prompt cache** — cheaper never costs more | Keeps its own prompt cache | Also protects cache, different math |
| **Setup** | ✅ **~9 commands + one visual editor** — 5 min to ship | 4 files to merge, similar surface | 15+ env vars — steeper curve |
| **Weight** | ✅ **0 deps / ~409 KB** | 0 deps / 2.5 MB | Needs a local DB + ML model / ~2.5 MB + downloads |
| **Pick when** | ✅ **You want clear routing + real savings + orchestration out of the box** | You need rule-heavy routing + quota tricks | You want local-first + research telemetry |

---

## FAQ

### Does the judge add latency or cost?

A classification is a few thousand tokens billed at the fast tier's price (your cheapest), typically 200ms–2s round-trip; the status bar shows `🧭 judging…` while it runs. Against the cost of a missed upgrade, it's usually noise.

### Can tiers mix providers?

Yes. Each tier is an ordered list of `{provider, model, priority}` — combine freely.

### Will it downgrade Smart too early?

Downgrades need **two consecutive decisive fast decisions** (`economics.downgradeMemory`, default 2) plus the cache-aware idle gate — a single routine turn never drops you, and a hold (confidence < `minConfidence`) or any smart decision resets the streak. Tune `economics.reworkPenalty` (default 3, θ ≈ 0.33): raise it to 5 for cheaper routing, lower it to 2 to stay on Smart longer. Upgrades are always immediate on a decisive smart decision.

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
