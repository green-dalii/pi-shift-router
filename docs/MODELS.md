# Model Pairings

> This page teaches **how to choose**, not **how to fill** — your provider setup is yours. Data is snapshotted from [models.dev](https://models.dev/) on 2026-08-05; refresh with `curl -s https://models.dev/api.json | jq` to see the latest.

## Two rules of thumb

> **Fast tier**: if your provider exposes `deepseek-v4-flash` (2026-07), prefer it for `fast` — the 0731 refresh pushed quality close to Opus 5 / GLM-5.2 territory while keeping prices at the low end of the table.
>
> **Smart tier**: keep `smart` on a frontier cloud model. Local smart is impractical on hardware under ~80 GB of VRAM/unified memory, and even at 96 GB the cost/quality trade-off almost never beats a flat-fee token plan.

## Pattern 1 — Coding plans (one key, many models)

Candidate model IDs you can mix across the chain — not a single canonical pairing. Two groups of providers fit the “one key, many models” pattern:

1. **Subscription coding plans** — a flat monthly fee buys access to a curated model set, exposed through an OpenAI/Anthropic-compatible API key you can plug into any tool (Claude Code, Codex, OpenCode, Cline, Aider, or this router).
2. **Pay-per-token gateways** — aggregate hundreds of models under one account; useful when you want to mix providers without juggling keys.

`smart` candidates below are **frontier-class only**. Lightweight subscription plans (OpenCode Go) and gateways (OpenCode Zen) are included when they actually expose a model strong enough for `smart` — both now do.

| Subscription coding plan | `fast` candidates 🦾 | `smart` candidates 🧠 | API access |
|---|---|---|---|
| **Kimi Code** (Moonshot) | `moonshotai/Kimi-K2.7-Code` | `kimi-k3` (2.8 T, 1 M ctx) | One key for Claude Code / Codex / OpenCode / Cline / Aider; $19–199/mo |
| **GLM Coding Plan** (Z.AI) | `glm-5`, `glm-5-turbo` | `zai-org/GLM-5.2` | Z.AI devpack for Claude Code / Cline / OpenCode; ~$18/mo |
| **Qwen Code** (Alibaba) | `qwen3.7-plus`, `qwen3.6-flash` | `qwen3.8-max`, `qwen3.7-max` | ~$50/mo; ~90k requests/mo quota |
| **Windsurf** (Cognition) | available open + frontier models | frontier models on Pro/Max | $20–200/mo, quota-based |
| **OpenCode Go** | `DeepSeek V4 Flash`, `Qwen3.6 Plus`, `MiMo-V2.5` | `Grok 4.5`, `GPT 5.6 Luna`, `Kimi K3`, `GLM-5.2`, `Qwen3.8 Max` | $5 first month, then $10/mo flat; OpenAI-compatible API key |
| **GitHub Copilot** | Copilot's available models (depends on your plan) | Copilot's available frontier models | Copilot API (`api.githubcopilot.com`); read the ToS before wiring it into a router |

| Pay-per-token gateway | `fast` candidates 🦾 | `smart` candidates 🧠 | API access |
|---|---|---|---|
| **OpenCode Zen** | `DeepSeek V4 Flash`, `Qwen3.7 Plus`, `GPT 5.6 Luna` | `Claude Opus 5`, `GPT 5.6 Sol`, `Kimi K3`, `Gemini 3.1 Pro`, `Grok 4.5` | `https://opencode.ai/zen/v1/messages` (Anthropic-style) / `/v1/responses` (OpenAI-style) |
| **Alibaba Token Plan** (intl + CN) | `qwen3.7-plus`, `qwen3.6-flash`, `deepseek-v4-flash` | `qwen3.8-max`, `qwen3.7-max`, `kimi-k3` | OpenAI-compatible |
| **Vercel AI Gateway** | any of the providers below through one gateway | any of the providers below | OpenAI-compatible |
| **OpenRouter** | 200+ models; `auto` is **not** a valid Judge target (opaque) | 200+ models | OpenAI-compatible |
| **Nebius Token Factory** | `deepseek-ai/DeepSeek-V4-Flash`, `moonshotai/Kimi-K2.7-Code` | `Kimi-K3`, `zai-org/GLM-5.2`, `Qwen/Qwen3.7-Max` | OpenAI-compatible |
| **NovitaAI** | `deepseek-ai/DeepSeek-V4-Flash`, `Qwen/Qwen3.6-27B` | `moonshotai/Kimi-K3`, `Qwen/Qwen3.7-Max` | OpenAI-compatible |

> **Pricing & availability move fast.** Subscriptions change price and model lineups frequently (mixed credit/quota structures, weekly-refreshed caps, per-model overages). Confirm the current plan + endpoint on the provider's official page before wiring it into the router. For a router, the key requirement is an OpenAI-compatible endpoint with a stable `baseUrl` + `apiKey` — that's what makes a plan “router-friendly”.

## Pattern 2 — Local models by VRAM / unified memory

All picks below were verified against HuggingFace's `safetensors` total weight size on 2026-08. Older generations (2025 and earlier), end-device outputs (<7 B), and pre-Qwen3.5 / pre-DeepSeek-V3 models were excluded as too dated.

> fp16 is a benchmark artifact, not a runtime format. Production local deployments use **q4-k-m / NVFP4 / MXFP4 / AWQ-int4 / 1–2 bit ternary**. Nothing in `fast` below runs at fp16.
>
> The `AxxB` suffix on a MoE model name means **active parameters per token** — it affects compute speed, not disk size. A GGUF / q4 file stores **every** expert weight, so its size scales with **total** parameters. `DeepSeek-V4-Flash` is 284 B total / ~13 B active, so its UD-Q4_K_XL GGUF is ~155 GB (needs 192 GB+ of unified memory); a q4 of it cannot be "~42 GB", however many parameters the name activates.

| VRAM / unified memory | Local `fast` candidates | Quant | Local `smart` candidates |
|---|---|---|---|
| **≤ 32 GB** (RTX 4070 12 GB, RTX 4090 24 GB, M3 Pro 18 GB, M4 Pro 24 GB) | `LiquidAI/LFM2.5-8B-A1B` (8.5 B total, 2026-05), `ibm-granite/granite-4.1-8b` (8.8 B, 2026-04), `Qwen/Qwen3.6-27B` (27.8 B, q4 ≈ 14 GB, current HF top), `google/gemma-4-26b-a4b-it` (26.5 B, q4 ≈ 13 GB), `Qwen/Qwen3.6-35B-A3B` (36 B total / 3 B active, q4 ≈ 18 GB), `poolside/Laguna-XS-2.1` (33.4 B total / 3 B active, q4 ≈ 17 GB, agentic coding, 2026-06), `prism-ml/Ternary-Bonsai-27B-mlx-2bit` (27 B, 1.58-bit ternary ≈ 7 GB, laptop/phone class) | q4-k-m / NVFP4 | cloud frontier model |
| **32–128 GB** (M2 Ultra 64 GB, A100 80 GB, RTX 6000 Ada 48 GB, RTX 4090 ×2) | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF` (27 B, MTP + NEO-MAX post-training, 2.4 M HF downloads, 2026-07 — the best-post-trained pick in this class), `google/gemma-4-31B-it` (31.3 B, q4 ≈ 16 GB), `poolside/Laguna-S-2.1` (117.6 B, q4 ≈ 59 GB — needs 64 GB+) | q4-k-m / NVFP4 / q4 | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP` (base weights) or a cloud frontier model |
| **≥ 128 GB** (M3 Ultra 192 GB, M2 Ultra 192 GB, NVIDIA DGX Spark 128 GB GB10) | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF` (same pick — post-training quality beats raw size for `fast`) | q4-k-m / NVFP4 / q4 | `unsloth/DeepSeek-V4-Flash-GGUF` (284 B total / ~13 B active, UD-Q4_K_XL ≈ 155 GB — needs 192 GB+ unified memory; on 128 GB-class machines use a 1–2 bit ternary if available) |

Notes:

- **Quantized variants ship as separate HF repos under each org** (NVFP4 / AWQ-int4 / GGUF / 1–2 bit ternary) — ollama / vLLM / MLX pick them up automatically. Check the org page for the exact variant repo; don't assume a `-NVFP4` or `-GGUF` suffix exists until you see it.
- **Any runtime exposing an OpenAI-compatible API works** — the plugin binds to none specifically. Common choices: **ollama** (`ollama run qwen3.6:27b` → server on `:11434`), **LM Studio** (MLX + GGUF), **vLLM**, **llama.cpp** / **llama-server**, **exo**, **llamafile**.
- **The Judge also needs a JSON-mode endpoint.** Qwen 3.5+ and Gemma 4 expose `tool_call=true`, so they satisfy the constraint — but a local Judge adds ~0.5–2 s per turn. Recommended: local `fast` + local-or-cloud `smart` + Judge on whichever `smart` you trust most.

## Pattern 3 — Same-provider tier ladder (simplest)

One provider, one bill, one rate-limit pool. Use this if you already have a paid account and don't want to juggle keys.

| Provider | `fast` 🦾 | `smart` 🧠 | Note |
|---|---|---|---|
| **Anthropic** | `claude-sonnet-5` | `claude-opus-5` or `claude-fable-5` | Sonnet 5 is the current `fast` tier. |
| **OpenAI** | `gpt-5.6-luna` | `gpt-5.6-sol` | GPT-5.6 has `luna` < `terra` < `sol` internal tiering. |
| **Google** | `gemini-3.5-flash-lite` | `gemini-3.6-flash` | Gemini 3.x, 1 M context on both tiers. |
| **Qwen (Alibaba)** | `qwen3.7-plus` | `qwen3.8-max` | Native `plus` / `max` split. |
| **DeepSeek** | `deepseek-v4-flash` | `deepseek-v4-pro` | `flash` ≈ mini pricing tier, `pro` ≈ flagship. |
| **Z.AI (GLM)** | `glm-5` or `glm-5-turbo` | `glm-5.2` | GLM-5 series. |
| **xAI (Grok)** | `grok-4.5-fast` | `grok-4.5` | Grok 4.5 generation. |

## Pattern 4 — Cross-provider pairing (best-of-breed)

When you want the strongest model in each tier, regardless of who sells it. The default `fast` pick below is `deepseek-v4-flash` wherever available; the default `smart` pick is `claude-opus-5`, with `gpt-5.6-sol` and `kimi-k3` as cross-provider fallbacks.

| Scenario | `fast` 🦾 | `smart` 🧠 |
|---|---|---|
| Coding + lowest cost | `deepseek/deepseek-v4-flash` | `anthropic/claude-opus-5` |
| Coding + multi-provider fallback | `deepseek-v4-flash` + `glm-5.2` (fallback) | `claude-opus-5` + `gpt-5.6-sol` + `kimi-k3` (fallback chain) |
| Coding + flat-fee (best $/quality) | `alibaba-token-plan/deepseek-v4-flash` | `alibaba-token-plan/qwen3.8-max` |
| 1 M context, long repo / PDF research | `deepseek-v4-flash` | `google/gemini-3.6-pro` or `kimi-k3` |
| Multimodal (image / video) | `deepseek-v4-flash` | `anthropic/claude-opus-5` (vision) or `google/gemini-3.6-pro` |
| Multilingual, Chinese-first | `deepseek-v4-flash` | `alibaba/qwen3.8-max` |
| Europe / GDPR preference | `deepseek-v4-flash` (via OpenRouter) | `mistral/mistral-medium-2604` |

---

For live pricing and the full catalog per provider, see [models.dev](https://models.dev/). Model IDs above are real as of the snapshot date; if a provider returns `model_not_found`, run `curl -s https://models.dev/api.json | jq '.<provider>.models | keys'` and update.

**Since v1.6.0 the picker reads pi's own model registry (`ctx.modelRegistry.getAvailable()`)**, so the list shown by `/router config` is the same set `/model` offers — only providers pi has configured auth for (auth.json, env vars, `models.json` commands, runtime login). The local `models-store.json` path is a fallback for headless/test contexts only.
