# MEMORY — pi-shift-router

Durable decision log: what was decided, why, what was rejected, and what must not
be forgotten. **Specs describe the present; MEMORY records the reasoning behind
it.** Update it whenever a decision is made that a future contributor (or the
agent, after context loss) would otherwise re-litigate.

Format: newest first. Keep entries short — decision, rationale, rejected
alternatives, gotchas. Detail belongs in SPEC.md / ROADMAP.md; link them.

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
