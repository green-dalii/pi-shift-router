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
- `ux.quietMode`、`ux.routerLogVerbose`

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
    └── routerLogVerbose       调试日志；默认 false
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
    - { provider: deepseek,   model: deepseek-v4-flash, priority: 1 }
    - { provider: z.ai,       model: glm-5.2,           priority: 2 }
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
| `ux.quietMode` / `statusBar` / `inlineToast` / `routerLogVerbose` | 各自 | 界面 / 日志开关。 |
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

**`routing.judgeTimeout`** (ms) — Judge API 调用超时。默认 `5000`。慢 Provider 提高；不稳定网络降低。

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

**`ux.routerLogVerbose`** — 设为 `true`（或 `/router verbose`）在控制台看决策日志。校准 threshold 时很有用。

## 读 /router status

> **原生模型切换仅同步显示（方案 A）。** pi 自带的 `/model` 或 `Ctrl+P`
> 切换器只更新状态栏——路由器保留每轮模型决定权，所以原生切换在下一轮就
> 可能被重新路由。需要锁定一轮用 `/route-force`；需要完全手动控制请
> `/router off`。（v1.2.0+，已作为明确契约记录。）

```text
pi-shift-router — Mode: AUTO ✅
Current: [🦾 deepseek-v4-flash]

Tiers:
  🦾 Fast — MiniMax-M3, meta/muse-spark-1.2-contributor, deepseek-v4-flash, ...
  🧠 Smart — deepseek-v4-flash, meta/muse-spark-1.2-contributor

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
