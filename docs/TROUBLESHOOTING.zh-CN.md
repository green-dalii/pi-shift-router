# 故障排查

## Judge 解析失败

- **推理模型 token 不够** —— DeepSeek Reasoner 等把推理放在 `reasoning_content`、JSON 放在 `content`。默认 `max_tokens: 4000`；极长 prompt 可能不足。`/router verbose` 看原始响应。
- **Provider 不支持 JSON mode** —— 部分自定义 OpenAI 兼容端点忽略 `response_format`。
- **API key 失效** —— 检查 pi-agent 的 `auth.json`。

## "Judge fetch failed for … : TypeError: Cannot read 'slice' of undefined"

v0.8.0 修复（commit `de6073a`+）。根因：`JSON.stringify(undefined)` 返回的是 `undefined`（不是字符串 `"undefined"`）。当 Judge 端点返回 200 但 body 没有 `choices[]`（如某些 Provider 的错误结构），verbose 日志会在 `content.slice(...)` 崩溃。修复方式：`jsonStr()` 包装器对 undefined 返回 `"undefined"`。

如果你在旧版本仍看到，重新安装：`pi remove pi-shift-router && pi install <path-to-this-repo>`（例如在仓库根目录跑 `pi install .`）。

## 向导“找不到模型”

模型列表来自 pi-agent 的 `models-store.json`。新增 provider 后重启 pi-agent 让其重新发现。

## 状态栏一直显示 ⛔

路由器被禁用：`/router on`。若 config 里 `enabled: true` 仍显示 ⛔，看 `/router status` 的 `Config:` 行确认读取的配置路径。

## "Model not found" 警告

配置的 model ID 在 Provider 中不存在。更新 ID 或重跑 `/router config`（向导只会列出真实存在的模型）。

## Provider 返回 402 / "Insufficient Balance"，但路由器不切换

症状：每轮都死在同一个模型上，报错类似
`Error: 402: {"message":"Insufficient Balance", ...}` ——路由器一直
重试已耗尽的账户，而不是链上下一个模型。**v1.4.1 已修复**：检测层
现在识别 HTTP 402 与关键字 `insufficient balance` / `余额不足`
（v1.4.1 之前状态码列表只覆盖 429 + 5xx，余额耗尽错误被静默忽略，
坏模型永远钉死）。

若你还在旧版本上看到这个错误，升级到 **pi-shift-router ≥ 1.4.1**
（`npm install -g pi-shift-router@latest` 或 `pi install npm:pi-shift-router`）。
失败模型会进入 16m 冷却（同 4xx 桶，与 429 相同处理），路由器自动选
同一档的下一个健康模型。

## 总是被降级到 Fast

Judge 误分类（`/router verbose` 查看）或阈值太激进。调高：

```json
"routing": { "window": { "size": 5, "threshold": 0.8, "minConfidence": 0.5 } }
```

---

## 编排一直不触发（看不到 `🪄`）

编排（SPEC §9.3）需要同时满足以下条件：

1. **`/router status` 显示 `Orchestration: 🪄 auto`** —— 若显示 `✗ (off)`，运行 `/router orchestrate auto`（或改配置文件 `orchestration.mode`）。
2. **已安装 pi-subagents** —— 必须有 `subagent` 工具。检查 `~/.pi/agent/settings.json` 里是否有 `npm:pi-subagents`，或 `pi list`。没有它，复杂任务直接在 Smart 档运行（不派发）——这是设计内的降级，不是 bug。
3. **该轮被判为 `smart`** —— 编排只在复杂任务上触发。`fast` 判定意味着普通路由，这是设计。试一个真正复杂的请求（架构设计、多步规划、以审核为交付物），并用 `/router verbose` 看是否出现 `judge: smart`。
4. **Smart 模型可解析** —— Smart 档至少要有一个 pi 能找到的模型（不在冷却、在模型库中注册）。若 `requireSmartModel` 为 true（默认）且模型不可解析，编排被跳过。

用 `/router verbose` 逐步验证：

```
[ShiftRouter] judge: smart (llm) …
[ShiftRouter] 🪄 orchestrating: judge=smart, injecting orchestrator prompt (N chars)
[ShiftRouter] 🪄 orchestration turn ended — exited orchestrator state
```

若看到 `judge: smart` 但没有 `🪄 orchestrating` 行，说明上面某个门没通过——检查 1–4。若看到 `🧭 judging…` 但 judge 返回 `fast`，说明模型判定该任务属例行——这是 Judge 在干活，不是路由 bug。

## 编排轮次没有实际派发

编排指令告诉 Smart 用 `subagent` 工具，但派不派发是 LLM 的判断。如果它自己实现了任务，要么任务比判定时想的简单，要么该模型对派发引导不够上心。这不阻塞：工作还是以 Smart 质量完成了。调试可检查编排 prompt（已注入 system prompt，verbose 模式可见）和轮次末尾的 CTO 总结。
