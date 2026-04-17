# OpenManus LangGraph TS — 改进清单

> 状态化清单。每项标注当前状态，已完成的不再列出。
>
> 已完成并删除的项：S-2 (Bash 命令过滤)、S-4 (随机哨兵)、T-1 (extract_content 拆分)、T-2 (WebSearch 异步阻塞)、T-3 (步骤失败状态)、T-4 (Bedrock 全局状态)、A-4 (Streaming)、S-3 (路径边界 symlink 感知)、S-5 (shell 拼接收敛)、A-1 (Memory token 截断)、A-3 (Prod checkpointer 签名)、A-5 (A2A HITL 恢复)、A-6 (Browser 上下文注入)、PlanningTool 未挂载到 executor、PlanningTool 状态同步检测盲点、planning 代码/注释一致、browserUse tabCount、cleanup Promise.allSettled、crawl4ai 清理接入、reactAgent Proxy 包装。

---

## 一、安全问题

### S-1: PythonExecute 无真正沙箱 `未完成`

**现状** (`tools/codeExecute.ts:29`):
```typescript
const result = execSync(`python3 "${tmpFile}"`, { ... });
```
直接用宿主机 `python3` 执行 LLM 生成的代码，零隔离。用户代码可以 `import os; os.system("rm -rf /")`.

**唯一安全路径是隔离沙箱。** Import 黑名单对 Python 无效（`__import__`、`importlib`、`eval` 均可绕过），Node vm 模块只隔离 JS 不隔离子进程。

**正确方案**:
- 默认走 Docker 沙箱执行 (`config.sandbox.use_sandbox = true`)
- 非沙箱模式应显式标记为 **dev/unsafe mode**，启动时打印警告
- 不应提供"加黑名单就安全"的错觉

**影响模块**: `tools/codeExecute.ts`
**修正时机**: Sandbox 模块稳定后

---

## 二、架构改进

### A-2: Planning 步骤间上下文策略 `需设计`

**现状**: `planning.ts` 每个步骤调用 `createThreadConfig()` 生成新 UUID，步骤间完全隔离。步骤 1 的 `cd /project && npm install` 在步骤 2 中不可见。

**设计取舍** (尚未决定，暂保持隔离):

| 策略 | 优点 | 缺点 |
|------|------|------|
| 每步隔离 (当前) | 干净启动，不被前序干扰 | 步骤间无法引用彼此工作 |
| 共享 thread | 步骤间有上下文连续性 | messages 越来越长，后续步骤被干扰 |
| 按 executor type 共享 | 同类 agent 步骤间共享（如所有 swe 步骤共享） | 不同类型间仍然隔离 |

**修正时机**: 优化 Planning Flow 时决定策略

---

## 三、工具实现改进

### PlanningTool 全局状态隔离 `未完成`

**现状**: `planStorage` 是进程级 singleton，Planning Flow 使用固定 `active_plan` 作为 planId，并且 tool 本身还有 `activePlanId`。

**问题**: 多个用户、多个 planning flow、A2A 多 context 并发时会互相覆盖 active plan。即使单进程内串行运行，也可能出现上一次任务的 plan 泄漏到下一次任务。

**改进方案**:
- planId 使用稳定命名空间：`thread_id` / `contextId` / `runId`
- PlanningTool 调用必须显式传 plan_id，尽量避免全局 active plan
- 长期方案：把 plan 存在 LangGraph state 或 Store 中，而不是进程级 singleton

**影响模块**: `tools/planningTool.ts`, `graphs/planning.ts`, `a2a/server.ts`

### BrowserUse 稳定性测试缺口 `未完成`

**现状**: `browserUse.ts` 依赖 `browser-use` 的 DOM indexing 和 Playwright 页面对象，但缺少最小端到端 smoke test。

**待验证点**:
- session 启动后 `get_current_page()` 非空
- `go_to_url` 后能刷新 DOM state
- `click_element` / `input_text` 能通过 index 操作真实页面元素
- 下拉框、tab 切换、截图、extract_content 在 headless/headful 下都能工作

**改进方案**: 增加一个可跳过的 Playwright/browser-use 集成测试，用本地静态 HTML 页面验证核心动作。

**影响模块**: `tools/browserUse.ts`, `nodes/prepareContext.ts`

---

## 四、增强项（稳定后再做）

### E-1: 卡死检测——语义相似度 `未完成`

**现状**: `checkStuck.ts` 只比较 `msg.content === lastMsg.content`（完全相同才触发）。LLM 换措辞重复同一策略检测不到。

**可选方案**:
- 用 embedding 计算余弦相似度（>0.95 视为重复）
- 追踪工具调用序列（连续 3 次相同工具 + 相似参数触发卡死）

**优先级**: 低

### E-2: 成本追踪 `未完成`

**现状**: 项目中没有 token 计数、usage 聚合或 cost tracker。`think.ts` 只捕获 token limit 错误，不是计数。

**改进方案**: 使用 LangChain CallbackHandler 在 graph invoke 时聚合 tokenUsage，执行完输出总费用。

**优先级**: 中

### E-3: Agent 智能路由 `未完成`

**现状**: PlanningFlow 的 `selectStepNode` 只做 `[TYPE]` 正则匹配选择 executor。

**可选方案**: LLM 做路由决策，或 embedding 匹配步骤文本 vs Agent 能力描述。

**优先级**: 低

### E-4: 工具执行超时统一管理 `未完成`

**现状**: 每个工具各自管理超时——Bash 120s, CodeExecute 5s, WebSearch 无显式超时。不一致且不可配置。

**改进方案**: 统一工具 wrapper，使用 AbortSignal / Promise.race / 子进程 timeout，配置集中到 `constants.ts`。

注意：LangGraph `RetryPolicy` 负责失败重试，不负责取消长时间运行的工具，不能用来做 timeout 管理。

**优先级**: 低

### E-5: 结构化运行观测与审计日志 `未完成`

**现状**: 目前主要是 console/pino 日志，缺少一次 agent run 的结构化 trace：节点耗时、工具输入输出摘要、token/cost、interrupt 次数、失败原因。

**改进方案**:
- 为每次 run 生成 `runId`
- 在 graph invoke/stream 配置 callbacks，记录 node/tool 级事件
- 对敏感字段做 redaction，避免把 API key、cookie、用户输入明文落日志
- 输出可选 JSON trace，方便后续接 LangSmith/OpenTelemetry

**优先级**: 中

---

## 五、测试与质量

### Q-1: LangGraph 行为回归测试 `未完成`

**应覆盖**:
- 带 checkpointer 的 invoke/stream 必须有 thread_id
- `ask_human` interrupt/resume 后必须生成匹配的 ToolMessage
- `parallel_tool_calls=false` 生效，避免 ask_human 和其他工具并行悬空
- recursionLimit wrapper 实际传入 invoke/stream config
- Planning 子图失败时不会把 failed/blocked 覆盖为 completed
- Proxy 包装后的 getState/updateState 等其他方法可用（A-3 打通后）
- trimMessages 在超长历史下能正确截断且保留 system prompt（A-1）
- A2A contextId 多次 invoke 能恢复同一会话（A-5）
- browserContextEnabled 启用后，prepare_context 节点在 browser_use 未使用时是空操作（A-6）

### Q-2: 安全边界测试 `未完成`

**应覆盖**:
- path boundary：workspace 前缀绕过、`/tmp` 前缀绕过、符号链接逃逸（S-3 修复需补回归测试）
- shell argument：文件名包含引号、空格、换行、`$()` 时不会执行额外命令（S-5 修复需补回归测试）
- codeExecute unsafe/dev mode 明确可见，sandbox mode 默认路径可用

### Q-3: Tool contract 测试 `未完成`

**应覆盖**:
- 每个工具 schema 的默认值和错误返回格式稳定
- ToolNode 输出过长时会截断且不原地修改 message
- PlanningTool 的 create/update/mark/delete 在并发 planId 下互不污染
- BrowserUse 核心动作有 smoke test，网络或浏览器不可用时可跳过
- fileOperators.listDirectory 在 local/sandbox 两种模式下行为一致（S-5 回归）
