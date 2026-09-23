# Model Pairings

> This page teaches **how to choose**, not **what to paste** — your provider setup is yours. The router reads pi's own model registry (`ctx.modelRegistry.getAvailable()`), so `/router config` shows exactly what `/model` shows, and only providers pi has configured auth for (auth.json, env vars, `models.json` commands, runtime login). When in doubt, look there.

Model IDs go stale; tier names don't. Every major family uses one of these naming conventions, and once you know which word means "cheap" and which means "strong", you can read any provider's catalog at a glance.

## The tier-name glossary

Use this as a decoder ring. Tier names survive version bumps; specific model IDs rarely do.

| "Cheap" tier name | "Mid" tier name | "Strong" tier name | Family |
|---|---|---|---|
| **Haiku** / **Mini** / **Nano** | **Sonnet** / **Mini** | **Opus** / **Fable** | Anthropic |
| **Luna** | **Terra** | **Sol** / **Astra** | OpenAI (codex/chat) |
| **Flash-Lite** | **Flash** | **Pro** | Google Gemini |
| **Plus** / **Turbo** | — | **Max** | Alibaba Qwen |
| **Flash** / **Highspeed** | **Turbo** | mainline | Z.AI GLM |
| **Flash** | — | **Pro** | DeepSeek |
| **Fast** | — | mainline | Moonshot Kimi |
| **Flash** | — | **Pro** / **UltraSpeed** | Xiaomi MiMo |
| **Fast** | — | (mainline) | xAI Grok |
| **Mini** / **Lite** | mainline | **Max** | Mistral |

Quick mnemonic: anything called **Lite / Flash / Haiku / Luna / Fast / Mini / Nano / Highspeed** is the cheap tier; anything called **Pro / Max / Opus / Sol / Astra / Fable** is the strong tier. The same letter-pattern holds inside one provider's catalog (e.g. Anthropic: Haiku 4.5 < Sonnet 5 < Opus 5 < Fable 5.1).

## Two rules of thumb

> **Fast tier**: pick the provider's own **Flash / Luna / Haiku / Mini** class. These have moved well past "good enough for daily coding" in 2026 — third-party benchmarks routinely find a Flash class beating the previous generation's flagship.
>
> **Smart tier**: pick the provider's own **Opus / Sol / Max / Fable / Pro** class. Keep smart on a cloud model; local smart under ~128 GB of unified memory rarely beats a flat-fee subscription.

## Pattern 1 — Subscription coding plans (one key, many models)

A flat monthly fee buys access to a curated model set, exposed through an OpenAI/Anthropic-compatible API key. Plug the key into any tool — Claude Code, Codex, OpenCode, Cline, Aider, or this router.

| Plan | Cheapest tier 🦾 | Strongest tier 🧠 | What you get |
|---|---|---|---|
| **Kimi Code** (Moonshot) | Kimi K2.x Code | Kimi K3 (≈ 2.8 T params, 1 M context) | $19–199/mo, one key for Claude Code / Codex / OpenCode / Cline / Aider |
| **GLM Coding Plan** (Z.AI) | GLM-5.x Highspeed / GLM-5.x-Flash | GLM-5.x mainline | Z.AI devpack for Claude Code / Cline / OpenCode, ~$18/mo |
| **Qwen Code** (Alibaba) | Qwen 3.x Plus / Flash | Qwen 3.x Max | ~$50/mo, ~90k requests/mo quota |
| **Windsurf** (Cognition) | available open + frontier models | frontier models on Pro/Max | $20–200/mo, quota-based |
| **OpenCode Go** | DeepSeek V4 Flash, Qwen 3.x Plus, MiMo V2.x | Grok 4.x, GPT 5.x Luna/Terra, Kimi K3, GLM-5.x-Flash, Qwen 3.x Max | $5 first month, then **$10/mo flat**; OpenAI-compatible |
| **GitHub Copilot** | plan's available models | plan's frontier models | `api.githubcopilot.com`; read the ToS before wiring a router into it |

The `smart` row is **frontier-class only** — lightweight plans (OpenCode Go) are listed when they actually expose a model strong enough for the job. **The router is happy with any plan that speaks an OpenAI-compatible API**; the requirements are a stable `baseUrl` and a valid `apiKey`.

## Pattern 2 — Pay-per-token gateways (mix providers without juggling keys)

| Gateway | What you get | Why pick it |
|---|---|---|
| **OpenCode Zen** | Anthropic / OpenAI / Google / xAI / Kimi / GLM in one place, both Anthropic-style and OpenAI-style endpoints | Best $/quality flat-fee pool when you want strong + cheap under one bill |
| **OpenRouter** | 380+ priced models, auto router for raw API use | The widest catalog; the auto router optimizes for *quality*, not your bill (their words: an expensive pick "is working as designed") — which is why you'd point a **tier** at OpenRouter, not the router itself |
| **Vercel AI Gateway** | any of the above through one gateway | Convenient when you're already on Vercel |
| **Alibaba Token Plan** | Qwen + DeepSeek + Kimi on one OpenAI-compatible key | Cheap, China-international parity |
| **Nebius Token Factory** | DeepSeek / Kimi / GLM / Qwen | Good price/quality on the open-weights tier |
| **Ollama cloud** | Cloud-hosted open models on Ollama's API, OpenAI-compatible | Same local API surface, bigger GPUs |

**One warning shared by all of them:** when you set a tier to a gateway model, the gateway becomes part of your rate-limit and reliability story — a gateway outage affects every model behind it. Point critical failover chains at *different* gateways, not the same one twice.

## Pattern 3 — Same-provider tier ladder (simplest)

One provider, one bill, one rate-limit pool. Use this if you already have a paid account and don't want to juggle keys.

| Provider | `fast` (any Flash / Haiku / Luna) | `smart` (any Opus / Sol / Pro / Fable) |
|---|---|---|
| **Anthropic** | Haiku | Sonnet → Opus → Fable |
| **OpenAI** | Luna | Terra → Sol → Astra |
| **Google** | Flash-Lite | Flash → Pro |
| **Alibaba (Qwen)** | Plus / Flash | Max |
| **DeepSeek** | Flash | Pro |
| **Z.AI (GLM)** | Flash / Highspeed | mainline |
| **Moonshot (Kimi)** | K2.x / K2.7-Code | K3 |
| **Xiaomi (MiMo)** | Flash | Pro / UltraSpeed |
| **xAI (Grok)** | Fast | mainline |

The exact model IDs change with each release; the tier names don't. After you `pi install`, run `/model` to see which Luna / Flash / Pro is current in your setup.

## Pattern 4 — Cross-provider pairing (best of breed)

When you want the strongest model in each tier regardless of who sells it. The default in our own setup is **DeepSeek V4.x Flash** for fast (cheap, well-tuned for code) and **Anthropic Opus or Fable class** for smart; the table below mixes families and includes the cross-provider fallback pattern that makes a chain resilient to any single outage.

| Scenario | `fast` 🦾 | `smart` 🧠 |
|---|---|---|
| Coding + lowest cost | any **DeepSeek V4 Flash** | any **Anthropic Opus** class |
| Coding + multi-provider fallback | DeepSeek V4 Flash + GLM-5.x-Flash | Anthropic Opus + GPT-5.x Sol + Kimi K3 |
| Coding + flat-fee (best $/quality) | OpenCode Go's Flash class | OpenCode Go's strongest (Grok / GPT Luna / Kimi K3) |
| 1 M context, long repo or PDF research | any Flash class with 1 M ctx | **Kimi K3** or **Gemini Pro** |
| Multimodal (image / video) | any Flash class | **Anthropic Opus** (vision) or **Gemini Pro** |
| Multilingual, Chinese-first | any Flash class | **Qwen Max** |
| Europe / GDPR preference | DeepSeek Flash (via OpenRouter) | Mistral medium |

The point isn't any specific row — it's that **routing across two tiers earns its keep precisely because the two rows can come from different providers**. That's also why we keep "smart" on a frontier model and "fast" on a cheap one: the cost asymmetry does the saving, the family asymmetry does the resilience.

## Local models by VRAM / unified memory

Local `fast` is the sweet spot for this router: same model runs every turn, every penny you save compounds. Local `smart` is rarely worth it on hardware under 128 GB of unified memory.

> **Quantization is not optional.** Real local deployments run **q4-k-m / NVFP4 / MXFP4 / AWQ-int4 / 1–2 bit ternary**; fp16 is a benchmark artifact. The MoE `AxxB` suffix on a model name is **active parameters per token** (compute), not disk size — a q4 file stores every expert, so it scales with **total** parameters.

| Hardware | Local `fast` candidates | Quant |
|---|---|---|
| **≤ 32 GB** (RTX 4070 12 GB, RTX 4090 24 GB, M3 Pro 18 GB, M4 Pro 24 GB) | any 8–27 B **Flash class** (LiquidAI, Granite, Qwen 3.x, Gemma 4) at q4 — fits with room to spare | q4-k-m / NVFP4 |
| **32–128 GB** (M2 Ultra 64 GB, A100 80 GB, RTX 6000 Ada 48 GB, RTX 4090 ×2) | a 27–35 B class with strong post-training (e.g. Qwen 3.x with NEO-MAX-style training), or a small MoE like MiMo Flash / Laguna S | q4-k-m / NVFP4 / q4 |
| **≥ 128 GB** (M3 Ultra 192 GB, M2 Ultra 192 GB, DGX Spark 128 GB) | a high-quality 27 B post-trained (still better than a raw 70 B for `fast`), or a 200+ B MoE with a 1–2 bit ternary variant | q4-k-m / NVFP4 / q4 / 2-bit ternary |

Common runtimes that expose an OpenAI-compatible API the router can hit: **ollama** (`ollama run <flash-model>` → `:11434`), **LM Studio** (MLX + GGUF), **vLLM**, **llama.cpp / llama-server**, **exo**, **llamafile**. The router binds to none specifically.

**The Judge also needs a JSON-mode endpoint.** Any modern Flash class (Qwen 3.5+, Gemma 4, MiMo V2.x) supports it; a local Judge adds ~0.5–2 s per turn. Recommended: local `fast` + cloud or local `smart` + Judge on whichever `smart` you trust most for the kind of work you do.

## How to verify any of this

- `pi` lists whatever your runtime can auth against. `pi remove pi-shift-router && pi install .` from this repo (in dev) or `pi install npm:pi-shift-router` (published) and then `/model` is the source of truth.
- For the catalog itself, [models.dev](https://models.dev/) is a community aggregator; `curl -s https://models.dev/api.json | jq` shows the current keys.
- For live pricing per model, the provider's pricing page is the source — and it's where the tier names live too, so you don't need a model ID to read a price list.
