# 模型选型目录

> 本页只讲选型逻辑，不承诺固定搭配——各家 Provider 差异太大。数据快照于 [models.dev](https://models.dev/)，抓取时间 2026-08-05；用 `curl -s https://models.dev/api.json | jq` 看最新。

## 两条经验法则

> **Fast 档**：如果你使用的 Provider 提供 `deepseek-v4-flash`（2026-07 发布），fast 首选它 —— 0731 刷新把质量拉到了接近 Opus 5 / GLM-5.2 的水平，但价格仍处在表中低位。
>
> **Smart 档**：smart 始终走云。低于 ~80 GB 显存/统一内存的硬件跑本地 smart 极其不划算；96 GB 以上也几乎永远不如 flat-fee 套餐。

## Pattern 1 — 编程套餐（一个 key 走多模型）

列出的是你可混合在 chain 中的候选 ID，不是唯一推荐搭配。适合“一个 key / 多模型”模式的 Provider 分两类：

1. **订阅型编程套餐** —— 每月固定费用买到一批精选模型，通过 OpenAI/Anthropic 兼容的 API key 接入任意工具（Claude Code、Codex、OpenCode、Cline、Aider，或本路由器）。
2. **按量付费网关** —— 一个账号聚合数百模型，想混用多家 Provider 又不想管理一堆 key 时最方便。

下面 `smart` 候选**只放旗舰级**。轻量订阅套餐（OpenCode Go）和网关（OpenCode Zen）只要能真正提供配得上 `smart` 的模型，也一并收录——这两家现在都有了。

| 订阅型编程套餐 | fast 🦾 候选 | smart 🧠 候选 | API 接入方式 |
|---|---|---|---|
| **Kimi Code**（Moonshot） | `moonshotai/Kimi-K2.7-Code` | `kimi-k3`（2.8 T、1 M 上下文） | 一个 key 通吃 Claude Code / Codex / OpenCode / Cline / Aider；$19–199/月 |
| **GLM 编程套餐**（Z.AI） | `glm-5`、`glm-5-turbo` | `zai-org/GLM-5.2` | Z.AI devpack 支持 Claude Code / Cline / OpenCode；约 $18/月 |
| **Qwen Code**（阿里） | `qwen3.7-plus`、`qwen3.6-flash` | `qwen3.8-max`、`qwen3.7-max` | 约 $50/月；约 9 万请求/月配额 |
| **Windsurf**（Cognition） | 可选开源 + 前沿模型 | Pro/Max 档的前沿模型 | $20–200/月，quota 制 |
| **OpenCode Go** | `DeepSeek V4 Flash`、`Qwen3.6 Plus`、`MiMo-V2.5` | `Grok 4.5`、`GPT 5.6 Luna`、`Kimi K3`、`GLM-5.2`、`Qwen3.8 Max` | 首月 $5，之后 $10/月固定费；OpenAI-compatible API key |
| **GitHub Copilot** | 视你的套餐可用的模型 | 视你的套餐可用的前沿模型 | Copilot API（`api.githubcopilot.com`）；接进路由器前先读条款 |

| 按量付费网关 | fast 🦾 候选 | smart 🧠 候选 | API 接入方式 |
|---|---|---|---|
| **OpenCode Zen** | `DeepSeek V4 Flash`、`Qwen3.7 Plus`、`GPT 5.6 Luna` | `Claude Opus 5`、`GPT 5.6 Sol`、`Kimi K3`、`Gemini 3.1 Pro`、`Grok 4.5` | `https://opencode.ai/zen/v1/messages`（Anthropic 风格）/ `/v1/responses`（OpenAI 风格） |
| **Alibaba Token Plan**（intl + CN） | `qwen3.7-plus`、`qwen3.6-flash`、`deepseek-v4-flash` | `qwen3.8-max`、`qwen3.7-max`、`kimi-k3` | OpenAI-compatible |
| **Vercel AI Gateway** | 上述任意走同一网关 | 上述任意 | OpenAI-compatible |
| **OpenRouter** | 200+ 个模型；`auto` **不能**当 Judge target（不透明） | 200+ 个模型 | OpenAI-compatible |
| **Nebius Token Factory** | `deepseek-ai/DeepSeek-V4-Flash`、`moonshotai/Kimi-K2.7-Code` | `Kimi-K3`、`zai-org/GLM-5.2`、`Qwen/Qwen3.7-Max` | OpenAI-compatible |
| **NovitaAI** | `deepseek-ai/DeepSeek-V4-Flash`、`Qwen/Qwen3.6-27B` | `moonshotai/Kimi-K3`、`Qwen/Qwen3.7-Max` | OpenAI-compatible |

> **定价与模型阵容变得很快。** 订阅套餐会频繁改价和换模型（混合 credit / quota 结构、按周刷新上限、按模型超额计费）。接入路由器前，先去各 Provider 官网确认当前套餐与端点。对路由器来说，核心要求只有一个：稳定的 OpenAI-compatible `baseUrl` + `apiKey` —— 满足这个才叫“路由器友好”。

## Pattern 2 — 本地模型按显存 / 统一内存分级

下列推荐均在 2026-08 针对 HuggingFace `safetensors` 权重大小逐个核实。2025 年及以前的旧型号、端侧产物（<7 B）以及 Qwen3.5 / DeepSeek-V3 之前的型号均已排除。

> fp16 只是 benchmark 产物，不是运行时格式。真实本地部署几乎全用 **q4-k-m / NVFP4 / MXFP4 / AWQ-int4 / 1–2 bit ternary**。下表 fast 档一律量化，不出现 fp16。
>
> MoE 型号名里的 `AxxB` 后缀表示**每个 token 激活的参数**——影响的是计算速度，不是磁盘体积。GGUF / q4 文件会存下**每一个** expert 权重，体积按**总量**算。`DeepSeek-V4-Flash` 总量 284 B / 激活 ~13 B，UD-Q4_K_XL 约 155 GB（需要 192 GB+ 统一内存）；q4 不可能只有“~42 GB”，无论名字里激活多少参数。

| 显存 / 统一内存 | 本地 fast 🦾 候选 | 量化 | 本地 smart 🧠 候选 |
|---|---|---|---|
| **≤ 32 GB**（RTX 4070 12 GB、RTX 4090 24 GB、M3 Pro 18 GB、M4 Pro 24 GB） | `LiquidAI/LFM2.5-8B-A1B`（8.5 B、2026-05）、`ibm-granite/granite-4.1-8b`（8.8 B、2026-04）、`Qwen/Qwen3.6-27B`（27.8 B、q4 ≈ 14 GB、当前 HF top）、`google/gemma-4-26b-a4b-it`（26.5 B、q4 ≈ 13 GB）、`Qwen/Qwen3.6-35B-A3B`（36 B 总量 / 3 B 激活、q4 ≈ 18 GB）、`poolside/Laguna-XS-2.1`（33.4 B 总量 / 3 B 激活、q4 ≈ 17 GB、agentic coding、2026-06）、`prism-ml/Ternary-Bonsai-27B-mlx-2bit`（27 B、1.58-bit ternary ≈ 7 GB、笔记本/手机级） | q4-k-m / NVFP4 | 云端前沿模型 |
| **32–128 GB**（M2 Ultra 64 GB、A100 80 GB、RTX 6000 Ada 48 GB、RTX 4090 ×2） | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF`（27 B、MTP + NEO-MAX 后训练、HF 243 万下载、2026-07 —— 这一档后训练最出色的 pick）、`google/gemma-4-31B-it`（31.3 B、q4 ≈ 16 GB）、`poolside/Laguna-S-2.1`（117.6 B、q4 ≈ 59 GB — 需要 64 GB+） | q4-k-m / NVFP4 / q4 | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP`（base 权重）或云端前沿模型 |
| **≥ 128 GB**（M3 Ultra 192 GB、M2 Ultra 192 GB、NVIDIA DGX Spark 128 GB GB10） | `DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF`（同一 pick —— fast 档后训练质量胜过拼体积） | q4-k-m / NVFP4 / q4 | `unsloth/DeepSeek-V4-Flash-GGUF`（284 B 总量 / 激活 ~13 B、UD-Q4_K_XL ≈ 155 GB — 需要 192 GB+ 统一内存；128 GB 级机器用 1–2 bit ternary 备选） |

说明：

- **量化仓库以各 org 独立 HF repo 形式发布**（NVFP4 / AWQ-int4 / GGUF / 1–2 bit ternary）——ollama / vLLM / MLX 会自动识别。具体 repo 名以 org 页面为准，别默认 `-NVFP4` / `-GGUF` 后缀一定存在。
- **任何暴露 OpenAI-compatible API 的运行时都可以**。常见选择：**ollama**（`ollama run qwen3.6:27b` 默认起 `:11434`）、**LM Studio**（MLX + GGUF）、**vLLM**、**llama.cpp** / **llama-server**、**exo**、**llamafile**。
- **Judge 也需要 JSON-mode 端点**。Qwen 3.5+ 和 Gemma 4 都 `tool_call=true`，满足 Judge 的 JSON-mode 约束；但本地 Judge 会增加 ~0.5–2 s/turn。推荐：本地 fast + 本地或云 smart + Judge 放在你最信任的 smart 上。

## Pattern 3 — 同 Provider 自带 tier ladder（最简）

一个 Provider、一张账单、一个限流池。已有某 Provider 付费账户且不想多 key 管理时用这个。

| Provider | fast 🦾 | smart 🧠 | 备注 |
|---|---|---|---|
| **Anthropic** | `claude-sonnet-5` | `claude-opus-5` 或 `claude-fable-5` | Sonnet 5 是当前 fast 档。 |
| **OpenAI** | `gpt-5.6-luna` | `gpt-5.6-sol` | GPT-5.6 内部 `luna` < `terra` < `sol` 三档。 |
| **Google** | `gemini-3.5-flash-lite` | `gemini-3.6-flash` | Gemini 3.x，两档均 1 M 上下文。 |
| **Qwen (Alibaba)** | `qwen3.7-plus` | `qwen3.8-max` | 原生 `plus` / `max` 分级。 |
| **DeepSeek** | `deepseek-v4-flash` | `deepseek-v4-pro` | `flash` ≈ mini 价格档，`pro` ≈ 旗舰。 |
| **Z.AI (GLM)** | `glm-5` 或 `glm-5-turbo` | `glm-5.2` | GLM-5 系列。 |
| **xAI (Grok)** | `grok-4.5-fast` | `grok-4.5` | Grok 4.5 代。 |

## Pattern 4 — 跨 Provider 拼装（最佳单项）

需要在两个档都拿到各 Provider 的最强能力。默认 fast 选 `deepseek-v4-flash`（只要有）；默认 smart 选 `claude-opus-5`，用 `gpt-5.6-sol` 与 `kimi-k3` 作跨 Provider fallback。

| 场景 | fast 🦾 | smart 🧠 |
|---|---|---|
| Coding + 最低价 | `deepseek/deepseek-v4-flash` | `anthropic/claude-opus-5` |
| Coding + 多 Provider fallback | `deepseek-v4-flash` + `glm-5.2`（fallback） | `claude-opus-5` + `gpt-5.6-sol` + `kimi-k3`（fallback chain） |
| Coding + flat-fee（最佳 $/质量） | `alibaba-token-plan/deepseek-v4-flash` | `alibaba-token-plan/qwen3.8-max` |
| 1 M 上下文、长 repo / PDF 研究 | `deepseek-v4-flash` | `google/gemini-3.6-pro` 或 `kimi-k3` |
| 多模态（图 / 视频） | `deepseek-v4-flash` | `anthropic/claude-opus-5`（视觉） 或 `google/gemini-3.6-pro` |
| 多语言、中文优先 | `deepseek-v4-flash` | `alibaba/qwen3.8-max` |
| 欧洲 / GDPR 优先 | `deepseek-v4-flash`（OpenRouter 转） | `mistral/mistral-medium-2604` |

---

**自 v1.6.0 起，向导读取 pi 自身的模型目录（`ctx.modelRegistry.getAvailable()`）**——所以 `/router config` 显示的列表与 `/model` 一致（只含 pi 已配置鉴权的 provider：auth.json / 环境变量 / `models.json` 命令 / runtime 登录）。本地 `models-store.json` 路径仅作为 headless/测试场景的兜底。

实时定价与每个 Provider 完整模型列表见 [models.dev](https://models.dev/)。表中模型 ID 截至快照日均验证存在；若 Provider 返回 `model_not_found`，运行 `curl -s https://models.dev/api.json | jq '.<provider>.models | keys'` 查最新。
