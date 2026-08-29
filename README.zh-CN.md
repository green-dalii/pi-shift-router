<!--
SEO 元数据（用户不可见，供爬虫 / LLM 解析）：
- name: pi-shift-router
- type: software / npm 包 / pi-coding-agent 扩展 / 模型路由器 / LLM 分类器
- license: MIT
- language: TypeScript
- runtime: Node.js >= 24
- dependencies: 零第三方运行时依赖（宿主导入 @earendil-works/pi-tui，声明为依赖以便隔离子树安装）
- npm: https://www.npmjs.com/package/pi-shift-router
- repo: https://github.com/green-dalii/pi-shift-router
- canonical: https://github.com/green-dalii/pi-shift-router/blob/main/README.zh-CN.md
- docs: README.md / README.zh-CN.md / docs/CONFIG.zh-CN.md / docs/MODELS.zh-CN.md / docs/TROUBLESHOOTING.zh-CN.md
- first-published: v0.4.0
- latest: v1.3.1
- last-updated: 2026-08
- alternate-names: shift router, pi extension, model router, two-tier router, auto router, tier model router, model failover router
- search-intents: "自动路由 pi agent 每轮", "LLM 作为分类器", "两层模型路由", "遇 429 模型的自动 failover", "成本与质量模型选择", "pi-coding-agent 扩展", "模型冷却指数退避", "JSON-mode 分类器", "pi-shift-router vs pi-bifrost", "pi-shift-router vs pi-smart-router", "pi 自动切换便宜模型", "任务级编排 pi", "Smart CTO 派发 Fast 子代理", "pi agent 子代理编排"
- features: 两层路由、LLM Judge、JSON-mode 分类器、滑动窗口降级门、多模型 fallback 链、TUI 配置向导、指数退避运行时 failover（429/5xx）、路由与 Judge 共享冷却、cache-aware 路由（同 Provider 缓存保护）、跨 Provider、零配置起步、token 吞吐遥测、任务级编排（默认开启：Smart 档作为 CTO 派发给 Fast 子代理；需安装 pi-subagents）
- direct-competitor: "@tenchi4u/pi-bifrost（7 阶段启发式 + 订阅配额）· pi-smart-router（12 阶段本地管线 + HyDRA + Virtual Cost v2）"
- author: green-dalii（https://github.com/green-dalii）
-->

![pi-shift-router 首图 —— 例行的轮次留在便宜档；判定时刻把重要的工作升级到强档，由它规划并派发给 Fast 工程师](assets/hero.jpeg)

# pi-shift-router

> 重要的事它是CTO，跑量的活它是工程师。

[![npm](https://img.shields.io/npm/v/pi-shift-router.svg)](https://www.npmjs.com/package/pi-shift-router)
[![Downloads](https://img.shields.io/npm/dm/pi-shift-router.svg)](https://www.npmjs.com/package/pi-shift-router)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Agent](https://img.shields.io/badge/pi--agent-extension-purple)](https://pi.dev/packages/pi-shift-router)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-green)](https://nodejs.org)
[![deps](https://img.shields.io/badge/deps-host--pi--tui--only-blue)](package.json)
[![size](https://img.shields.io/badge/install%20size-~409kB-blue)](https://packagephobia.com/package/pi-shift-router)
[![CI](https://img.shields.io/github/actions/workflow/status/green-dalii/pi-shift-router/ci.yml)](https://github.com/green-dalii/pi-shift-router/actions)
[![Stars](https://img.shields.io/github/stars/green-dalii/pi-shift-router.svg)](https://github.com/green-dalii/pi-shift-router)

[English](README.md) | [简体中文]

[🌐 项目官网](https://shiftrouter.greenerai.top) | [⚙️ 工作原理](#工作原理) | [🚀 快速开始](#快速开始) | [⚖️ 和同类路由器的区别](#和同类路由器的区别) | [❓ 常见问题](#常见问题) | [🔧 配置参考](docs/CONFIG.zh-CN.md) | [🩺 故障排查](docs/TROUBLESHOOTING.zh-CN.md)

例行的活儿不该花旗舰模型的钱，重要的事也不该拿便宜模型凑合。

pi-shift-router 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的任务级路由器：每轮开始前，一个小型 LLM 判定把消息分到你配置的两个档位之一。被选中的模型接管整轮——思考、工具调用、改代码，全在它的水平上完成；判定只分类，不干活。

复杂任务时，路由器从*单轮路由*升级为*任务级编排*：Smart 档像 CTO 一样规划、把实现派发给 Fast 子代理、逐项审核并迭代——判定给出 `smart` 时，路由到的是正确的*执行形态*，而不只是一个模型。编排**默认开启**（`auto` 模式）：简单任务始终走普通路由，只有复杂任务才编排。运行 `/router orchestrate off` 可完全关闭。

> **编排前置依赖：** 高级编排（Smart 档作为 CTO 派发给 Fast 子代理）需要安装 [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 扩展（`pi install npm:pi-subagents`）。未安装时路由器照常工作——只有基础两档路由；复杂任务直接在 Smart 档上运行，不做派发。

```text
🦾 [deepseek-v4-flash] → 修一下这个失败的测试
🧭 judging…
🧠 [claude-opus-5]              ← “设计认证流程”→ 立即升级
⚠️ deepseek-v4-flash 429 → switching to glm-5.2 — retry in 1m
🦾 [glm-5.2]                    ← 同档 failover
```

- **升级立即**，降级要连续 2 轮 fast——不会来回抖。
- 每档可配多模型链，429/5xx 指数退避冷却，任务不中断。
- 零第三方运行时依赖、一个配置文件——配好模型之前是 no-op，之后路由开箱即用（复杂任务自动编排）。

```bash
pi install npm:pi-shift-router   # 然后：/router config → /router status
```

---

## 工作原理

每轮开始前只做一次便宜调用：Fast 档模型（通常是你最便宜的）读你的消息，判为 `fast`（例行）或 `smart`（重要），并给出**置信度**（0–1，多确信）。判定之后，选中的档位整轮干活。

**先从「错的方向不对称」说起——后面所有规则都从这一点长出来。** 每次切换都有两种错法，代价完全不同：

- **简单任务升了档**（routine 活花 smart 的钱）：多付一次差价——小、有界、看得见。
- **复杂任务留在便宜档**：它搞砸，你整轮重来，最后还得花 smart 的钱——外加你的时间。通常比第一种贵好几倍。

一个分不清「简单 / 复杂」的经理，不该在 50/50 处下注。**当任务可能是难的，便宜档才是那个冒险的选择**——所以路由器的闸向「花钱」一侧倾斜：

> **如果这一轮需要 smart 的概率 ≥ θ，就跑 smart；否则跑 fast。** 默认 **θ ≈ 0.33**。

**置信度就是那个概率。** Judge 判 `smart`、置信度 `c` → 概率 `c`；判 `fast`、置信度 `c` → 概率 `1 − c`（**越确信 fast，越说明几乎肯定是简单活**）。看表：

| Judge 判定 | 置信度 | 需要 smart 的概率 | vs θ | 结果 |
|---|---|---|---|---|
| `smart` | 0.9 | 0.9 | ≥ | 🧠 smart |
| `smart` | 0.2 | 0.2 | < | 🦾 fast —— 弱判定被驳回 |
| `fast` | 0.9 | 0.1 | < | 🦾 fast |
| `fast` | 0.6 | 0.4 | ≥ | 🧠 smart —— 拿不准是不是简单活 |
| 任意 | < 0.5 | （无信号） | —— | hold —— 停在当前档位，不猜 |

**0.33 从哪来——保险的数学。** 把差价想成「避免搞砸」的保费：

| 策略 | 期望成本 | 为什么 |
|---|---|---|
| 跑 smart | `f + Δ` | 先付保费，没有搞砸风险 |
| 跑 fast | `f + P·Δ·R` | 省下保费；但任务其实需要 smart（概率 `P`）时，搞砸要付 `R×` 差价 |

`f` = fast 档成本，`Δ` = smart − fast（保费），`R` = `reworkPenalty`，`P` = 需要 smart 的概率。只要平均来看跑 smart 更便宜就升级：

```
f + P·Δ·R > f + Δ   ⟺   P > 1/R
```

差价被约掉了：**规则不关心你选的模型贵不贵，只关心「搞砸的代价相对差价有多大」**。默认 `R = 3` → θ ≈ 0.33：有三分之一概率需要 smart，就值得升级。**R 越大闸越低**：`R = 5` → θ = 0.2（更积极——`/router sport`），`R = 2` → θ = 0.5（更保守——`/router eco`）。

**两道护栏防止来回抖：**

- **升级立即**：pSmart ≥ θ 就升。**降级要连续 2 轮** pSmart < θ——一句「谢谢」永远降不下来。
- **缓存门**。Prompt 缓存属于单个模型——中途换档，新模型要以全价重读整个对话。当 Fast 与 Smart 同属一个 Provider 时，路由器把 θ 再除一档（更少降级），并在缓存还热时拒绝降级。升级永不受影响；跨 Provider 配置不共享缓存，行为不变。

判定调用对输出格式很严格，小模型也能稳定解析：OpenAI 兼容端点用 `response_format: json_object`（非 JSON 直接被打回），Anthropic 用 `{` 前缀预填强制 JSON 开头。判定期间状态栏显示 `🧭 judging…`。判定失败时停在当前档位，不猜。

### 当 Provider 挂掉时

429 / 5xx / 配额 / Token 套餐耗尽？pi 先重试（Provider ×3 + Agent ×3），仍失败就轮到路由器：

1. 失败模型进入指数退避冷却——5xx 从 1m 起步（1m → 4m → 16m → 1h → 4h … 封顶 6h）；可触发 failover 的 4xx（429 限流 / 配额）跳过前两档、直接从 16m 起步，因为客户端侧限流窗口通常比服务器瞬时故障长得多。
2. 立即 `setModel` 到同一档的下一个健康模型（绝不跨档）。
3. pi 待定的重试直接打到备用模型上——同轮完成接管。
4. 后续轮次自动跳过冷却中的模型；2xx 响应立即解除冷却，会话重启全部重置。

Judge 与路由共用同一张冷却表（判定失败也会走完整条 fast 链才放弃）；手动 `/route-force` 永远绕过冷却；认证/配置错误（400/401）不触发 failover。

---

## 任务级编排（v1.0.0）

单轮路由决定*哪台模型*跑这一轮；任务级编排决定*复杂任务怎么执行*。当判定说 `smart` 且编排处于 `auto` 模式（默认）时，路由器把这一轮交给 Smart 档当 **CTO**：它规划工作、把实现派发给 Fast 工程师子代理、逐项审核并迭代，直到工作干净——最后做一次最终验收。简单任务（`fast` 判定）永不触发编排，照旧走普通路由，逐字节不变。

### 一个编排轮次怎么跑

1. **进入。** 判定说 `smart` → 路由器把主模型切到 Smart 档并注入一条编排指令（你的角色、派发规则、硬上限）。状态栏全程显示实时遥测：CTO 规划期为 `[🧠 deepseek] • 42 tok/s`（🪄 只在 worker 真正派发后才出现），Fast worker 跑起来后为 `🪄 Done(2)/Total(3) • ~30 tok/s avg`。
2. **规划。** Smart 把任务拆成多个阶段，每个阶段带验收标准。
3. **派发。** 每个阶段通过 `subagent` 工具拉起一个 Fast 子代理——`agent: "worker"`、`context: "fresh"`、模型钉在你** Fast 档**——配一份自包含的任务契约（目标、约束、验收标准、要动的文件）。
4. **审核。** Smart 按验收标准读每个 worker 的结果。失败阶段带着具体反馈回到 worker——或连续失败 N 次后由 Smart 亲自接管。
5. **验收。** 以一段简短的 CTO 总结 + 最终验收收尾。

### 为什么用 fresh 上下文 worker

worker 以 `context: "fresh"` 运行——不继承会话历史。任务字符串*就是它的全部世界*，所以必须是一份精确契约：目标、约束、验收标准、范围外。这让每个 worker 的上下文都很小（快、便宜、专注——实测窄任务约 $0.004，继承 176k token fork 约 $0.06），也是让 anthropic 兼容端点保持思考开启的已验证方式（fork 模式会被强制 `thinking: off`）。

### 硬上限（路由器负责的部分）

插件强制执行两个数字，与 Smart 想做什么无关：
- **`orchestration.maxRounds`**（默认 3）——每个任务最多 delegate→review 轮数。
- **`orchestration.escalationThreshold`**（默认 2）——某阶段 worker 连续失败 N 次，Smart 亲自接管该阶段。

循环在 Smart 说完成、或命中上限时停止——两者任一即停。

### 验收审计（托底 review，v1.3.0；v1.4.0 起限定委派域）

因为验收是 Smart 档自己的判断，插件在每个**实际委派过 worker（`spawned ≥ 1`）**的编排轮次结束时（`agent_end`）再加一道**硬兜底审计**。自执行轮（`spawned = 0`——CTO 判断它简单到可以自己做）**完全豁免审计**：零 violation、零警告，仅在 `/router status` 标记 `(self-executed)`。CTO-summary 输出契约只在真正派发过 worker 时才生效。

1. **确定性检查（零成本）：** 所有 worker 都已回包（`done == spawned`）、最后一条消息带 **CTO 总结**（输出契约标记）、以及是否命中硬上限。
2. **LLM 审计（默认开启，Fast 档一次小调用）：** 审计 prompt 读取**原始用户目标**（进编排时快照）、CTO 总结与 worker 结果，从三个维度核验：
   - **有据（Grounding）** —— 验收主张有实际结果支撑（没看结果就说 done、忽略 worker 失败、前后矛盾）。
   - **目标对齐（Goal alignment）** —— 交付物确实回应了用户请求（无范围漂移、核心诉求有答）。
   - **交付质量（Delivered quality）** —— worker 输出完整，不是占位/TODO 充数，无空结果、无“没做完”。

审计从不阻断已完成轮次——它只**标记**：`console.warn` + toast，且 `/router status` 的 `Last audit` 显示最近一次编排运行的结果。用 `orchestration.audit.enabled`（默认 `true`）开关。审计是 CTO 自审下方的安全网：循环硬性终止，验收主张被核验而非被信任。

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

给 Fast 档、Smart 档各选一个模型；每档多个也行，按优先级组成 fallback 链。保存到用户级或项目级作用域——两边都设时项目级优先。

向导里还有 **🛡️ Cache-aware routing**——当 Fast 与 Smart 同属一个 Provider（如都是 Anthropic）时默认开启。它保护 prompt 缓存：有效 smart 闸 θ 除以 `sameFamilyPenalty`（更少降级），且缓存还热时抑制中途降级，让“路由到更便宜的模型”永远不会比不路由更贵。可在向导里开关，或改配置文件 `routing.cacheAware.enabled`。

**3. 验证**

```text
/router status
```

能看到当前档位、作用域、经济参数（R / θ）、降级连击要求和吞吐数据就对了。下一轮发消息触发首次判定。

---

## 命令

| 命令 | 作用 |
|------|------|
| `/router status` | 查看当前档位、模型、窗口、配置摘要 |
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
Spend: fast $0.045 (9 calls) · smart $0.42 (3 calls) · total $0.465
  baseline: all-turns-on-smart (opencode-go/deepseek-v4-flash) → $3.21 · saved $2.74
```

基线问的是：*如果每一轮都跑在你配置的 Smart 档模型（priority 1）上——也就是没装路由器——这个会话要花多少？* 差值就是你的节省。若定价缺失（纯本地会话，`models-store.json` 没有定价），显示 `baseline: unavailable`，不编数字。

---

## 和同类路由器的区别

|  | 🦾 **pi-shift-router**（本插件） | [@tenchi4u/pi-bifrost](https://pi.dev/packages/@tenchi4u/pi-bifrost?name=router&type=extension) | [pi-smart-router](https://pi.dev/packages/pi-smart-router?name=router&type=extension) |
|---|---|---|---|
| **怎么定的** | ✅ **一个 LLM 说了算，写在明处**——重要的就升级，例行的就留下 | 7 步规则 + 历史技巧——情况越多，越难理清 | 12 步本地流水线（不用 LLM）——最复杂，也最重 |
| **档位** | ✅ **就两档 `fast` / `smart`** · 一个心智模型，一晚上读完 | 4 档（`quick` / `general` / `writing` / `frontier`）——档越多，学越多 | 3 档还带本地档（LM Studio / Ollama）——多数时候用不上 |
| **难任务怎么干** | ✅ **Smart 当 CTO**——定计划、拆给 Fast 去做、逐项验收、来回迭代 | 每次只选一个模型自己干——不编排 | 顺手叫一次强模型帮看——不算团队作战 |
| **省钱** | ✅ **给你算真省了多少**——每轮都计账，对比“全走 smart 会花多少”（`/router status`） | 省的是订阅配额，不是钱 | 用公式估成本（论文级，非账单） |
| **挂了怎么办** | ✅ **接着干**——同档自动换人 + 越挂越久的冷却（1m→6h），判定也共享 | 阈值熔断，可能跨档换 | 熔断 + 档内回退 |
| **缓存** | ✅ **护住你的 prompt 缓存**——更便宜永不更贵 | 维护自己的缓存 | 也护缓存，算法不同 |
| **上手** | ✅ **约 9 条命令 + 一个可视化编辑器**——5 分钟可上线 | 4 份配置要合并 | 15+ 环境变量——更陡峭 |
| **轻重** | ✅ **0 依赖 / ~409 KB** | 0 依赖 / 2.5 MB | 要本地数据库 + 机器学习模型 / ~2.5 MB + 额外下载 |
| **适合谁** | ✅ **要清晰的路由、真实的省钱、开箱的编排，就从这里开始** | 要规则密集 + 配额技巧 | 要本地优先 + 研究向遥测 |

> **我们直说：** 为**简单、可审计、轻量**而生——一个 prompt 定夺、一个守卫护住缓存、复杂活直接**编排**。另外两家也都很强，只是旋钮更多；旋钮越多，越难一眼看懂。想少点旋钮、账单更清楚，从这里开始。

---

## 常见问题

### 判定会不会拖慢每轮、多花钱？

一次判定约几千 token，按 Fast 档（最便宜）模型计价，端到端通常 200ms–2s；相比“该升级没升级”的隐性成本，这点开销通常可以忽略。

### 能跨 Provider 混用吗？

可以。每档是一个有序的 `{provider, model, priority}` 列表，任意组合。

### 会不会过早从 Smart 降级？

降级需要**连续 2 轮决定性 fast 判定**（`economics.downgradeMemory`，默认 2）+ cache-aware 空闲门——一轮例行任务降不下来；无信号 hold（置信度 < `minConfidence`）或任何 smart 判定都会重置连击。想更粘/更省调 `economics.reworkPenalty`（默认 3，θ≈0.33）：调高到 5 更省，调低到 2 更粘。升级在决定性 smart 判定时永远立即。

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
- **同类路由对比见上** —— [@tenchi4u/pi-bifrost](https://github.com/the-matt-moo/pi-bifrost) 与 [pi-smart-router](https://github.com/beettlle/pi-smart-router)，同题不同解，见[和同类路由器的区别](#和同类路由器的区别)。

**作者 & 许可** —— pi-shift-router 由 [green-dalii](https://github.com/green-dalii) 开发并维护，[MIT](LICENSE) © 2026。
