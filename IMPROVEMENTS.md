# OpenManus LangGraph TS — 改进清单

> 状态化清单。每项标注当前状态，已完成的不再列出。
>
> 已完成并删除的项：S-2 (Bash 命令过滤)、S-4 (随机哨兵)、T-1 (extract_content 拆分)、T-2 (WebSearch 异步阻塞)、T-3 (步骤失败状态)、T-4 (Bedrock 全局状态)、A-4 (Streaming)。

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

### S-3: StrReplaceEditor 路径边界 `需修正`

**现状**: `fileOperators.ts` 的 `checkPathBoundary()` 已实现路径边界检查，但之前使用 `startsWith` 有经典前缀绕过漏洞（`/workspace_evil` 通过 `/workspace` 的 startsWith 检查）。

**正确方案**: 改为 `path.relative(root, target)` + `..` 前缀检查，或检查 `resolved === root || resolved.startsWith(root + path.sep)`。`/tmp` 白名单也必须用相同边界方式，不能裸 `startsWith("/tmp")`。

**待做**: 修复实现，并补充边界检查的单元测试（覆盖 `/workspace_evil`、`/tmp_evil`、`../escape`、符号链接等场景）。

### S-5: 文件工具 shell 命令拼接 `需修正`

**现状**: `strReplaceEditor.ts` 和 `fileOperators.ts` 中仍有面向 shell 的字符串拼接，例如目录 view 使用 `find "${path}" ...`，sandbox/local operator 也用 `test -d "${path}"` 一类命令。

**问题**: 路径虽然被限制在 workspace 内，但文件名本身可以包含引号、换行、命令替换字符等，直接插入 shell 字符串仍有命令注入风险。

**改进方案**:
- 本地目录遍历优先用 `fs.readdir` / `fs.stat`，不要 shell out 到 `find`
- 必须调用命令时使用 `spawn(command, args, { shell: false })`
- sandbox 命令统一增加 shell argument escaping helper，并集中测试特殊字符路径

**影响模块**: `tools/strReplaceEditor.ts`, `tools/fileOperators.ts`, `tools/sandbox/sbFilesTool.ts`

---

## 二、架构改进

### A-1: Memory 无 token 感知截断 `未完成`

**现状** (`nodes/think.ts`):
Token limit 错误只 catch 后设 `status: "finished"` 终止。无 compaction 策略，长任务直接失败。

**改进方案**:
```typescript
import { trimMessages } from "@langchain/core/messages";

// 在 think 节点中，发送给 LLM 前先 trim
const trimmed = await trimMessages(state.messages, {
  maxTokens: 120000,
  strategy: "last",
  tokenCounter: model,
  startOn: "human",
  includeSystem: true,
});
const response = await model.invoke(trimmed);
```

**修正时机**: 优化 think 节点时

### A-2: Planning 步骤间上下文策略 `需设计`

**现状**: `planning.ts` 每个步骤调用 `createThreadConfig()` 生成新 UUID，步骤间完全隔离。步骤 1 的 `cd /project && npm install` 在步骤 2 中不可见。

**设计取舍** (尚未决定，暂保持隔离):

| 策略 | 优点 | 缺点 |
|------|------|------|
| 每步隔离 (当前) | 干净启动，不被前序干扰 | 步骤间无法引用彼此工作 |
| 共享 thread | 步骤间有上下文连续性 | messages 越来越长，后续步骤被干扰 |
| 按 executor type 共享 | 同类 agent 步骤间共享（如所有 swe 步骤共享） | 不同类型间仍然隔离 |

**修正时机**: 优化 Planning Flow 时决定策略

### A-3: 生产级对话持久化 `部分完成`

**已完成**: `config/persistence.ts` 提供 `MemorySaver`（开发）和 `createProdCheckpointer()` helper。

**未完成**:
- Agent builder (`buildReactAgent`) 只接受 `checkpointer: boolean`，不接受外部 checkpointer 实例
- `createProdCheckpointer()` 存在但未接入任何运行入口
- `@langchain/langgraph-checkpoint-postgres` 不在 package.json 依赖中
- 生产部署仍然只有 MemorySaver（进程重启 = 数据丢失）

**待做**:
1. `ReactAgentOptions.checkpointer` 改为 `boolean | BaseCheckpointSaver`
2. 在 `index.ts` / `runFlow.ts` 入口根据环境变量或 config 选择 checkpointer
3. 文档说明如何安装和配置 PostgresSaver

### A-5: HITL 在非 CLI 入口的恢复语义 `需设计`

**现状**: CLI 的 updates/tokens 模式已经有 resume loop，但 Planning 子图和 A2A server 仍是一次性 invoke。子 agent 如果触发 `ask_human`，上层没有标准方式把 interrupt 暴露给调用方并恢复。

**问题**:
- Planning Flow 中子图 interrupt 需要上浮到父 flow，否则计划执行会卡住或得到不完整结果
- A2A 的返回类型包含 `requireUserInput`，但当前实现总是成功时返回 `false`，异常时直接 500
- `contextId` 没有映射到 LangGraph `thread_id`，同一个 A2A context 后续请求无法恢复同一对话

**改进方案**:
1. 抽出统一 `runGraphWithInterrupts(graph, input, config, callbacks)` helper
2. A2A 使用 `contextId` 作为稳定 thread_id，并在 interrupt 时返回 `{ requireUserInput: true, content: question }`
3. Planning 子图 interrupt 选择两种策略之一：上浮给父图调用方，或禁用子 agent HITL 并只允许父图询问人类

**影响模块**: `index.ts`, `graphs/planning.ts`, `a2a/server.ts`, `config/persistence.ts`

### A-6: Browser 上下文注入节点未接入图 `需确认`

**现状**: `nodes/prepareContext.ts` 已实现浏览器状态注入（URL、title、interactive elements、screenshot），但当前 graph builder 没有把 `prepareContextNode` 接到 `think` 前。

**问题**: 浏览器工具执行后，下一轮 LLM 可能只看到工具返回的短文本，而看不到最新 DOM 索引和截图；这会削弱 `browser_use` 的多步浏览能力。

**改进方案**:
- 在 Manus/browser-enabled agent 中接入 `prepare_context -> think`
- 只在最近调用过 `browser_use` 时注入，避免每轮增加大图像 token
- 对 screenshot 注入增加开关和尺寸/质量限制

**影响模块**: `graphs/reactAgent.ts`, `graphs/manus.ts`, `nodes/prepareContext.ts`

---

## 三、工具实现改进

### PlanningTool 未实际挂到 executor agent `需修正`

**现状**: `planning.ts` 的 stepPrompt 告诉 executor “你有 planning tool”，但 `createManusAgent()` / `createSWEAgent()` / `createDataAnalysisAgent()` 默认工具列表没有包含 `planningTool`。

**问题**: LLM 被提示可以动态修改计划，但实际工具不可用；这会让计划自调整能力失效，也会制造 prompt/工具不一致。

**改进方案**:
- 创建 Planning Flow 时，把 `planningTool` 作为 `extraTools` 注入需要它的 executor agent
- 或者删除 stepPrompt 中的 planning tool 描述，把计划修改集中在父图节点中完成
- 如果注入工具，必须同时解决下面的 planStorage 隔离问题

**影响模块**: `runFlow.ts`, `graphs/planning.ts`, `graphs/manus.ts`, `graphs/swe.ts`, `graphs/dataAnalysis.ts`

### PlanningTool 全局状态隔离 `需修正`

**现状**: `planStorage` 是进程级 singleton，Planning Flow 使用固定 `active_plan` 作为 planId，并且 tool 本身还有 `activePlanId`。

**问题**: 多个用户、多个 planning flow、A2A 多 context 并发时会互相覆盖 active plan。即使单进程内串行运行，也可能出现上一次任务的 plan 泄漏到下一次任务。

**改进方案**:
- planId 使用稳定命名空间：`thread_id` / `contextId` / `runId`
- PlanningTool 调用必须显式传 plan_id，尽量避免全局 active plan
- 长期方案：把 plan 存在 LangGraph state 或 Store 中，而不是进程级 singleton

**影响模块**: `tools/planningTool.ts`, `graphs/planning.ts`, `a2a/server.ts`

### PlanningTool 状态同步检测盲点 `需修正`

**现状**: `planning.ts` 的 `executeStepNode` 在子图执行前后比较 `plan.steps.map(s => s.text).join("\n")` 来检测 LLM 是否通过 PlanningTool 修改了计划。

**问题**: 如果 PlanningTool 只修改了 step 的 status 或 notes（不改 text），当前检测会漏掉。应改为同时比较 status 和 notes，或者用版本号/dirty flag。

**影响模块**: `graphs/planning.ts`

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

### Q-2: 安全边界测试 `未完成`

**应覆盖**:
- path boundary：workspace 前缀绕过、`/tmp` 前缀绕过、符号链接逃逸
- shell argument：文件名包含引号、空格、换行、`$()` 时不会执行额外命令
- codeExecute unsafe/dev mode 明确可见，sandbox mode 默认路径可用

### Q-3: Tool contract 测试 `未完成`

**应覆盖**:
- 每个工具 schema 的默认值和错误返回格式稳定
- ToolNode 输出过长时会截断且不原地修改 message
- PlanningTool 的 create/update/mark/delete 在并发 planId 下互不污染
- BrowserUse 核心动作有 smoke test，网络或浏览器不可用时可跳过
