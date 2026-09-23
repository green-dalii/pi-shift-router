<!--
SEO 元数据（用户不可见，供爬虫 / LLM 解析）：
- name: pi-shift-router
- type: software / npm 包 / pi-coding-agent 扩展 / 模型路由器 / LLM 分类器
- license: MIT
- language: TypeScript
- runtime: Node.js >= 24
- dependencies: 仅 @earendil-works/pi-tui（宿主导入；声明为依赖以便隔离子树安装）
- npm: https://www.npmjs.com/package/pi-shift-router
- repo: https://github.com/green-dalii/pi-shift-router
- canonical: https://github.com/green-dalii/pi-shift-router/blob/main/README.zh-CN.md
- docs: README.md / README.zh-CN.md / docs/CONFIG.zh-CN.md / docs/MODELS.zh-CN.md / docs/TROUBLESHOOTING.zh-CN.md
- first-published: v0.4.0
- latest: v1.7.0
- last-updated: 2026-09
- alternate-names: shift router, pi extension, model router, two-tier router, auto router, tier model router, model failover router
- search-intents: "为什么要做模型路由", "模型分层 价格跨度", "LLM 路由 省钱", "OpenRouter auto router 替代", "Jev 怎么用", "TypeSafe Jev 决策模型", "Jev 校准概率 路由器", "决策模型为什么比 LLM Judge 更契合", "拿概率回答的判定器", "System One 决策模型 路由", "决策模型 HTTP API", "自动路由 pi agent 每轮", "可插拔 Judge 模型", "Jev 作为 Judge", "决策模型做路由判定", "LLM 作为分类器", "两层模型路由", "遇 429 模型的自动 failover", "402 余额不足自动切换模型", "Codex usage limit 自动 failover", "成本与质量模型选择", "pi-coding-agent 扩展", "模型冷却指数退避", "JSON-mode 分类器", "pi-shift-router vs pi-bifrost", "pi-shift-router vs pi-smart-router", "pi 自动切换便宜模型", "任务级编排 pi", "Smart CTO 派发 Fast 子代理", "pi agent 子代理编排", "worker 花费归因", "编排成本统计", "TUI 状态仪表盘", "pi 模型目录对齐", "router config 与 /model 一致", "ModelRegistry available 快照"
- features: 两层路由、任务级编排（Smart 档作为 CTO 派发给 Fast 工程师）、可插拔 Judge（复用 Fast 链 / 独立 Judge LLM / 决策模型如 Jev（Beta、可选）—— 见 Jev 小节）、LLM Judge、JSON-mode 分类器、滑动窗口降级门、多模型 fallback 链、TUI 配置向导、指数退避运行时 failover（429/402/5xx + Codex usage limit 耗尽）、路由与 Judge 共享冷却、cache-aware 路由（同 Provider 缓存保护）、跨 Provider、零配置起步、token 吞吐遥测、TUI 状态仪表盘（上下文窗口与缓存命中率仪表、链内联冷却、最近决策、花费）、per-worker 花费归因（有界编排账本，`orchestration $X (N workers)`）、EV 经济学路由与齿轮预设（eco/default/sport）、任务级编排（默认开启：Smart 档作为 CTO 派发给 Fast 子代理；需安装 pi-subagents）、pi 模型目录对齐（向导 + Judge + 遥测共享 `/model` 等价列表）
- direct-competitor: "@tenchi4u/pi-bifrost（7 阶段启发式 + 订阅配额）· pi-smart-router（12 阶段本地管线 + HyDRA + Virtual Cost v2）"
- author: green-dalii（https://github.com/green-dalii）
-->

![pi-shift-router 首图 —— 例行的轮次留在便宜档；判定时刻把重要的工作升级到强档，由它规划并派发给 Fast 工程师](assets/hero.jpeg)

# pi-shift-router

> **别再为日常琐事付旗舰模型的钱，也别把最难的活交给廉价模型。**

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

[English](README.md) | [简体中文]

[🌐 项目官网](https://shiftrouter.greenerai.top) | [⚙️ 工作原理](#工作原理) | [🚀 为什么是现在](#为什么是现在) | [🚀 快速开始](#快速开始) | [🧭 Jev：用数字回答的判定器](#jev让决策模型来当判定器beta) | [⚖️ 对比其它方案](#对比其它方案) | [❓ 常见问题](#常见问题) | [🔧 配置参考](docs/CONFIG.zh-CN.md) | [🩺 故障排查](docs/TROUBLESHOOTING.zh-CN.md)

你为两档智能付了钱，但每轮只能用其中一档。

你发出的每条消息都是一次下注：这活儿值不值得上贵模型？赌高了，改个变量名也在烧旗舰价；赌低了，架构问题拿回一个浅补丁。于是多数人干脆选定一个模型不再改，两种亏都默默吃下。

这个扩展把这一注取消掉。一个小判定器读你的消息、选一档，这一档就带着整轮跑完——思考、工具调用、改文件。你配两条链，贵的那条只花在真正改变结果的地方。它以 [pi-coding-agent](https://github.com/earendil-works/pi) 扩展的形式运行：没有服务端，没有每次调用的额外设置。

```text
🦾 [deepseek-v4.1-flash] → fix the failing test
🧭 judging…
🧠 [claude-fable-5]              ← "design the auth flow" → upgraded instantly
⚠️ deepseek-v4.1-flash 429 → switching to glm-5.3-flash — retry in 1m
🦾 [glm-5.3-flash]                    ← same-tier failover
```

任务真的很大时，光选对模型还不够：Smart 档会变成 CTO——规划、把实现派给 Fast 子代理、逐项审核、迭代。这就是任务级编排，复杂任务默认开启。

> **编排需要 [`pi-subagents`](https://www.npmjs.com/package/pi-subagents)**（`pi install npm:pi-subagents`）。没装也能照常路由，只是复杂任务直接在 Smart 档上跑，不做派发。

判定器本身有三种模式，第三种是另一类模型：**Jev**，用概率而不是文字回答的决策模型。没有东西需要解析，一次判定约 \$0.0001，默认关闭、标注 Beta——[完整的实话在这里](#jev让决策模型来当判定器beta)。

- 升级立刻生效；降级要连续两轮 `fast`。
- 每档都是 fallback 链，配指数退避冷却，429 不会中断你的会话。
- 一个配置文件；没配模型之前它什么都不做。

```bash
pi install npm:pi-shift-router   # 然后：/router config → /router status
```

---

## 为什么是现在

最近发生的三件事，让"每轮路由"从聪明技巧变成了合理默认。

**1. 厂商把自家家族切成了阶梯，同一家族内价差很大。**

| 家族 | 最便宜档 | 最强档 | 价差 |
|---|---|---|---|
| OpenAI | GPT-5.6 **Luna** $0.20/M | GPT-5.6 Sol $5 → GPT-6 Astra $10 | **50×** |
| Anthropic | Haiku 4.5 $1 | Opus $5 → Fable 5 $10 | **10×** |
| Google | Gemini Flash-Lite $0.10 | Flash $0.75 → 3.1 Pro $2 | **20×** |
| GLM | **5.3-Flash** $0.15 | GLM-5.3 $1.40 | **9×** |
| MiMo | $0.14 | $1.31 | **9×** |
| DeepSeek | V4.1 **Flash** $0.30 | V4 Pro $1.32 | **4×** |

价格取自 pi 自带目录的输入价（41 个 provider、**1443** 个带价模型）——打开 `/model` 就能核对。便宜档往往已经够用：一项独立对比显示 MiMo-V2.6-Flash 在某个基准上反超 Pro 档，价格只有三分之一。

**2. 可选项多到没法手工选。**

光 OpenRouter 就有 **380** 个带价模型，从 Mistral Nemo（$0.019）到 GPT-5.5 Pro（$30）横跨 **1579×**。再加上 Cloudflare AI Gateway（51）、Vercel（236）、`opencode`（70）、Ollama 云端模型，以及像 OpenCode Go 那样 $10/月 28 个模型的包月池——包月里切换不额外花钱。

**3. 判定本身成了一种专门的模型类别。**

以前判断"这轮难不难"，得调一个前沿模型，再从它写的话里抠 JSON。2026 年 9 月 TypeSafe 发布了 **Jev**，一个 *System One* 模型：给它 state 和类型化问题，返回带概率的类型化答案，不生成一句话。用分类模型做分类，既更便宜也更不容易碎——[细节和代价在这里](#jev让决策模型来当判定器beta)。

---

## 对比其它方案

| | 它擅长什么 | 它做不到什么 |
|---|---|---|
| **OpenRouter Auto Router** | 零配置、按市场数据选模型、有 `cost_tier` 旋钮。裸调 API 很好用。 | 它优化的是**质量**，不是你的账单——OpenRouter 自己的文档说选到贵模型"是设计如此"。档位不由你定，判定你看不到，失败模式也不在你手里。 |
| **Cloudflare AI Gateway Dynamic Routing** | 网关侧版本化路由流，带配额与 fallback。 | 流程要按网关手写，而且它看到的是**请求**，不是**任务**——它不知道哪一轮是架构设计。 |
| **只用一个强模型** | 永远不会选错。 | 你会永久地为 `修个拼写错误` 付旗舰价。 |
| **全靠手动** | 免费。 | 直到你第一次忘了切回来——而这就是问题的全部。 |

一句话的区别：本插件按**任务形态**、在你自己的 agent 里、在你定义的两条链之间路由，每个判定都能在 `/router status` 里看到。

---

## 工作原理

每轮只做一次便宜调用。Fast 档模型（通常是你最便宜的）读你的消息，判为 `fast`（例行）或 `smart`（值得上贵模型），并给出 0–1 的置信度。整个系统只有这一处判定；选中的档位随后跑完整轮。

**默认为什么偏向"多花钱"。** 判错的代价在两个方向上完全不同。把简单任务升档，只多付一次价差；把难任务留在便宜档，要重做一轮，还得再付一次贵模型的钱，外加你的时间。所以路由器不该 50/50 地赌：

> 当这轮需要 smart 的概率不低于 θ 时，就走 smart。默认 **θ ≈ 0.33**。

置信度就是这个概率。`smart` 且置信度 0.9，意味着 90% 需要；`fast` 且 0.9，意味着 10%——所以一个很确定的 `fast` 是最强的"保持便宜"信号。低于 `minConfidence`（0.5）的判定直接忽略，路由器停在原处。

| 判定 | 置信度 | 需要 smart 的概率 | 结果 |
|---|---|---|---|
| `smart` | 0.9 | 0.90 | 🧠 smart |
| `smart` | 0.2 | 0.20 | 🦾 fast——这次判定太弱 |
| `fast` | 0.9 | 0.10 | 🦾 fast |
| `fast` | 0.6 | 0.40 | 🧠 smart——"大概是简单"还不够简单 |
| 任意 | < 0.5 | — | 保持：不猜 |

0.33 是怎么来的：两档的价差在比较中会被约掉，真正决定阈值的是"翻车有多疼"相对于这档价差的比例（`reworkPenalty`，默认 3——翻车约等于 3 倍价差，所以三分之一的可能需要好模型就值得升）。`/router sport` 把惩罚提到 5，路由更激进（θ = 0.2）；`/router eco` 降到 2，更保守（θ = 0.5）。

**两条防线防止来回抖。** 升级立即生效；降级要连续两轮 `fast`。另外两档共用同一个 provider 时，路由器会抬高门槛，并在 prompt 缓存还热时拒绝降级——因为中途换档会让下一个模型按全价重读整段对话。

判定必须机器可读：OpenAI 兼容端点用 `response_format: json_object`（非 JSON 会被 API 拒绝），Anthropic 用 `{` 前缀强制 JSON。判定期间状态栏显示 `🧭 judging…`。判定调用失败时，路由器保持当前档位，不猜。

**三种判定模式（v1.7.0）。** 复用 Fast 档链（默认，无需额外配置）、独立的 Judge LLM 链（编辑方式与档位相同）、或决策模型——见 [Jev](#jev让决策模型来当判定器beta)。

### 当 Provider 挂掉时

429 / 402 / 5xx / 配额 / Token 套餐耗尽 / Codex `usage limit` / 账户余额不足？pi 先重试（Provider ×3 + Agent ×3），仍失败就轮到路由器：

1. 失败模型进入指数退避冷却——5xx 从 1m 起步（1m → 4m → 16m → 1h → 4h … 封顶 6h）；可触发 failover 的 4xx（429 限流 / 402 余额不足 / 配额）跳过前两档、直接从 16m 起步，因为客户端侧限流窗口或账户余额恢复通常比服务器瞬时故障长得多。
2. 立即 `setModel` 到同一档的下一个健康模型（绝不跨档）。
3. pi 待定的重试直接打到备用模型上——同轮完成接管。
4. 后续轮次自动跳过冷却中的模型；2xx 响应立即解除冷却，会话重启全部重置。

Judge 与路由共用同一张冷却表（判定失败也会走完整条 fast 链才放弃）；手动 `/route-force` 永远绕过冷却；认证/配置错误（400/401）不触发 failover。

---

## Jev：让决策模型来当判定器（Beta）

判定器每轮只回答一个问题：这活难不难？多数路由器的做法是问一个 LLM，再从回复里抠 JSON。Jev 是另一类模型——你给它一个带选项的问题，它直接回选项和概率：

```jsonc
// POST /v1/systemone —— 实际返回就是这个
{ "model": "jev-1.13.0",
  "answers": {
    "tier":        { "choice": "fast", "probabilities": { "fast": 0.99, "smart": 0.01 } },
    "orchestrate": { "noul": 0.13 } } }
```

路由器需要的全在这份响应里：拿 `0.99` 跟 θ 一比，完事。没有 JSON 模式、没有解析步骤，也就没有了"模型多加一个逗号导致判定失败"这一整类故障。字段缺失＝没有判定，路由器保持原档。同一次调用还顺带回答了要不要编排（`noul ≥ 0.5`），复杂任务不需要判两次。

便宜也是同一个原因：判定只花输入 token，一次约 **\$0.0001**。LiteLLM 在 2026 年 9 月把同样的思路做进自家 Auto Router，实测 `jev` 分类器比 Haiku 级快 **5.43 倍**、便宜 **96%**。

### 代价

Jev 在公测，实话是：

- **现在慢。** 我们实测每次 **1.4–6.6 秒**（中位约 5 秒），而且把 prompt 缩小 5 倍也不会变快——那是 Provider 算力还在爬坡，不是集成层能解决的。同一份 rubric 交给快的 LLM 判定约 1.4 秒。批处理、后台任务、高吞吐路由合适；交互式对话仍然用 LLM 判定更好。
- **证据是混合的。** 2026 年 9 月的独立评测发现，决策模型在 15 项标注任务中有 14 项落后于当项最佳 LLM。
- **所以它是可选项。** `/router config` → `🧭 Judge` 里两个 LLM 方案排在前，Jev 排第三并标注 Beta。升级不会改变你的默认。

### 接入它

pi 没有内置 Jev provider，需要在 `~/.pi/agent/models.json` 加一个：

```jsonc
{ "providers": { "typesafe": {
    "baseUrl": "https://api.typesafe.ai",
    "api": "typesafe-decisions",     // 本插件识别决策端点的标记
    "apiKey": "$TYPESAFE_API_KEY",
    "models": [ { "id": "jev-latest", "name": "Jev", "input": ["text"],
                  "contextWindow": 64000, "cost": { "input": 0.042, "output": 0 } } ] } } }
```

Key 在 [TypeSafe 控制台](https://console.typesafe.ai/settings/keys) 领（早期访问）。然后 `/router config` → `🧭 Judge` → `🧮 Jev — decision model (Beta)` → `typesafe/jev-latest`。保存时不发网络请求，向导会顺手把 `judgeTimeout` 抬到 15 秒——默认 5 秒会把大多数决策调用掐断。Jev 不响应时，路由器降到你的 LLM 判定而不是卡住；再不行就退回纯路由。它不会出现在 Fast/Smart 选择器里：pi 无法把该协议当聊天模型流式调用。

---

## 任务级编排（v1.0.0）

平时路由只决定这一轮用哪个模型。当判定说 `smart` 且编排处于 `auto`（默认）时，Smart 档还会接管这一轮*怎么跑*：规划工作、把实现派给 Fast 子代理、逐项审核、迭代到干净，最后做一次验收。`fast` 判定不会触发这些，那些轮次照旧走普通路由。

### 一个编排轮次怎么跑

1. **进入。** 判定说 `smart` → 路由器把主模型切到 Smart 档并注入一条编排指令（你的角色、派发规则、硬上限）。状态栏全程显示实时遥测：CTO 规划期为 `[🧠 deepseek] • 42 tok/s`（🪄 只在 worker 真正派发后才出现），Fast worker 跑起来后为 `🪄 Done(2)/Total(3) • ~30 tok/s`。
2. **规划。** Smart 把任务拆成多个阶段，每个阶段带验收标准。
3. **派发。** 每个阶段通过 `subagent` 工具拉起一个 Fast 子代理——`agent: "worker"`、`context: "fresh"`、模型钉在你** Fast 档**——配一份自包含的任务契约（目标、约束、验收标准、要动的文件）。
4. **审核。** Smart 按验收标准读每个 worker 的结果。失败阶段带着具体反馈回到 worker——或连续失败 N 次后由 Smart 亲自接管。
5. **验收。** 以一段简短的 CTO 总结 + 最终验收收尾。

### worker 为什么要 fresh 上下文

worker 以 `context: "fresh"` 运行——不继承会话历史。任务字符串*就是它的全部世界*，所以必须是一份精确契约：目标、约束、验收标准、范围外。这让每个 worker 的上下文都很小（快、便宜、专注——实测窄任务约 $0.004，继承 176k token fork 约 $0.06），也是让 anthropic 兼容端点保持思考开启的已验证方式（fork 模式会被强制 `thinking: off`）。

### 硬上限

插件强制执行两个数字，与 Smart 想做什么无关：
- **`orchestration.maxRounds`**（默认 3）——每个任务最多 delegate→review 轮数。
- **`orchestration.escalationThreshold`**（默认 2）——某阶段 worker 连续失败 N 次，Smart 亲自接管该阶段。

循环在 Smart 说完成、或命中上限时停止——两者任一即停。

### 验收审计

验收是 Smart 档自己的判断，所以插件在每个**实际委派过 worker**（`spawned ≥ 1`，在 `agent_end` 检查）的编排轮结束后再加一道意见。自己做完的轮次（`spawned = 0`）完全跳过审计——没有警告，只在 `/router status` 标一个 `(self-executed)`。

1. **确定性检查（零成本）：** 所有 worker 都已回包（`done == spawned`）、最后一条消息带 **CTO 总结**（输出契约标记）、以及是否命中硬上限。
2. **LLM 审计（默认开启，Fast 档一次小调用）：** 审计 prompt 读取**原始用户目标**（进编排时快照）、CTO 总结与 worker 结果，从三个维度核验：
   - **有据（Grounding）** —— 验收主张有实际结果支撑（没看结果就说 done、忽略 worker 失败、前后矛盾）。
   - **目标对齐（Goal alignment）** —— 交付物确实回应了用户请求（无范围漂移、核心诉求有答）。
   - **交付质量（Delivered quality）** —— worker 输出完整，不是占位/TODO 充数，无空结果、无“没做完”。

审计不阻断已完成的轮次，只做标记：`console.warn` 加一个 toast，`/router status` 的 `Last audit` 显示最近一次运行的结果。用 `orchestration.audit.enabled`（默认 `true`）关闭。这是整个循环里唯一不采信 CTO 自审的环节。

### 什么时候不触发

- **简单任务**（`fast` 判定）——永远普通路由。例行工作绝不强制编排。
- **未安装 `pi-subagents`**——复杂任务直接在 Smart 档运行，和以前一模一样。不崩溃、不死锁。
- **编排设为 `off`**（`/router orchestrate off`）——仅基础两档路由。

---

## 什么时候值得 / 什么时候不值得

**值得用**

- **长会话、难度不均**：几十轮例行 + 偶尔重要的事。例行的留在便宜档，重要的事自动升级到强档，全程不用手动切模型。
- **想要“粘住”的深度模式**：规划会话自动停在强档，动手改文件后再降回来。
- **担心 Provider 限流**：每档配 2–3 个模型，429/5xx 自动同档接管。

**不值得用**

- **难度均匀的会话**：全是例行或全是重要的事——每次判定都是纯开销（约 200ms–2s，加几千 token）。
- **从不配置档位**：两档皆空，路由器是 no-op。
- **不信任 Fast 档模型的判断力**：判定质量 = 你给它的模型；判错时它只会保守地停在当前档位。

---

## 快速开始

前置要求：Node.js ≥ 24、pi-agent ≥ 0.80、至少一个 Provider 账号（API key 已写入 pi-agent 的 `auth.json`）。

**1. 安装**

```bash
pi install npm:pi-shift-router
```

本地开发用 `pi install <仓库路径>`，git 安装用 `pi install git:github.com/green-dalii/pi-shift-router`。安装后注册进 `~/.pi/agent/settings.json`，下次启动 pi 自动加载。

**1.5.（推荐）开启编排能力**

```bash
pi install npm:pi-subagents   # Smart CTO → Fast 子代理派发
```

编排**默认开启**（`auto` 模式）；这一步装上它要派发的子代理机制。不装也能用——仅基础两档路由。

**2. 配置**

```text
/router config
```

给 Fast 档、Smart 档各选一个模型；每档多个也行，按优先级组成 fallback 链。保存到用户级或项目级作用域——两边都设时项目级优先。**向导显示的列表就是 pi 的 `/model` 给出的那份已配置可用模型**（自 v1.6.0 起，读取 pi 自己的 `ModelRegistry`，不再用本地重建目录）。

向导里还有 **🔒 Cache-aware routing**——当 Fast 与 Smart 同属一个 Provider（如都是 Anthropic）时默认开启。它保护 prompt 缓存：有效 smart 闸 θ 除以 `sameFamilyPenalty`（更少降级），且缓存还热时抑制中途降级，让“路由到更便宜的模型”永远不会比不路由更贵。可在向导里开关，或改配置文件 `routing.cacheAware.enabled`。

**3. 验证**

```text
/router status
```

会打开一个主题化仪表盘（q / Esc 关闭）：当前档位与模型、上下文窗口与缓存命中率仪表、最近一次路由决策、会话省钱金额（编排时另有 worker 花费）、两条链与内联冷却，以及一段白话的"路由如何决策"。下一轮发消息触发首次判定。

---

## 命令

| 命令 | 作用 |
|------|------|
| `/router status` | 打开状态仪表盘（TUI）：当前模型、最近决策、花费、链路、健康度、配置层 |
| `/router on` / `/router off` | 启用 / 停用路由 |
| `/router config` | 打开 TUI 配置向导 |
| `/router quiet` | 关闭内联 toast 提示 |
| `/router verbose` | 打开详细日志 |
| `/router eco\|default\|sport` | 换挡经济预设（持久化）：**eco** → R=2（θ=0.5，更省——只有明确需要 smart 的轮才升级），**default** → R=3（θ≈0.33），**sport** → R=5（θ=0.2，更积极——只要有需要 Smart 的苗头就升级）。顶层命令词，pi 可直接 Tab 补齐；当前模式与预设表见 `/router status` |
| `/router orchestrate auto` | 任务级编排（默认）：复杂任务 → Smart 档作为 CTO 派发给 Fast 子代理；简单任务仍走普通路由 |
| `/router orchestrate off` | 关闭编排——仅基础两档路由 |
| `/route-force <档位>` | 下一轮强制走某档 |
| `/route-force <provider>/<model>` | 下一轮强制指定模型 |
| `/route-force auto` | 清除手动覆盖 |

> **原生模型切换 vs 路由器权威。** 用 pi 自带的模型切换器（`/model`、`Ctrl+P`
> 循环）只会**同步状态栏显示**——路由器仍保留每轮模型决定权。下一轮
> `before_agent_start` 会通过 Judge 重新路由（升级 / 降级 / 首轮 / failover
> 路径），所以原生切换可能在一轮内被覆盖。想锁定模型恰好一轮用
> `/route-force`；想完全手动控制请 `/router off`（状态栏显示 `⛔`）。

`/router status` 还会展示**花费统计**——各档位花费与路由替你省了多少钱：

```
Money · this session
  saved   $2.742 of $3.210  (85%)  vs all-smart: opencode-go/deepseek-v4.1-flash
  spent   $0.465  fast ▓░░░░░░░░░ 10% · smart ▓▓▓▓▓▓▓▓░░ 90%
  orchestration  $0.0689  (5 workers)
```

**orchestration 行**只在本次任务真的有 worker 花钱时出现——每个 worker 的
`usage.cost.total` 记入一个有界账本（最近 20 条）并累加到任务总额，委派成本
不会被埋在主 agent 的数字里。

基线问的是：*如果每一轮都跑在你配置的 Smart 档模型（priority 1）上——也就是没装路由器——这个会话要花多少？* 差值就是你的节省。若定价缺失（纯本地会话，`models-store.json` 没有定价），显示 `baseline: unavailable`，不编数字。

### 其它 pi 路由器

|  | pi-shift-router（本插件） | [@tenchi4u/pi-bifrost](https://pi.dev/packages/@tenchi4u/pi-bifrost?name=router&type=extension) | [pi-smart-router](https://pi.dev/packages/pi-smart-router?name=router&type=extension) |
|---|---|---|---|
| **怎么判** | 一段你能读的 LLM 提示词（`src/prompts/judge.md`），或决策模型 | 7 步规则 + 历史启发式 | 12 步本地流水线，不用 LLM |
| **档位** | 2 档（`fast` / `smart`） | 4 档（`quick` / `general` / `writing` / `frontier`） | 3 档，含 LM Studio / Ollama 本地档 |
| **复杂任务** | Smart 档编排：规划、派发给 Fast worker、审核 | 只做单轮路由 | 在强模型上做一次辅助调用 |
| **花费** | 每会话相对"全部走 smart"的实测节省金额 | 省的是订阅额度，不是钱 | 用公式估算，不是你的账单 |
| **Provider 故障** | 同档 fallback + 冷却（1m → 6h），与判定器共享 | 熔断，可能换档 | 熔断，仅在档内回退 |
| **Prompt 缓存** | 抬高降级门槛，缓存热时不动 | 维护自己的缓存 | 也保护缓存，算法不同 |
| **体积** | 0 依赖，约 409 KB | 0 依赖，2.5 MB | 需要本地 DB 与模型，2.5 MB 起外加下载 |

三者都是真实选择，区别在于你的消息和模型之间隔了多少机制。

---

## 常见问题

### 判定会不会拖慢每轮、多花钱？

一次判定约几千 token，按 Fast 档（最便宜）模型计价，端到端通常 200ms–2s；相比“该升级没升级”的隐性成本，这点开销通常可以忽略。

### 能跨 Provider 混用吗？

可以。每档是一个有序的 `{provider, model, priority}` 列表，任意组合。

### 会不会过早从 Smart 降级？

降级需要**连续 2 轮决定性 fast 判定**（`economics.downgradeMemory`，默认 2）+ cache-aware 空闲门——一轮例行任务降不下来；无信号 hold（置信度 < `minConfidence`）或任何 smart 判定都会重置连击。想更粘/更省调 `economics.reworkPenalty`（默认 3，θ≈0.33）：调高到 5 更省，调低到 2 更粘。升级在决定性 smart 判定时永远立即。

### 怎么配置 Jev？

三步：

1. **拿一个 Jev API Key。** Jev 处于早期访问，在 [TypeSafe 控制台](https://console.typesafe.ai/settings/keys) 申请。Key 的放法与其它 Provider 凭据一致：放进 `~/.pi/agent/auth.json`，或在 shell 里 export `TYPESAFE_API_KEY`。
2. **在 `~/.pi/agent/models.json` 里注册 Provider**——这是插件识别 Jev 的依据：
   ```jsonc
   { "providers": { "typesafe": {
       "baseUrl": "https://api.typesafe.ai",
       "api": "typesafe-decisions",     // 本插件识别的决策端点标记
       "apiKey": "$TYPESAFE_API_KEY",
       "models": [ { "id": "jev-latest", "name": "Jev", "input": ["text"],
                     "contextWindow": 64000,
                     "cost": { "input": 0.042, "output": 0 } } ] } } }
   ```
3. **在向导里选 Jev。** 重启 pi，然后 `/router config` → `🧭 Judge` → `🧮 Jev — decision model (Beta)` → `typesafe/jev-latest`。向导只在本地校验（不发网络请求），并把 `judgeTimeout` 抬到 15 秒——默认 5 秒会把大多数决策调用掐断。

### 能让 pi 直接帮我配吗？

可以。pi-shift-router 把 Jev 需要的所有信息都内化了，你把任务交给 pi，它会自己改 `models.json`、检查 Key 并重启。直接发给 pi：

> 帮我在 pi 里接入 TypeSafe Jev，让 pi-shift-router 用它当判定器。我已经把 `TYPESAFE_API_KEY` 导出了。改完 `~/.pi/agent/models.json` 后重启一次，然后打开 `/router config` → `🧭 Judge`，确认 `🧮 Jev — decision model (Beta)` 能选；任何问题都告诉我。

或者英文：

> Add a TypeSafe Jev model to my pi config so pi-shift-router can use it as the judge. I already have `TYPESAFE_API_KEY` exported. After you edit `~/.pi/agent/models.json`, restart the agent and open `/router config` → `🧭 Judge` to confirm `🧮 Jev — decision model (Beta)` is selectable. Tell me what went wrong if anything.

### Judge 菜单里看不到 Jev，怎么排查？

向导只列出支持决策协议的 Provider。按顺序检查三件事：

- `~/.pi/agent/models.json` 里的 provider 条目带 `api: "typesafe-decisions"`（不是 `openai-completions` 或别的）。这是路由器认的标记。
- `models` 数组里至少有一个 Jev 模型 id（`jev-latest`、`jev-1.13.0`、`jev-preview`）。
- `TYPESAFE_API_KEY` 能取到——`echo "$TYPESAFE_API_KEY"` 不应为空。

三件事都对，重启后再开 `/router config`，Jev 那行就会出现并标注 Beta。

### 这和 OpenRouter 的 Auto Router 有什么区别？

Auto Router 从**整个市场**里挑，优化目标是质量——它自己的文档写着选到贵模型"是设计如此"。本项目在你定义的两条链之间、在你的 agent 内、按这一轮的**任务形态**做选择。档位由你定，每个判定都能在 `/router status` 看到，失败模式（429/402 failover、冷却）也由你配置。两者可以叠加：把某一档指向 OpenRouter 上的模型就行。

### 判定选错档怎么办？

升级立即生效；降级要连续两轮 `fast` 才触发；置信度低于 `window.minConfidence` 的判定会被直接忽略，而不是照做。判定器本身失败时，路由器保持当前档位而不猜；而如果判定器的**配置**变得不可用（模型下架、Key 被删），它会回退到 LLM 判定并明确告知。`/router status` 会显示最近的判定窗口，你可以据此判断阈值和你的工作是否匹配。

### 只有一个 Provider 也有用吗？

有。同一个 Provider 内的两条链就已经划算——每个家族内部的价格跨度是 4–50×，而 cache-aware 路由保证同 Provider 切档不会为重复上下文付全价。多个 Provider 则额外带来 failover：某个返回 429 或"余额不足"时，链上的下一个接手这一轮。

### 能临时停用而不卸载吗？

`/router off` 停用、`/router on` 恢复；开关写入配置文件。

### 什么会触发编排？

只有复杂任务被判 `smart` 且编排处于 `auto` 模式（默认）时才触发。简单任务（`fast`）永不编排，走普通路由。见[任务级编排](#任务级编排v100)。

### 编排会更贵吗？

Smart 档负责规划与审核，Fast 档负责实现——worker 用 `fresh` 上下文，每个都很小很便宜（窄任务约 $0.004，继承 176k token fork 约 $0.06）。判定仍是原来的单次分类调用。若任务实际很简单，编排机制根本不启动。

### 怎么知道一轮是否编排了？

`/router verbose` 在注入编排指令时会打印 `🪄 orchestrating`。`/router status` 显示 `Orchestration: 🪄 auto (idle)`（空闲）、`(active)`（编排运行中）、或 `✗ (off)`（已关闭）。

---

## 参考手册

- [配置参考 & 调参指南](docs/CONFIG.zh-CN.md) —— JSON schema、字段默认值、`/router status` 解读、阈值怎么调
- [模型选型目录](docs/MODELS.zh-CN.md) —— 编程套餐、本地量化、同 Provider 阶梯、跨 Provider 拼装
- [故障排查](docs/TROUBLESHOOTING.zh-CN.md) —— 判定解析失败、模型找不到、反复降级等问题
- [路线图](ROADMAP.md) · [贡献指南](CONTRIBUTING.md)

---

## 关联项目

- **[dsh-shift-router](https://github.com/green-dalii/dsh-shift-router)** —— 姊妹项目：同样的双层路由架构（LLM Judge、多模型 fallback chain、指数退避 failover、任务级编排）移植到 **DeepSeek Harness** 而不是 pi-coding-agent。使用 `dsh plugin` 安装，通过 `cordis.patch.yml` profile 层挂载。同作者作品。
- **[obsidian-llm-wiki](https://github.com/green-dalii/obsidian-llm-wiki)** —— 一款 Obsidian 插件，把笔记变成可关联、可查询的知识库：Karpathy LLM Wiki 理念，直接内建在你写笔记的编辑器里。图检索无需 embedding、界面支持十种语言、适配各类 LLM provider。本地优先、无后端服务、GDPR-friendly。同作者作品。

---

## 致谢

- [pi-coding-agent](https://github.com/earendil-works/pi) by earendil-works —— host agent
- [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) —— TUI 组件
- **同类路由对比见上** —— [@tenchi4u/pi-bifrost](https://github.com/the-matt-moo/pi-bifrost) 与 [pi-smart-router](https://github.com/beettlle/pi-smart-router)，同题不同解，见上文「对比其它方案」。

**作者 & 许可** —— pi-shift-router 由 [green-dalii](https://github.com/green-dalii) 开发并维护，[MIT](LICENSE) © 2026。
