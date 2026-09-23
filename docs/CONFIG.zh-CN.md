# 配置参考 & 调参指南

> 推荐用 TUI 向导（`/router config`）配置，正常情况下不需要手写 JSON。本页供脚本化、跨机共享配置、固定到项目仓库时查阅。

## 配置文件的两种作用域

```text
~/.pi/agent/pi-shift-router.json         （用户级 —— 默认生效）
<cwd>/.pi/pi-shift-router.json           （项目级 —— 同名字段覆盖用户级）
```

## TUI 可配项（/router config）

- 总开关（`/router on` / `/router off`）
- 每档模型 chain —— 添加 / 删除 / 重排（`a`、`x`、`J`/`K`、`d` 保存、`Esc` 取消）
- 保存作用域：用户级或项目级

## 只能手改 JSON 的项（高级，不在 TUI 里）

- `routing.judgeTimeout`、`routing.window.minConfidence`、`routing.economics.reworkPenalty`
- `routing.judge.mode` / `routing.judge.models`（Judge 专用链或决策模型，见下）
- `ux.quietMode`、`ux.routerLogVerbose`（verbose 日志写入 `~/.pi/agent/logs/shift-router.log`）

手改后重跑一次 `/router config` 重新加载，或重启 pi。

## JSON Schema

配置分两层：TUI 向导自动写“常规项”，高级项需手写。结构如下：

```text
pi-shift-router.json
├── enabled                    boolean  总开关；默认 true
├── tiers
│   ├── fast
│   │   └── models[]           按优先级排序；首个为 primary，其余为 fallback
│   │       ├── provider       string   必须与 pi-agent 的 auth.json 中某个 Provider 对应
│   │       ├── model          string   该 Provider 下的模型 ID
│   │       └── priority       integer  1 = primary，2 = 第一个 fallback，…
│   └── smart                  与 fast 同形
├── routing
│   ├── mode                   "auto" | "manual"；默认 "auto"
│   ├── judgeTimeout           ms；默认 5000
│   ├── window
│   │   ├── size               滑动窗口长度；默认 5
│   │   ├── threshold          旧版 θ 覆盖（仅 ≠0.6 生效；0.6=旧默认值已死）
│   │   └── minConfidence      低于该置信度的投票被忽略；默认 0.5
│   └── cacheAware
│       ├── enabled            提高降级阈值 + 保护热缓存；默认 true（仅同家族生效）
│       ├── sameFamilyThreshold  旧版旋钮（仅 ≠0.9 蕴含强惩罚 3.0；0.9=旧默认值已死）
│       └── idleBoundaryMs     视为“缓存已过期”的空闲间隔；默认 300000（5 分钟）
└── ux
    ├── quietMode              关闭 inline toast；默认 false
    ├── statusBar              显示 🦾 / 🧠 徽章；默认 true
    ├── inlineToast            模型切换提示；默认 true
    └── routerLogVerbose       调试日志写入 ~/.pi/agent/logs/shift-router.log；默认 false
├── orchestration            （SPEC §9.3，v1.0.0；全部可选）
    ├── mode                   "auto" | "off"；默认 auto（/router orchestrate off 关闭）
    ├── maxRounds              每任务 delegate→review 轮数上限；默认 3
    ├── escalationThreshold    worker 失败 ≥N 次 → Smart 接管该阶段；默认 2
    └── requireSmartModel      Smart 模型不可用时跳过编排；默认 true
```

**最小配置**（每档一个模型，其余全默认）：

```text
enabled:  true
tiers:
  fast:   [{ provider: openai, model: gpt-5.6-luna }]
  smart:  [{ provider: openai, model: gpt-5.6-sol }]
```

**多 Provider + 每档 fallback chain**（典型生产配置）：

```text
enabled:  true
tiers:
  fast:
    - { provider: deepseek,   model: deepseek-v4.1-flash, priority: 1 }
    - { provider: z.ai,       model: glm-5.3-flash,           priority: 2 }
    - { provider: xai,        model: grok-4.5-fast,     priority: 3 }
  smart:
    - { provider: anthropic,  model: claude-opus-5,     priority: 1 }
    - { provider: openai,     model: gpt-5.6-sol,       priority: 2 }
    - { provider: moonshotai, model: kimi-k3,           priority: 3 }
```

### 逐字段默认值

| 字段 | 默认 | 含义 |
|------|------|------|
| `enabled` | `true` | 总开关。`/router off` 停用。 |
| `tiers.<tier>.models[]` | `[]` | 按 `priority` 排序。首个命中；其余项作运行时备用。 |
| `routing.judgeTimeout` | `5000` | ms。Judge 调用超时。 |
| `routing.judge.mode` | `"fast-chain"` | Judge 链来源：`fast-chain`（复用 Fast 档，默认）、`custom`（专用 `routing.judge.models` LLM 链）、`decision`（类型化决策模型，Jev/System One 类）。 |
| `routing.judge.models` | `[]` | `custom` / `decision` 使用的模型链（按优先级，结构与档位链相同）。`fast-chain` 下忽略。 |
| `routing.window.size` | `5` | 判定记忆窗口长度（保留用于降级连胜分析与展示）。 |
| `routing.window.minConfidence` | `0.5` | Judge 置信度低于此 = 无信号（hold：绝不切换，且打断 fast 连胜）。 |
| `routing.window.threshold` | 旧版 | v1.4.0 之前的旧旋钮。**平滑迁移：旧默认值 `0.6` 已死**——配置里带着它（例如向导快照）会静默回落到新规则 `θ = 1/reworkPenalty`，而不是被重解释成保守的 θ=0.6。只有**不等于** `0.6` 的值才作为**原始 θ** 覆盖（并在 `/router status` 中显示）。优先用 `economics.reworkPenalty` / `/router eco|default|sport`。 |
| `routing.economics.mode` | 未设置 | `/router mode` 的命名预设：`eco`（R=2，θ=0.5，更省——只有明确需要 smart 的轮才升级）、`default`（R=3，θ≈0.33）、`sport`（R=5，θ=0.2，更积极——只要有需要 Smart 的苗头就升级）。R 越大 → θ 越低 → 越倾向 Smart（θ = 1/R）。设置后**优先于** `reworkPenalty`；删除它（或改文件）回到手动 R。旧版 `window.threshold`（仅非 0.6 的值）仍然压过两者。 |
| `routing.economics.reworkPenalty` | `3` | 错误降级的代价（以价差计）。θ = 1/R：期望成本智能闸（SPEC §2.3）。设了 `economics.mode` 时被忽略。 |
| `routing.economics.downgradeMemory` | `2` | smart → fast 降级所需的连续 decisive fast 判定次数。 |
| `routing.cacheAware.enabled` | `true` | fast 与 smart 同 Provider 时，把 θ 除以 `sameFamilyPenalty`（更少降级）并在 prompt 缓存仍热时抑制中途切换（SPEC §9.2）。跨家族配置不生效（无共享缓存）。 |
| `routing.cacheAware.sameFamilyPenalty` | `1.5` | 启用 cache-aware 且同家族时的 θ 除数（更少降级 → 缓存存活）。 |
| `routing.cacheAware.sameFamilyThreshold` | 旧版 | v1.4.0 之前的旋钮。**平滑迁移：旧默认值 `0.9` 已死**（向导快照回落到 `sameFamilyPenalty` 1.5）；只有**不等于** `0.9` 的值才蕴含强默认惩罚 3.0，保留显式调过它的旧配置的保守意图。 |
| `routing.cacheAware.idleBoundaryMs` | `300000` | 空闲超过该时长视为 prompt 缓存已过期，恢复允许降级。 |
| `ux.quietMode` / `statusBar` / `inlineToast` / `routerLogVerbose` | 各自 | 界面开关；`routerLogVerbose` 把诊断追加到 `~/.pi/agent/logs/shift-router.log`。 |
| `orchestration.mode` | `"auto"` | 任务级编排模式。`"auto"`（默认）：由 Judge 驱动——简单任务（fast 判定）走普通路由；复杂任务（smart 判定）升级为 Smart 编排执行（需安装 `pi-subagents` 扩展；未安装时退化为普通 smart 档运行）。`"off"`（`/router orchestrate off`）：永不编排——行为与现有路由完全一致。没有“总是”模式。 |
| `orchestration.maxRounds` | `3` | 每任务 delegate→review 轮数硬上限；达到即停，无论 Smart 想继续多少轮。 |
| `orchestration.escalationThreshold` | `2` | 某阶段 worker 失败 ≥N 次 → Smart 亲自接管该阶段。 |
| `orchestration.requireSmartModel` | `true` | 为 true 且 Smart 模型不可解析时跳过编排，按现有 smart 档运行（不崩溃）。 |
| `orchestration.audit.enabled` | `true` | 每个**实际委派过 worker（spawned ≥ 1）**的编排轮结束后运行验收审计（托底 review）。确定性检查（worker 全部返回、CTO summary、cap 标记）始终在委派轮执行；为 true 时再让 Fast 档跑一次 LLM 审计，核验 CTO 的验收主张是否建立在 worker 结果之上。自执行轮（spawned = 0）完全豁免——零 violation、零警告，仅在 `/router status` 标记 `self-executed`。绝不阻断已完成轮次——发现的问题通过 `console.warn` + toast 与 `/router status` → `Last audit` 呈现。 |
| `orchestration.audit.timeoutMs` | `5000` | 审计 LLM 调用超时（尽力而为；失败降级为警告，不崩溃）。 |

## 调参指南

每个参数都有取舍。按你的工作负载选择：

| 你的会话看起来像… | 试试… | 为什么 |
|---|---|---|
| 很多例行任务（CRUD、测试、文档）；架构很少 | `/router eco`（R=2, θ=0.5） | 更省/保守：只有明确需要 smart 的轮才升级 |
| 重架构 / 规划 / 代码审查 | `/router sport`（R=5, θ=0.2） | 更积极/粘 Smart：只要有需要 Smart 的苗头就升级——错误降级比省下的差价贵 |
| 混合 —— 有时连续 20 轮快任务，有时规划 | 默认（`default`，R=3, θ≈0.33） | 平衡：边界判定倾向 smart |
| Judge 倾向过度自信（多数投票 ≥0.9） | `minConfidence: 0.7` | 剔除过度自信投票 |
| Judge 倾向不确定（许多投票 0.3–0.6） | `minConfidence: 0.3` | 不丢弃不确定投票 |
| Primary fast 模型频繁 429 | 在 `tiers.fast.models[1]` 加一个 Provider | 多一个备用，v0.6.0 运行时 failover 自动接管 |
| 重 streaming / 长 agent 运行 | 监控 `/router status` tokens/sec | 查看每轮实际吞吐 |

### 旋钮详解

**`routing.judge`** —— Judge 有三种模式（向导：`/router config` → 🧭 Judge）：

1. `fast-chain`（默认）——复用 Fast 档链，无需额外配置，与旧版本行为一致；链解析为空时回落到"最便宜的已鉴权模型"（旧行为）。
2. `custom` —— 在 `routing.judge.models` 单独配置 Judge LLM 链，编辑方式与档位链完全相同。适合想让分类器比 Fast 档更便宜/更严格的场景。**不**做最便宜模型回落：专用链解析不到端点时**保持原档**，不会跑在你没选过的模型上。
3. `decision` —— 使用**决策模型**（TypeSafe Jev / System One 类）：返回类型化答案 + 校准概率，不生成文本。向导只列出支持该协议的端点，并**在本地校验**选择（auth + baseUrl）——保存时不发任何网络请求。若端点运行时不可用，路由器**逐级降级而不是卡住**：**Jev → 你的 LLM 判定 → 关闭路由**（不切模型、不编排、只提示一次）。决策模式绝不伪造判定。保存时会跑一次**实时探针**（一个 Noul 问题）；探针进行中会显示工作指示器，而重复保存未变更的链会跳过探针——那个端点已经验证过且正在生效。

**模型 id：用 `jev-latest`。** Jev 每次响应都会回传实际解析到的版本（即使请求用的是别名，也返回 `"model": "jev-1.13.0"`），路由器发现版本变化就写日志——所以别名移动是**可见的**，不是静默的。固定版本（`jev-1.13.0`）用这份韧性换取逐位可复现，代价是厂商下架该 build 的那天直接失效。优先用别名，并盯日志。

决策协议（模式 3）：`POST {baseUrl}/v1/systemone`，请求体 `{model, state, questions:{tier:{type:"choice",…}, orchestrate:{type:"noul",…}}}`。路由器读 `tier.choice`，用 `tier.probabilities[tier]` 作置信度，并把 `orchestrate.noul >= 0.5` 作编排信号。决策模式没有 `reason`（模型不生成文本），仪表盘 "Last:" 行只显示档位 + 概率。

**顺序：老默认在前，Jev 作为 Beta 放最后。** 向导顺序是 `🦾 Reuse the Fast tier chain (default)` → `🔬 Dedicated Judge LLM chain` → `🧮 Jev — decision model (Beta)`。Jev 处于公测：独立验证少于 LLM 判定，Provider 算力也仍在爬坡，所以它是**可选**而非推荐默认。配置默认值仍是 `fast-chain`，升级不会把你悄悄换成另一类模型来判定。若专用链 / 决策链解析不到任何端点（模型下架、Key 被删、Provider 消失），路由器会**回退到 LLM 判定并写入日志**，而不是每轮保持原档；向导行也会告诉你实际生效的是谁（`Jev unavailable — LLM judge active`）。单次调用失败仍然保持原档：那是瞬时故障，不是配置腐化。

注意：切到决策模型会改变置信度**分布**；现有阈值（θ、`minConfidence`）是按 LLM 置信度调过的，请拿到实测数据后再重新标定。

**`routing.judgeTimeout`** (ms) — Judge API 调用超时。默认 `5000`。慢 Provider 提高；不稳定网络降低。

**判定器阶梯。** 无论你选哪个模式，路由器都走两级阶梯，绝不猜：

1. **你配置的判定链** —— Jev 决策模型（`decision`）、独立 LLM 链（`custom`）、或 Fast 档链（`fast-chain`）。
2. **你的 LLM 判定** —— Fast 档链（v1.7.0 之前的默认行为）。第一级**解析不到**（模型下架、Key 被删、Provider 消失）**或在调用时失败**（429 / 5xx / 超时 / 冷却中），都会落到这里——是同轮落到，不是下一轮。
3. 若第二级也耗尽：这一轮**停止路由**——不切模型、不编排，并把你**会话开始时用的模型**还给你（手动 `/route-force` 覆盖会被尊重）。每会话提示一次。最差情况就是"像没装这个插件一样"。

**老配置无需迁移。** v1.7.0 之前的配置根本没有 `routing.judge`，默认即 `fast-chain`，行为与之前完全一致。另两种形态也已处理：有 `judge.models` 但没有 `mode` → 迁移为 `custom`（否则合并后的默认值会静默忽略这个列表）；`mode` 拼错或未知 → 降级为 `fast-chain`，绝不让路由崩掉。向导显示的是归一化后的模式，菜单与实际行为永远一致。

**决策模式需要的远远超过默认值。** 对 `api.typesafe.ai` 的实测（2026-09-18）：**1.4–6.6 秒**（中位 ~5 秒），且 payload 缩小 5 倍也不会更快——等待来自 Jev 公测期间的 Provider 侧算力，与 payload 或集成层无关。因此 `/router config` → `🧭 Judge` → `🧮 Decision model` 会在你的值更低时**自动抬到 15000 ms**，并在通知里明确说明。低于 ~15 秒时，大多数决策调用会被超时打断，路由器于是"每轮都默默保持原档"。等公测算力上线后，这个数字应当会下降。

**`routing.window.size`** — 滑动窗口长度。默认 `5`。越大越稳定（反应越慢），越小越敏捷（可能抖动）。

**`routing.economics.reworkPenalty`** (≥1) — 一次错误降级的返工代价（以几个价差计）。**θ = 1 / reworkPenalty** 是期望成本智能闸（SPEC §2.3）：Judge 置信度读作 `pSmart`（smart 判定：`c`；fast 判定：`1−c`），`pSmart ≥ θ` 时跑 smart。因为返工比省下的差价贵，边界判定倾向 smart。**注意方向：R 越大 → θ 越低 → 越倾向 Smart**。
- `5` → θ=0.2（`/router sport`）：积极/粘——大部分边界情况都升级，多在 Smart 停留
- `3` → θ≈0.33（默认 `default`）：平衡
- `2` → θ=0.5（`/router eco`）：保守/省——只有明确需要 smart 的轮才跑 smart

**`routing.window.minConfidence`** (0–1) — 低于此置信度的投票被丢弃。默认 `0.5`。设为 `0` 恢复 v0.6.0 的等权计数；设为 `0.7+` 仅计清晰投票。

**`routing.cacheAware`** — cache-aware 路由（SPEC §9.2）。Prompt 缓存属于单个模型：会话中途换 tier 会丢掉热缓存（缓存读按基础输入价 0.1x–0.5x 计费），所以路由到更便宜模型可能反而更贵。当 `enabled: true` **且** fast 与 smart 共享 Provider 家族（自动检测）时：
- 有效 θ 除以 `sameFamilyPenalty`（默认 1.5）——更少降级，以及
- 距最后一条消息 `idleBoundaryMs`（默认 5 分钟）内抑制降级——缓存仍热；只有空闲超过缓存 TTL 后才恢复降级。
升级（fast → smart）永不受影响。跨家族配置不受影响。开关：`/router config → 🧠 Cache-aware routing`。

**`tiers.<tier>.models[]`** — 按优先级排序。第一项是 primary，后续项是运行时 fallback（v0.6.0）。最便宜的健康模型放第一。

**`ux.routerLogVerbose`** — 设为 `true`（或 `/router verbose`），把每次决策、Judge 调用与每轮诊断追加写入 **`~/.pi/agent/logs/shift-router.log`**（目录不存在时自动创建）。这些诊断**刻意不写控制台**：终端由 pi 独占，任何杂散写入都会打乱 TUI 帧——助手消息会被日志行截断、折行重叠——把诊断写进文件正是为了避免这一点。可用 `PI_SHIFT_ROUTER_LOG` 环境变量改路径。校准 `reworkPenalty` / 齿轮时很有用。

## 读 /router status

> **原生模型切换仅同步显示（方案 A）。** pi 自带的 `/model` 或 `Ctrl+P`
> 切换器只更新状态栏——路由器保留每轮模型决定权，所以原生切换在下一轮就
> 可能被重新路由。需要锁定一轮用 `/route-force`；需要完全手动控制请
> `/router off`。（v1.2.0+，已作为明确契约记录。）

```text
pi-shift-router — Mode: AUTO ✅
Current: [🦾 deepseek-v4.1-flash]

Tiers:
  🦾 Fast — MiniMax-M3, meta/muse-spark-1.2-contributor, deepseek-v4.1-flash, ...
  🧠 Smart — deepseek-v4.1-flash, meta/muse-spark-1.2-contributor

Session:
  Turns: 12   Upgrades: ↑2   Downgrades: ↓1
  Manual override: ✗
  Orchestration: 🪄 auto (idle)
  Last audit: ✓ clean (self-executed)
  Cache-aware: 🎯 same-family (θ ÷ 1.5, warm-cache guarded)
  Economics: 🚗 mode default  R=3 (θ=0.33 → 0.22 eff (same-family ÷1.5))  downgrade streak ≥ 2 fast
  Cooldowns: none

Stats:
  ...

Detail:
  Window: [f, f, s]  (3 entries)
  Counts: S=1 F=2

Config: /…/.pi/pi-shift-router.json
```

- **`Economics`** — 关键行：当前**模式**（`eco` / `default` / `sport` / `custom`）、**R**（返工倍率）、基础 θ `1/R`，以及——Fast 与 Smart 共享 Provider 时——经同家族缓存除数后的**有效 θ**。降级太频繁 → 降低 R（`/router eco` 或更大 R）；太少 → 提高 R（`/router sport`）。仍生效的旧版 `window.threshold`（非默认值）会在此处标记。
- **`Cache-aware`** — 同家族配置把 θ 除以 `sameFamilyPenalty` 并抑制热缓存降级；跨家族显示 `—`。
- **`Last audit`** — 最近一次委派轮的验收审计。`(self-executed)` 表示该轮自执行、被豁免。
- **`Cooldowns`** — 触发 failover 签名后处于指数退避的模型及重试倒计时。
