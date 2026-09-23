# 模型选型目录

> 这一篇教的是**怎么挑**，不是**该贴哪个 ID**——provider 怎么配是你自己的事。路由器直接读 pi 自己的模型目录（`ctx.modelRegistry.getAvailable()`），所以 `/router config` 显示的列表和 `/model` 完全一致，只含 pi 已配鉴权的 provider（auth.json / 环境变量 / `models.json` 命令 / 运行时登录）。拿不准的时候，那里就是答案。

具体模型 ID 会过时，档位名不会。每个大厂都有一套自己的命名套路；知道哪个词是"便宜"、哪个词是"强"，看哪家的目录都不慌。

## 档位名速查表

| 便宜档 | 中间档 | 强档 | 家族 |
|---|---|---|---|
| **Haiku** / **Mini** / **Nano** | **Sonnet** | **Opus** / **Fable** | Anthropic |
| **Luna** | **Terra** | **Sol** / **Astra** | OpenAI（codex 与 chat） |
| **Flash-Lite** | **Flash** | **Pro** | Google Gemini |
| **Plus** / **Turbo** | — | **Max** | 阿里 Qwen |
| **Flash** / **Highspeed** | **Turbo** | 正代 | 智谱 GLM |
| **Flash** | — | **Pro** | DeepSeek |
| **Fast** | — | 正代 | 月之暗面 Kimi |
| **Flash** | — | **Pro** / **UltraSpeed** | 小米 MiMo |
| **Fast** | — | 正代 | xAI Grok |
| **Mini** / **Lite** | 正代 | **Max** | Mistral |

**速记**：凡是叫 **Lite / Flash / Haiku / Luna / Fast / Mini / Nano / Highspeed** 的就是便宜档，凡是叫 **Pro / Max / Opus / Sol / Astra / Fable** 的就是强档。同一家内部的字母套路也守这个规律（Anthropic：Haiku 4.5 < Sonnet 5 < Opus 5 < Fable 5.1）。

## 两条经验法则

> **Fast 档**：直接选 provider 自家的 **Flash / Luna / Haiku / Mini** 系列。2026 年的这一档早就跨过了"凑合能写代码"那道坎——独立基准经常发现 Flash 这一档反超上一代的旗舰。
>
> **Smart 档**：选 provider 自家的 **Opus / Sol / Max / Fable / Pro** 系列。Smart 一定走云；统一内存不到 ~128 GB 的本地 smart 几乎永远跑不过一份 flat-fee 订阅。

## Pattern 1 — 编程套餐（一个 key 走多模型）

一份月费换一组精选模型，API key 是 OpenAI / Anthropic 兼容的，直接插进任何工具：Claude Code、Codex、OpenCode、Cline、Aider、本路由器都行。

| 套餐 | 最便宜 🦾 | 最强 🧠 | 说明 |
|---|---|---|---|
| **Kimi Code**（月之暗面） | Kimi K2.x Code | Kimi K3（约 2.8 T 参数、1 M 上下文） | $19–199/月，一个 key 通吃 Claude Code / Codex / OpenCode / Cline / Aider |
| **GLM 编程套餐**（智谱） | GLM-5.x Highspeed / GLM-5.x-Flash | GLM-5.x 正代 | Z.AI devpack 支持 Claude Code / Cline / OpenCode；约 $18/月 |
| **Qwen Code**（阿里） | Qwen 3.x Plus / Flash | Qwen 3.x Max | 约 $50/月；约 9 万请求/月配额 |
| **Windsurf**（Cognition） | 套餐内可用模型 | Pro/Max 档的前沿模型 | $20–200/月，quota 制 |
| **OpenCode Go** | DeepSeek V4 Flash、Qwen 3.x Plus、MiMo V2.x | Grok 4.x、GPT 5.x Luna/Terra、Kimi K3、GLM-5.x-Flash、Qwen 3.x Max | 首月 $5，之后 **$10/月固定**；OpenAI-compatible |
| **GitHub Copilot** | 套餐内可用模型 | 套餐内的前沿模型 | `api.githubcopilot.com`；接进路由器之前先读条款 |

`smart` 这一列**只放前沿级别**——轻量套餐（OpenCode Go）真的能提供配得上 smart 的模型时才收进来。**对路由器来说，标准只有一条：稳定的 OpenAI-compatible `baseUrl` + 合法的 `apiKey`。** 满足这个就"路由器友好"。

## Pattern 2 — 按量付费网关（一处打通多家）

| 网关 | 你能拿到什么 | 为什么选它 |
|---|---|---|
| **OpenCode Zen** | Anthropic / OpenAI / Google / xAI / Kimi / GLM 一站搞定，Anthropic 风格 + OpenAI 风格双端点 | 要把"强的 + 便宜的"放在同一张账单下，最划算的 flat-fee 池 |
| **OpenRouter** | 380+ 个带价模型，自带 auto router | 目录最全；auto router 优化的是**质量**不是账单（他们自己说选到贵的"是设计如此"）——所以你应该把**某一档**指向 OpenRouter，而不是把整个路由器架在它上面 |
| **Vercel AI Gateway** | 上面任意一家走一个网关 | 你已经在 Vercel 生态时最方便 |
| **Alibaba Token Plan** | Qwen + DeepSeek + Kimi，一个 OpenAI-compatible key | 便宜，国内外同价 |
| **Nebius Token Factory** | DeepSeek / Kimi / GLM / Qwen | 开源权重这一档上性价比不错 |
| **Ollama cloud** | Ollama 云端跑的开放模型，OpenAI-compatible | 同一套本地 API 表面，GPU 更大 |

**所有网关共通的提醒**：当某一档指向网关时，网关的限流和稳定性就成了你整条链的一部分——网关一挂，挂的是它后面所有模型。**做关键 fallback 时不要两个都指向同一个网关**。

## Pattern 3 — 同 Provider 自带 tier ladder（最简）

一个 provider、一张账单、一个限流池。已经有某家付费账户、不想多 key 管理，就用这个。

| Provider | `fast`（Flash / Haiku / Luna 这一档） | `smart`（Opus / Sol / Pro / Fable 这一档） |
|---|---|---|
| **Anthropic** | Haiku | Sonnet → Opus → Fable |
| **OpenAI** | Luna | Terra → Sol → Astra |
| **Google** | Flash-Lite | Flash → Pro |
| **阿里 Qwen** | Plus / Flash | Max |
| **DeepSeek** | Flash | Pro |
| **智谱 GLM** | Flash / Highspeed | 正代 |
| **月之暗面 Kimi** | K2.x / K2.7-Code | K3 |
| **小米 MiMo** | Flash | Pro / UltraSpeed |
| **xAI Grok** | Fast | 正代 |

具体的模型 ID 每次发版都会变，档位名不会变。`pi install` 完，**跑一次 `/model` 看现在你的 Luna / Flash / Pro 是哪一版**。

## Pattern 4 — 跨 Provider 拼装（每档选最强的）

要在两档都拿到各 provider 的最强能力。**我们自己默认**是 fast 用 **DeepSeek V4.x Flash**（便宜、专精代码），smart 用 **Anthropic Opus 或 Fable 这一档**；下表混合家族，给出"跨 provider fallback"的写法——这种 fallback 模式正是两档路由真正的用武之地。

| 场景 | `fast` 🦾 | `smart` 🧠 |
|---|---|---|
| Coding + 最低价 | 任意 **DeepSeek V4 Flash** | 任意 **Anthropic Opus** 这一档 |
| Coding + 多 Provider fallback | DeepSeek V4 Flash + GLM-5.x-Flash | Anthropic Opus + GPT-5.x Sol + Kimi K3 |
| Coding + flat-fee（最佳 $/质量） | OpenCode Go 的 Flash 那一档 | OpenCode Go 里最强的那一档（Grok / GPT Luna / Kimi K3） |
| 1 M 上下文、长 repo 或 PDF 研究 | 任意支持 1 M 上下文的 Flash 档 | **Kimi K3** 或 **Gemini Pro** |
| 多模态（图 / 视频） | 任意 Flash 档 | **Anthropic Opus**（视觉） 或 **Gemini Pro** |
| 多语言、中文优先 | 任意 Flash 档 | **Qwen Max** |
| 欧洲 / GDPR 优先 | DeepSeek Flash（走 OpenRouter 转） | Mistral medium |

真正关键的不是某一行的具体选择，而是**两档可以来自不同 provider**这件事——成本不对称帮你省钱，家族不对称帮你扛住单家故障。

## 本地模型按显存 / 统一内存分级

本地跑 `fast` 是这台路由器最甜的用法：同一个模型每轮都在跑，省下来的都是复利。本地 `smart` 在统一内存不到 128 GB 的机器上基本不划算。

> **量化不是可选项。** 真正跑本地几乎都是 **q4-k-m / NVFP4 / MXFP4 / AWQ-int4 / 1–2 bit ternary**；fp16 是 benchmark 产物。MoE 型号名里的 `AxxB` 是**每个 token 激活的参数**（算力），不是磁盘体积——q4 文件存**每一个** expert，体积按**总量**算。

| 硬件 | 本地 `fast` 候选 | 量化 |
|---|---|---|
| **≤ 32 GB**（RTX 4070 12 GB、RTX 4090 24 GB、M3 Pro 18 GB、M4 Pro 24 GB） | 任意 8–27 B **Flash 这一档**（LiquidAI、Granite、Qwen 3.x、Gemma 4）的 q4，留有余量 | q4-k-m / NVFP4 |
| **32–128 GB**（M2 Ultra 64 GB、A100 80 GB、RTX 6000 Ada 48 GB、RTX 4090 ×2） | 27–35 B 后训练强的（比如带 NEO-MAX 后训练的 Qwen 3.x），或者 MiMo Flash / Laguna S 这种小 MoE | q4-k-m / NVFP4 / q4 |
| **≥ 128 GB**（M3 Ultra 192 GB、M2 Ultra 192 GB、DGX Spark 128 GB） | 高质量 27 B 后训练版（这一档对 fast 来说仍胜过生堆 70 B），或者 200+ B MoE 的 1–2 bit ternary 变体 | q4-k-m / NVFP4 / q4 / 2-bit ternary |

路由器对接的是 OpenAI-compatible API，所以常用运行时都直接可用：**ollama**（`ollama run <flash-model>` 默认起 `:11434`）、**LM Studio**（MLX + GGUF）、**vLLM**、**llama.cpp / llama-server**、**exo**、**llamafile**。路由器对运行时没有特殊绑定。

**Judge 也需要 JSON-mode 端点。** 任何现代 Flash 档（Qwen 3.5+、Gemma 4、MiMo V2.x）都满足；本地 Judge 会多花 ~0.5–2 秒/轮。推荐组合：本地 fast + 本地或云 smart + Judge 放在你最信任的那个 smart 上。

## 怎么验证

- pi 列出的是你运行时能鉴权的一切。开发模式 `pi remove pi-shift-router && pi install .`（本仓库根），发布版 `pi install npm:pi-shift-router`，然后 `/model` 就是真相。
- 目录本身可以用 [models.dev](https://models.dev/) 这类社区聚合——`curl -s https://models.dev/api.json | jq` 实时拉键名。
- 单模型实时价以各 provider 官网为准；档位名就是官网价目表上的标签，不用记 ID 也能读价。
