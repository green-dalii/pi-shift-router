# MEMORY — pi-shift-router

Durable decision log: what was decided, why, what was rejected, and what must not
be forgotten. **Specs describe the present; MEMORY records the reasoning behind
it.** Update it whenever a decision is made that a future contributor (or the
agent, after context loss) would otherwise re-litigate.

Format: newest first. Keep entries short — decision, rationale, rejected
alternatives, gotchas. Detail belongs in SPEC.md / ROADMAP.md; link them.

---

## 2026-09-25 — G3 killed the dynamic effort half; static pins remain

**Decision.** Effort control ships as **static per-tier pins only**. The dynamic
boundary-step half (SPEC §9.5) is **shelved**: not planned, kept as design of record so it
is not re-derived.

**Why.** G3 was designed to be able to kill it, and it did. Histogramming the 123 verdicts
already in the router log: `pSmart` is strongly **bimodal** — 68% of verdicts sit in
0.8–0.9, and the neighbourhood of θ = 0.33 contains 1 verdict at 0.3 and 2 at 0.4. At
θ = 0.33 a band of 0.15 moves 4.9% of turns; 0.25 moves 14.6% and is the widest band that
still satisfies the ≥ 85% default contract. Two consequences do the killing:

1. **The `↓` direction never fires.** A smart verdict is always confident (pSmart ≥ 0.78
   in the sample), so the "expensive model on a task that didn't need it" case — the
   second of the two motivations for the feature — is simply not detectable from a
   self-reported confidence.
2. **The rate is gear-dependent.** The same band fires 3.3% of turns under `eco`
   (θ = 0.50) and **24.4% under `sport`** (θ = 0.20). A trigger whose frequency swings 7×
   with a setting the user changes for cost reasons is not a trigger we want to ship.

That leaves a feature that would cost the schema, the `setModel` funnel, baseline/sticky-
level handling, a wizard row, telemetry and tests in order to act on ~5% of turns in one
direction. The chart's actual value is a configuration fact (pin `high` on the fast tier
to extend its reach; know that `max` is dominated), which is Phase 1 and needs none of it.

**Caveats, recorded so the numbers are not over-read.** 123 verdicts, all from the
author's own sessions during verbose-log periods; the *bimodality* is the robust part, the
rates are order of magnitude. The sample also predates any effort feature, so it measures
the LLM judge's confidence shape, not a hypothetical decision-model one.

**What would revive the dynamic half.** A **first-class margin field from the Judge** — not
a band on self-reported confidence. A decision model can carry that question in the same
request for free, which is the cheapest route to testing it. It still needs its own gate:
show that the signal predicts required effort at all before building anything on it.

**Rejected.** *Widening the band to make the feature fire more* (0.30 breaks the sharpness
contract and is still 99% one-directional); *quantile-based triggering* (the least-
confident decile is confidence ≈ 0.78, i.e. semantically far from the boundary — it would
step effort down on verdicts the Judge is fairly sure are smart); *shipping the dynamic
half because it is already specified* (specification is not evidence).

**Records.** Contract: SPEC §9.5. Plan: ROADMAP sub-plan (Phase 2 marked shelved).
Tracking: [#43](https://github.com/green-dalii/pi-shift-router/issues/43).

## 2026-09-23 — Effort control revived: boundary-only, opt-in, asymmetric

**Context.** Tier routing exists because the capability/price gap between Fast and Smart
is large; that gap *is* the feature. But there is one region it cannot settle: a verdict
that lands just inside a tier's boundary, where the alternatives are a tier switch (loses
the prompt cache, 4–50× price) or leaving a marginal task on a tier that may be wrong
either way. Effort — how much the *already-chosen* model thinks — addresses exactly that
region, and only that region.

**Decision.** Ship effort as **three relative directions, opt-in, off by default**:
`default` (do not intervene; restore the session baseline), `high` (one supported notch
up), `low` (one supported notch down). Trigger is the **marginal band only**
(`|pSmart − θ| < band`) and the step is **one notch, never more**. Direction permission is
per tier: **fast = up only** (a weak model with less thinking produces rework),
**smart = down only** (the "expensive model on a task that didn't need it" case; "nearly
free `high`" is a *static pin*, not a per-turn decision). Static pins can hold any
supported level. Contract: SPEC §9.5. Plan/gates: ROADMAP. Tracking: [#43](https://github.com/green-dalii/pi-shift-router/issues/43).

**Evidence — Artificial Analysis, Intelligence Index vs. cost per task** (19 points, the
same model at every effort level; chart: `https://artificialanalysis.ai/?models=glm-5-3%2Cglm-5-3-low%2Cclaude-opus-5-5%2Cclaude-opus-5-5-xhigh%2Cclaude-opus-5-5-high%2Cclaude-opus-5-5-medium%2Cgpt-6-sol%2Cgpt-6-sol-xhigh%2Cgpt-6-sol-high%2Cgpt-6-sol-medium%2Cgpt-6-sol-low%2Cgpt-6-luna%2Cgpt-6-luna-xhigh%2Cgpt-6-luna-high%2Cgpt-6-luna-medium%2Cgpt-6-luna-low%2Cgemini-3-8-flash-low%2Cgemini-3-8-flash-medium%2Cgemini-3-8-flash-high`
— the original filtered URL, including the long `releases=` list, is in the tracking
issue). Readings are approximate; the *shape* is what drives the design:

| Model / level | cost/task | index |
|---|---|---|
| Luna low → medium | $0.006 → $0.01 | 21 → **32.5** (a cliff) |
| Luna medium → high | $0.01 → $0.017 | 32.5 → 34.5 |
| Luna high → xhigh → max | $0.017 → $0.045 | 34.5 → 35.5 → 38.5 |
| Sol low → medium → high | $0.25 → $0.30 | 34 → 40 → 42.5 |
| Sol high → xhigh | $0.30 → $0.60 | 42.5 → **47.5** (2× the price) |
| Sol xhigh → max | $0.60 → $0.80 | 47.5 → **47.5 (nothing)** |
| Opus 5.5 medium → high → xhigh → max | $0.30 → $5 | 50 → 52.5 → 54 → 57 (+455% price for +3) |
| GLM-5.3 **low** vs max | **$3.2** vs $1.5 | **36** vs 45.5 |
| Gemini 3.8 Flash medium → high | $0.35 → $1.3 | 40 → 42 |

1. **Value is concentrated in the middle.** `low → medium` is a cliff; `medium → high` is
   nearly free; `high → xhigh → max` is flat and expensive. Effort is a small adjustment,
   not a third dial.
2. **The top of the ladder contains dominated points.** Sol `max` scores what `xhigh`
   scores for 33% more; Opus `max` costs 455% more for +3. Every point in the chart's
   "most attractive quadrant" is a mid/high-effort strong model. Hence: never lets the
   dynamic path touch `xhigh`/`max`.
3. **Effort upward on the cheap tier is worth more than effort downward on the expensive
   tier.** Luna `max` (38.5 @ $0.045) reaches 96% of Sol `medium` (40 @ $0.30) at 15% of
   the price; Luna `high` (34.5 @ $0.017) beats Sol `low` (34 @ $0.25) outright. This is
   why **fast = up** is the primary direction.
4. **…but only when the gap is large.** Nothing under $0.30 reaches Opus `medium` (50), so
   for a Fast/Smart pair with a wide gap the **smart = down** direction is real. The two
   directions therefore have independent value and are independently toggled.
5. **Lowering effort can raise total cost.** GLM-5.3's `low` is *dearer and worse* than its
   `max`. In an agentic setting, less thinking means more turns and more rework, and the
   chart measures cost per **task**, not per request. This is the empirical form of the
   "effort backfires" risk: it is why fast never steps down, why `low` must be guarded by
   measured cost, and why the sharpness contract is report-only rather than self-correcting.

**Code facts verified against pi 0.87.1** (they shape the contract, so they belong here
rather than in a chat log): the extension API exposes `getThinkingLevel()` and
`setThinkingLevel(level)` alongside `setModel()` (`core/extensions/types.d.ts`);
`setThinkingLevel` writes session state and appends a session entry only when the level
actually changes (`agent-session.js:1751`); `setModel()` re-derives the level from pi's
own defaults (`_getThinkingLevelForModelSwitch`, `agent-session.js:1800`), so every switch
must be followed by a re-apply; a level change is sticky until changed again, so `default`
turns must actively restore the baseline; `xhigh`/`max` are only supported when the model
catalog declares them (`pi-ai/dist/models.js:554`); and `ThinkingLevel` is **not**
re-exported from pi's package root, so the 7-value union is redeclared locally (importing
`pi-ai` at runtime is not allowed — `RUNTIME_HOST_ALLOWLIST` in `scripts/pack-check.mjs`).

**Rejected.**

- *Absolute level names in the dynamic path* (e.g. "high" meaning pi's `high`). We cannot
  know a model's configured default, so an absolute target can silently be a downgrade.
  Relative one-notch stepping is capability-correct everywhere and respects a user's own
  `/thinking` setting at the ladder ends.
- *`low` on the fast tier.* Rework costs more than the thinking it saves (finding 5).
- *Dynamic `xhigh`/`max`.* Dominated points (finding 2).
- *An effort × tier matrix.* Combinatorial, untestable, and it erodes the tier decision's
  auditability — the property the two-bucket design exists to provide.
- *Heuristic triggers* (message length, token counts, tool counts). Same prohibition as the
  Judge's "no keyword rules": the trigger must come from the verdict the Judge returns.
- *Effort inside θ/EV or the cache-aware gate.* Different cost structure (output-side, not
  input-side); folding it in would silently move the savings figure.
- *Making effort default-on.* It is a quality preference and it must not change behaviour
  for existing users — off by default keeps upgrades byte-identical.

**Supersedes** the v0.8.x withdrawal of per-tier thinking level (ROADMAP). That decision
was right about the shape proposed then — a *static* per-tier rule, plus adaptive thinking
in general, save less than they complicate because the smart tier is already gated on real
complexity. Neither objection covers a step that fires only inside the Judge's marginal
band, in the tier the band points at, capped at one notch.

## 2026-09-23 — Version bumps must go through `npm version` (lockfile drift)

**Decision.** Release bumps run `npm version <patch|minor|major>
--no-git-tag-version` — which updates `package.json` *and* `package-lock.json` —
rather than editing `package.json` by hand.

**Why.** Preparing v1.7.0 revealed `package-lock.json` pinned at **1.3.1**: four
releases (1.4.x, 1.5.x, 1.6.0) bumped `package.json` without it, so the two
disagreed for months. Nothing broke — the lockfile's own `version` field does not
affect resolution — which is exactly why it went unnoticed, but it makes the
lockfile useless as a "what shipped" record and would surface as a confusing
one-off jump in a future release diff.

**Rejected.** Treating the lockfile version as cosmetic (it is free to keep
correct), and fixing it silently per release instead of at the source.

**Check before every release.** `git diff package-lock.json` must show only the
version fields; a jump of more than one version means a previous bump was
incomplete.

---

## 2026-09-23 — Jev demoted to a Beta, opt-in third mode

**Decision.** The Judge menu order is now: `🦾 Reuse the Fast tier chain (default)`
→ `🔬 Dedicated Judge LLM chain` → `🧮 Jev — decision model (Beta)`, and every doc
presents Jev as an opt-in beta rather than a recommended or first-class judge.
`JUDGE_MODE_ORDER` follows the same order; the config default is unchanged
(`fast-chain`).

**Why (the user called it, and the evidence agrees).** Two earlier iterations had
Jev as the first, "recommended" row. That was wrong on the facts:

1. **It is public beta.** Provider capacity is still ramping (our own 1.4–6.6 s
   measurements are that, not the model), the API surface can move, and there is
   no broad user validation yet.
2. **The independent evidence is negative, not neutral.** A September 2026
   evaluation found decision models trailing the per-task best LLM on **14 of 15**
   annotation tasks, and Jev's `confidence` is a rescaling of the top probability
   rather than a calibration claim. Leading a menu with it would push an unproven
   model class onto users who never asked — and our own thresholds (θ) are still
   tuned for LLM confidence, which makes "use a decision model" a *deliberate*
   choice, not a sensible default.
3. **Ordering is a claim.** Putting an option first says "start here". The honest
   default for an existing user is the behaviour they already had.

So: legacy behaviour first, LLM variants second, the beta third, labelled.
Availability is unaffected — the ladder still prefers whatever the user configured
and falls back either way.

**Process note (same message from the user).** The user also objected to
amending every iteration into a single commit. Correct: one mega-commit per branch
destroys bisectability and forces reviewers to read a whole-feature diff. The rule
now lives in AGENTS.md: **one commit per concern** — feature code, behaviour
change, migration fix, docs, process — amended only for fixups *inside* the same
concern. This branch was rebuilt into that shape.

---

## 2026-09-23 — The ladder works at call time, and it covers the LLM judge too

**Correction to the entry below.** The first version of the ladder only handled
*resolvability* — and only for `decision`/`custom` **config rot**. The user caught
the real gap: an LLM judge that resolves but **fails on the call** (429, 5xx,
timeout, all endpoints cooling down) still just held the turn. A fallback that
only fires when a model is deleted is not a fallback.

**Fix.** `resolveJudgeEndpoints()` now returns the ladder as **one ordered list**
— `[configured chain…, LLM judge…]`, deduped — so a single `classify()` walk
covers both failure kinds in the same turn. `classify()` already walks a list with
cooldown skipping and failover-signature cooling, so a 429 on rung 1 falls through
to rung 2 immediately. `fast-chain` mode returns just the Fast chain (no
duplicate rung), and a model present in both rungs is not judged twice.

**Rung 3 now also fires on call-time exhaustion.** When every rung fails,
`stopRouting()` applies the same policy as "nothing configured": no model switch,
orchestration cleared, the user's `sessionModel` restored, one notice per session.
So the worst case is genuinely "as if the plugin were uninstalled" — for both
config rot and a bad day at the provider. The previous "transient failures hold"
rule was right for a *routable* judge but wrong once every rung is gone: holding
keeps a tier a previous turn chose, which is exactly the unexplained state the
user objected to. The rule survives in the only place it belongs — a single
transient failure on rung 1 still falls to rung 2 and produces a verdict.

**Manual override wins.** `planNoJudge()` does not restore the session model when
`/route-force` is active: an explicit instruction outranks a degraded judge.
Caught while writing the tests, not in production.

**Backward compatibility (asked explicitly: old users have no mode key).**

- Pre-v1.7.0 configs have **no `routing.judge` at all** → merged default
  `fast-chain` → byte-identical behaviour, **zero migration**.
- **`judge.models` present without `mode`** → migrated to `custom`. This was a
  real silent-data-loss bug: `deepMerge` puts the default `fast-chain` in place,
  so the user's list would have been ignored with no warning. The resolver now
  logs the inference.
- **Unknown/typo'd `mode`** → `fast-chain` (the safe legacy reading) + a log line,
  never a bricked router.
- The wizard uses the same `normalizeJudgeMode()`, so the menu cannot display a
  mode the resolver would not honour — display and behaviour cannot disagree.

**Contract changes this iteration** (listed, not silently weakened, per AGENTS):
`resolveJudgeEndpoints` for `custom`/`decision` used to return *only* the
dedicated chain; three assertions in `tests/config.test.ts` moved to the ladder
contract, and new tests cover the appended rung, dedupe, and all four
`normalizeJudgeMode` branches.

---

## 2026-09-23 — The save-time probe is gone; availability is a runtime ladder

**Decision (supersedes the entry below, kept for the reasoning trail).** The
save-time probe is **deleted**, replaced by a three-rung availability ladder. The
user asked the right question: *why make an HTTP request at all?*

**Why the probe did not earn its round trip.**

1. It proves the endpoint answers **that second**. Jev is in beta — capacity,
   revoked keys and regional flakiness all move — so the proof expires
   immediately. It was never a durable guarantee, only a snapshot.
2. Its cost was structural: a blocking network call on the config UI *after* the
   chain editor had closed, which the user experienced as the Config screen
   vanishing for ~1 s. Patching that with a working indicator treated the symptom.
3. Its only unique value — immediate feedback on a misconfiguration — is delivered
   **better** by (a) offline validation (endpoint resolves: auth, baseUrl, api
   marker) and (b) rungs 2–3 at runtime, where the answer is actually true.
   Feedback moves from save-time to first-turn instead of disappearing.

**The ladder (SPEC §8.6).**

| Rung | Condition | Behaviour |
|---|---|---|
| 1 | configured chain resolves | judge with it |
| 2 | resolves to nothing (retired model, removed key, gone provider) | LLM judge (the user's Fast chain), degradation logged |
| 3 | no judge endpoint at all | **routing off**: no switch, orchestration cleared, the user's `sessionModel` restored, one notice per session |

Rung 3 is the user's requirement stated exactly: the worst case must be **as if
the plugin were not installed**, and it must say so. That required a new state
field — `RouterState.sessionModel`, captured once in `session_start` before any
switch — because "hold" was not the same thing: holding keeps whatever tier a
previous turn chose, so a broken config could leave the user stranded on the
smart model with no explanation. The policy lives in a pure `planNoJudge()` so it
is testable without the pi lifecycle.

**Deleted with it** (dead code once the probe went): `probeDecisionEndpoint`,
`DECISION_PROBE_TIMEOUT_MS`, `judgeChainUnchanged` (it existed only to skip
redundant probes — with no probe there is nothing to skip), `withWorkingIndicator`
(only ever wrapped the probe), and their 12 tests. Net: fewer moving parts, one
fewer network path, zero UI-blocking I/O in the wizard.

**Kept.** Per-call failures (timeout, 5xx, malformed answer) still **hold** rather
than cascading to rung 3 on one bad turn — transient is not rot. And a verdict is
still never fabricated.

---

## 2026-09-23 — The "Config screen disappears for a second" bug was the probe

**Symptom (reported).** `/router config` → 🧭 Judge → Jev chain → press **D**: the
Config screen vanishes for ~1 s before the menu returns. Fast / Smart / `custom`
never do this.

**Cause.** Those paths only resolve a chain locally. The decision path runs
`probeDecisionEndpoint()` — a **real HTTPS round trip** to `api.typesafe.ai`,
1.4–6.6 s during Jev's beta — *after* the chain editor has already called
`done()`. The wizard is between renders with nothing to draw, so the wait shows
as a blank frame. Nothing was "stuck"; the UI simply had no progress to show
while a network call blocked the handler.

**Fix (two parts, both in the wizard, no protocol change).**

1. **Visible wait.** The probe now runs under pi's working indicator
   (`setWorkingMessage("🧭 probing Jev endpoint…")` + `setWorkingVisible(true)`,
   restored in `finally`, best-effort on non-TUI hosts). An explained wait beats
   a mystery freeze.
2. **Skip redundant probes.** `judgeChainUnchanged()` detects "the user is
   re-saving the chain that is already active" and returns immediately. Safe
   because an identical active config means that endpoint is already proven and
   in effect — a fresh probe would gate nothing new. Only a *changed* endpoint is
   re-probed, which is the only case where the proof can differ.

**Rejected.** (a) Probing without any indicator — indistinguishable from a hang.
(b) A session-wide "already probed" cache keyed on `provider/model` — extra hidden
mutable state that this codebase deliberately centralizes; the unchanged-chain
check covers the real repeat case (re-saving what is active) without it.
(c) Moving the probe before the editor closes — the user ends the edit by pressing
D; there is no earlier hook that still has a renderable surface.
(d) Dropping the probe to make saving instant — it is the requirement (Jev must be
proven usable before it is persisted); the fix is to explain the wait, not remove
the gate.

---

## 2026-09-23 — README + MODELS audit; tier names replace specific versioned IDs

**What I noticed in the post-rewrite README/MODELS:**

- The named link to the host agent (pi-coding-agent) was gone from the hero — the rewrite removed the old opening sentence entirely. Fixed: a one-line "it runs as a [pi-coding-agent] extension — no separate server, no per-call setup" between the fix paragraph and the example. Same for zh.
- The zh hero had a duplicate `text` example block left in by the previous turn (my own splicing artefact). One of the two and its preceding prereq were removed; only the canonical hero example remains.
- The illustrative model names in both READMEs and in `docs/CONFIG` ×2 were a stale 2026-07 snapshot — `deepseek-v4-flash` is the historical build; the current tier is **`DeepSeek V4.1 Flash`**; same for `glm-5.2` → `glm-5.3-flash`; `claude-opus-5` → bumped to **`claude-fable-5`** (the current strong tier in Anthropic's lineup). Updated to the same names the user actually has in `~/.pi/agent/pi-shift-router.json`.

**docs/MODELS ×2 rewritten around tier names, not versioned IDs.**

The old document was a snapshot of specific model IDs (`glm-5.2`, `kimi-k2.7-code`, `qwen3.7-max`, `gpt-5.6-luna`, …) that went stale on every provider release. New structure:

- A **tier-name glossary** at the top that maps "cheap / mid / strong" words to each provider's vocabulary: Anthropic Haiku / Sonnet / Opus / Fable, OpenAI Luna / Terra / Sol / Astra, Gemini Flash-Lite / Flash / Pro, Qwen Plus / Max, GLM Flash / mainline, DeepSeek Flash / Pro, Kimi Fast / K3, MiMo Flash / Pro / UltraSpeed, Grok Fast / mainline, Mistral Mini / Max. Once the user knows which word means what, any provider's catalog is readable.
- A mnemonic rule: *Lite / Flash / Haiku / Luna / Fast / Mini / Nano / Highspeed = cheap; Pro / Max / Opus / Sol / Astra / Fable = strong.* Same letters, same meaning, every family.
- Patterns reframed around tier names: Pattern 3 is now "Anthropic Haiku → Sonnet → Opus → Fable" rather than specific IDs. Pattern 4 uses "any DeepSeek V4 Flash" / "any Anthropic Opus class" — telling the reader *which tier to pick*, not *which build*.
- A **gateway warning** added to Pattern 2: pointing two failover positions at the same gateway is fragile — a gateway outage is a *single* failure affecting every model behind it. Cross-gateway is the resilience pattern.
- Local-quant guidance now tells the user the *strategy* (Flash class at q4, 27 B post-trained beats raw 70 B for fast) rather than specific GGUF repos. Verification path is "open `/model`".

**Process rule that would have caught the duplicate.** The previous turn's README rewrite used multiple python scripts to splice sections in; the second splice left a duplicate of the hero example block in the zh file because I matched-and-replaced forward and didn't diff-check before committing. New habit: every doc rewrite ends with `diff <(git show HEAD:file) file` and a grep for known canonical strings to count duplicates.

**Kept (deliberately not changed).** SPEC §8.6 Jev contract (audited live, no
drift). MEMORY and ROADMAP version labels (they name the version a feature
*shipped* in, so they are historical, not drift — the release PR updates the
README `latest:` field, which is the one metadata line that must track npm).
CHANGELOG is written at release time only.

**Post-release cleanup (v1.7.0, same session).** The SPEC orthogonality pass then
found a stale claim with the same shape as the drift this log records: SPEC §4.6
still asserted the *pre-ladder* judge-failure behaviour ("the user is not
interrupted") after the ladder shipped, and §9 was titled "Future Direction"
while holding three delivered features. Both fixed before the release commit —
docs reviewed at release time, not only written.

---

## 2026-09-18 — Judge model id: alias by default, version moves made visible

**Decision.** The Judge is configured with `jev-latest`, not a pinned build. Every
response's resolved id is recorded on `JudgeResult.resolvedModel`, and the verbose
log emits a "version moved" line when it differs from what we asked for.

**Why (first principles — both options fail, so pick the failure you can see).**

| | Pin `jev-1.13.0` | Alias `jev-latest` |
|---|---|---|
| Failure mode | vendor retires the build → Judge stops working, router holds **forever** until a human edits config | version moves → probability distribution shifts behind θ |
| Detectable? | loudly, but only when it happens | only if we look |

A pin trades a *silent* risk for a *guaranteed eventual hard failure* on someone
else's schedule. The alias is the opposite: it never retires, and its only hazard is
a distribution shift — which we can neutralize by observing the resolved id Jev
already returns. So: alias for availability, observability for the shift. A pin is
now documented as the opt-in for byte-identical reproducibility, with its failure
mode stated.

**Rejected.** (a) Pin-by-default "for repeatability" — repeatability of a build that
can vanish is not reliability. (b) Alias with no version log — that is the silent
shift, unobserved. (c) Chasing the version string from `/v1/models` at startup —
extra call, still needs the per-response id to detect a mid-session move.

**Latency attribution corrected.** The 1.4–6.6 s measured here is **provider-side
capacity during Jev's public beta**, not a property of decision models and not
payload/integration overhead (a 5× smaller payload was no faster; same rubric on a
fast LLM judge ~1.4 s). My earlier note blamed "the benchmark not reproducing" —
wrong attribution, fixed in README/SPEC/CONFIG. Re-measure rather than design around
it.

---

## 2026-09-18 — Jev wired correctly, but its operational defaults were not

**Verified against the live API, not the docs.** With a real key (8 calls against
`api.typesafe.ai`, 458–2265 input tokens), the protocol wiring matches the official
spec exactly: `POST /v1/systemone`, Bearer auth, `model`+`state`+`questions`, a
two-option `choice`, a `noul` with true/false criteria, one round trip, `answers`
envelope, `usage.output_tokens` unbilled. Nothing to change in the transport.

**What the measurement did change — three operational defaults.**

1. **Latency is seconds, not milliseconds.** 1.4–6.6 s (median ~5 s), and the time
   is *service-side*: a lean payload (458 vs 2265 input tokens) was no faster. The
   published ~127 ms figure (tiny inputs) does not describe this workload, and the
   v1.7.0 README first claimed it — corrected.
2. **The 5000 ms judge timeout would have made the feature look broken.** Most
   decision calls would abort and the router would hold *every* turn. The wizard now
   raises `routing.judgeTimeout` to 15000 ms when decision mode is selected **and
   reports the change** (never a silent config write). The probe gets 20000 ms — a
   false "endpoint is dead" is worse than a slow check.
3. **Decision models must not be selectable as tier models.** pi has no streaming
   implementation for `api: "typesafe-decisions"` — it resolves the api lazily at
   stream time and would throw on every turn. `chatCapableModels()` filters them out
   of the Fast/Smart pickers.

**Also confirmed live:** the `confidence` field is indeed a rescaling of the top
probability (0.99 → 0.97), so the parser's choice to threshold
`probabilities[tier]` over `confidence` is the correct one.

**Cost, measured:** ~$0.000095/call (2265 in @ $0.042/M, output unbilled) vs
~$0.00033 for the fast-tier LLM judge on the same rubric — ~3.4x cheaper, ~3.5x
slower. Decision mode is a determinism/cost play, **not** a latency play.

**Rejected.** Trusting the vendor benchmark for sizing; silently raising the user's
timeout; letting a decision model into a tier picker; trimming the rubric to chase
latency (measured — no effect, and it would silently change judging semantics).

**Open question.** Why ~5 s? (Region, queueing, or internal deliberation — Jev
reports 50 output tokens.) Worth re-measuring before advertising the mode; if
latency stays in seconds, the decision mode suits batch/background routing far
better than interactive turns. Tracked in ROADMAP.

---

## 2026-09-18 — Two indicator idioms in the wizard: ●/○ for exclusive, ☑/☐ for toggles

**Decision.** Wizard rows use one glyph pair per semantics and never mix them:
`●`/`○` on exclusive pickers (provider, Judge mode), `☑`/`☐` on independent
toggles (UX settings, cache-aware). Toggle titles name their glyphs —
`(☑ on · ☐ off)`. Both come from `toggleRow()` / `judgeModeOptions()`.

**Why.** A request to "unify everything on ●/○" was considered and **rejected**:
the toggle menus allow all-on / all-off / any combination, so a filled circle
would read as *radio* ("the one selected"), and with five rows on, the "which is
current?" signal disappears. pi's UI documents `●` as a status *indicator*, and
its official extension example (plan-mode) marks item state with `☑`/`☐` — both
idioms are already the host's.

**The real bug that prompted this.** The Judge menu marked the current mode with
a `✔` **suffix** while the provider picker used a `●` **prefix** — same meaning,
two glyphs. That is the inconsistency; it is gone (tests now forbid `✔` in
wizard copy and assert the two idioms stay separate, SPEC §7.6).

**Gotcha.** Glyph *advance width* is not uniform across fonts: `♻️` sat flush
against its label where `🦾` renders with a clean gap (same class as the v1.5.1
`🛡`→`🔒` fix). Prefer glyphs already proven in this project's menus, and keep a
test asserting the `^<glyph> <text>` shape.

---

## 2026-09-18 — Judge modes: keep the LLM judge, add a decision-model protocol

**Decision.** `/router config` gains a `routing.judge.mode` setting with three
values — `fast-chain` (default, current behaviour: reuse the Fast tier chain),
`custom` (dedicated Judge LLM chain, same chain-editor UX as Fast/Smart), and
`decision` (Jev-style decision models: typed answers + calibrated
probabilities, no text generation). The existing LLM judge path is **not**
removed or replaced.

**Why.** The Judge is a high-frequency, latency- and cost-sensitive,
threshold-consumed classifier. A decision model (TypeSafe AI's Jev, released
2026-09-15: `POST /v1/systemone`, Choice/Score/Noul primitives, $0.042 per 1M
input tokens, output free, ~127 ms vs ~688 ms for a Haiku-class LLM) fits that
shape far better than a generative LLM. But independent (non-vendor) tests show
two blockers for a full swap: Jev is strong on **English, short, crisp-label**
input and weak in the **middle of the probability range** — exactly where our
θ≈0.22–0.5 threshold lives. So: additive protocol support, LLM judge retained as
the fallback and as the source of `reason`.

**Design invariants.**
- One `routing.judge.models` list; `mode` selects the source. `fast-chain` ⇒
  `tiers.fast.models` (byte-identical to today when `judge` is absent).
- `decision` mode endpoints are validated before saving: candidates come from
  pi's registry (v1.6.0 alignment), and a cheap live probe (one Noul question)
  must succeed — the user configures Jev **inside** the wizard, never by
  hand-editing plugin config.
- Protocol is inferred per endpoint from the registry `api` field
  (`typesafe-decisions`), so future System One-style models need a provider/api
  kind, not a new mode.
- `decision`-mode failures degrade to **hold** (or the next chain entry) — never
  to a fabricated verdict, and never to the cheapest-LLM fallback that
  `fast-chain` mode uses.

**Rejected.**
- Replacing the LLM judge entirely (English-only strength + midpoint
  calibration + no `reason` + cannot abstain).
- A Jev-only special case path instead of a protocol — breaks orthogonality and
  would need re-doing for the next decision model.
- Asking Jev for a `reason`: it does not generate prose.

**Status: implemented (v1.7.0, unreleased).** `routing.judge.mode` (`fast-chain` /
`custom` / `decision`), `resolveJudgeEndpoints()` (dedicated/decision chains hold
instead of falling back), the `typesafe-decisions` adapter in `judge.ts`
(`buildDecisionRequestBody` / `parseDecisionResponse` / `probeDecisionEndpoint`),
and the wizard `🧭 Judge` row with the probe gate. +23 tests (15 protocol + 5
resolver + 3 menu/summary). Verify against a live Jev key before advertising it.

**Open questions / must verify at implementation time.**
- Exact response envelope (`answers` map vs top-level) → parse tolerantly, cover
  both with fixtures; confirm once against a live key.
- Whether OpenRouter/Vercel/Cloudflare gateways proxy the decisions schema
  verbatim (Cloudflare's docs show `env.AI.run('typesafe/jev', {state,
  questions})`, so yes for Cloudflare; treat gateways as configurable
  `baseUrl`).
- Jev's Chinese-input quality on *our* prompts — measure before claiming parity;
  the fallback chain covers it either way.

**Priority note.** This work is orthogonal to — and now ahead of — the pending
routing-asymmetry revision and the config-layer switch. It interacts with the
former (calibrated probabilities change the confidence distribution, so θ must
be re-derived from measured data later; do **not** re-tune θ as part of this
feature).

---

## 2026-09-18 — Model catalog = pi's registry, not a local re-derivation

**Decision.** Every catalog consumer (wizard picker, Judge endpoint resolution,
cost telemetry pricing) reads `ctx.modelRegistry` first — `getAvailable()` for
the list, `find()`/`hasConfiguredAuth()`/`getProviderAuthStatus()` for validity,
`getApiKeyForProvider()` for credentials — with `models-store.json` + `auth.json`
kept only as a fallback for headless/test contexts (`src/model-source.ts`,
SPEC §5.4).

**Why.** The wizard showed a different, smaller list than `/model`: store 5
providers / 413 models vs pi's catalog 39 / 1354; 13 openrouter + 2 deepseek
models existed only in pi's copy; `opencode-go` (23 models) was dropped because
the local auth heuristic could not see credentials pi resolves from environment
variables, `models.json` commands, or runtime login.

**Rejected.** Patching the local heuristic (would drift again on the next pi
release), importing pi-ai types (transitive host dependency — structural typing
in `types.ts` instead).

---

## 2026-09-17 — Verbose logs go to a file, never stdout

**Decision.** `ux.routerLogVerbose` appends to
`~/.pi/agent/logs/shift-router.log` (`src/log.ts`, `PI_SHIFT_ROUTER_LOG`
override). The startup banner stays on stdout — it is the documented
stale-build check.

**Why.** pi owns the terminal; a stray `console.log` between frames desyncs the
renderer's line accounting and the assistant's own message renders split
mid-sentence with log lines spliced in. pi ships no logging channel.

---

## 2026-09-17 — Process rules that cost us real cycles

- **Release branches must be cut from up-to-date `main`.** A release branch
  created while a feature branch was checked out silently carried the whole
  feature (PR #38), leaving the feature PR (#37) to be closed as superseded.
  Baseline check + release-diff self-check are now in AGENTS.md.
- **Amend follow-ups into the branch's logical commit** — never stack
  `fix:`/`docs:` commits; a branch needing a second commit is usually two PRs.
- **npm publish is staged now**: after `npm publish` the version appears in the
  registry 1–2 minutes later. `npm view` lags; the authoritative check is
  `curl -s https://registry.npmjs.org/pi-shift-router` (or `npm stage list` with
  npm ≥ 11.19). A `409 Cannot publish over previously staged version` on retry
  means the first publish **succeeded** — verify the registry before bumping.
- **README head metadata is a release field** (`latest:`, `last-updated:`,
  `features:`, `search-intents:`); it drifted silently from v1.4.0 to v1.5.0.
