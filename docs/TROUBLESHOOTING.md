# Troubleshooting

## Judge unparseable warning

- **The reasoning model ran out of tokens** — DeepSeek Reasoner emits `reasoning_content` first, then JSON in `content`. The router sets `max_tokens: 4000`; very long prompts may overflow. Run `/router verbose` to inspect the raw response.
- **The provider doesn't support JSON mode** — some custom OpenAI-compatible endpoints ignore `response_format`.
- **Invalid API key** — check pi-agent's `auth.json`.

## "Judge fetch failed for … : TypeError: Cannot read 'slice' of undefined"

Fixed in v0.8.0 (commit `de6073a`+). Root cause: `JSON.stringify(undefined)` returns `undefined`, not the string `"undefined"`. When the Judge endpoint returned 200 with an error-shaped body (no `choices[]`), the verbose log crashed on `content.slice(...)`. Now wrapped in a `jsonStr()` helper that returns `"undefined"` for undefined input.

If you still see this on an older install, reinstall: `pi remove pi-shift-router && pi install <path-to-this-repo>` (e.g. `pi install .` from the repo root).

## "No models match" in the wizard

Models come from pi-agent's `models-store.json`. Restart pi-agent after adding a new provider so it re-discovers the list.

## Status bar shows `⛔`

The router is disabled — run `/router on`. If `enabled: true` in the config but the badge still shows `⛔`, check the `Config:` line in `/router status` to confirm which config path is being read.

## "Model not found" warning

The model ID doesn't exist in the provider. Update the ID or re-pick via `/router config` (the wizard only lists real models).

## Model returns 402 / "Insufficient Balance" but router never switches

Symptom: every turn ends with the same dead model and an error like
`Error: 402: {"message":"Insufficient Balance", ...}` — the router
keeps re-trying the depleted account instead of falling back to the
next model in the chain. **Fixed in v1.4.1**: the detection layer now
recognizes HTTP 402 and the `insufficient balance` / `余额不足` keywords
(prior to v1.4.1 the status list was 429 + 5xx only, so billing-exhausted
errors silently slipped past and pinned the dead model).

If you see this on an older install, upgrade to **pi-shift-router ≥ 1.4.1**
(`npm install -g pi-shift-router@latest` or `pi install npm:pi-shift-router`).
The failing model enters a 16m cooldown (same 4xx bucket as 429) and the
router picks the next healthy same-tier model.

## Router keeps downgrading to Fast

Either the Judge is misclassifying (inspect with `/router verbose`) or the threshold is too aggressive. Raise it:

```json
"routing": { "window": { "size": 5, "threshold": 0.8, "minConfidence": 0.5 } }
```

---

## Orchestration never engages (`🪄` never shows)

Orchestration (SPEC §9.3) requires ALL of these:

1. **`/router status` shows `Orchestration: 🪄 auto`** — if it shows `✗ (off)`, run `/router orchestrate auto` (or edit `orchestration.mode` in the config file).
2. **pi-subagents installed** — the `subagent` tool must exist. Check `~/.pi/agent/settings.json` for `npm:pi-subagents`, or `pi list`. Without it, complex tasks run directly on the Smart tier (no delegation) — this is the intended degrade, not a bug.
3. **The turn got a `smart` verdict** — orchestration only fires on complex tasks. A `fast` verdict means plain routing by design. Try a genuinely complex request (architecture, multi-step planning, review-as-deliverable) and watch `/router verbose` for `judge: smart`.
4. **Smart model resolvable** — the Smart tier must have at least one model that pi can find (not in cooldown, registered in the model store). If `requireSmartModel` is true (default) and the model is unresolvable, orchestration is skipped.

Verify step by step with `/router verbose`:

```
[ShiftRouter] judge: smart (llm) …
[ShiftRouter] 🪄 orchestrating: judge=smart, injecting orchestrator prompt (N chars)
[ShiftRouter] 🪄 orchestration turn ended — exited orchestrator state
```

If you see `judge: smart` but no `🪄 orchestrating` line, one of the gates above failed — check 1–4. If you see `🧭 judging…` but the judge returns `fast`, the model judged the task routine; that's the judge doing its job, not a routing bug.

## Orchestrated turn doesn't actually delegate

The orchestrator instruction tells the Smart agent to use the `subagent` tool, but delegation is the LLM's judgment call. If it implemented the task itself instead, either the task turned out simpler than the judge thought, or the prompt's delegation guidance wasn't persuasive for that model. Non-blocking: the work still gets done at Smart quality. To debug, inspect the orchestrator prompt (injected into the system prompt; visible in verbose mode) and the CTO summary at the end of the turn.
