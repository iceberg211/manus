# OpenManus LangGraph TypeScript 重写

本仓库只保留根目录 `AGENTS.md` 作为主规则文件。后续不要再新增 `agent.md`、`Agent.md`、`agents.md` 等变体文件，避免规则来源冲突。

本项目是 [OpenManus](https://github.com/mannaandpoem/OpenManus)（Python AI Agent 框架）的 TypeScript 重写，使用 LangGraph 作为核心框架。

- **原始源码**: `../app/` 目录（Python）
- **设计文档**: `../design-langgraph-ts.md` — 每次开发会话开始时必须先读对应章节
- **改进清单**: `IMPROVEMENTS.md` — 当前安全、架构、工具与测试改进项
- **运行说明**: `README.md`

## 必须调用的 Skill

| Skill | 调用时机 |
|-------|---------|
| `langgraph-fundamentals` | 编写任何 Graph、Node、Edge、Command、Send 代码时 |
| `langgraph-human-in-the-loop` | 实现 `interrupt()`、`Command(resume=...)` 等 HITL 功能时 |
| `langgraph-persistence` | 实现 Checkpointer、`thread_id`、Store、时间旅行时 |

## 开发工作流

每个实施阶段遵循以下流程：

1. **读设计文档** — `../design-langgraph-ts.md` 对应章节
2. **读原始 Python 源码** — 对应的 `../app/` 源文件
3. **核对 LangGraph API 约束** — 写图、状态、HITL、持久化前先确认当前实现方式
4. **实现** — 将 Python 逻辑翻译为 TypeScript LangGraph
5. **测试** — `npx tsx src/test-graph.ts` 或写专项测试
6. **验证** — 确保行为与原始 OpenManus 一致

## 常用命令

```bash
npm install
npx tsc --noEmit
npx tsx src/test-graph.ts
npx tsx src/index.ts "列出当前目录文件"
npx tsx src/index.ts --tokens "解释当前项目结构"
npx tsx src/index.ts --invoke "简单任务"
npx tsx src/runFlow.ts "使用 Planning Flow 执行一个任务"
```

如果需要配置模型：

```bash
cp config/config.example.toml config/config.toml
```

然后在 `config/config.toml` 中填写 API key / model / api_type。也可以临时使用环境变量，例如 `OPENAI_API_KEY=...`。

## 编码规范

| 规范 | 说明 |
|------|------|
| 文件命名 | camelCase |
| 工具 `name` 字段 | snake_case |
| LLM 实例化 | 使用 `createLLM()`（`src/config/llmFactory.ts`），禁止硬编码 `new ChatOpenAI()` |
| 文件头注释 | `Translated from: app/path/file.py` 标注原始来源 |
| 常量 | 统一放 `src/config/constants.ts`，不在工具文件里写魔数 |
| 日志 | 使用 `logger`（`src/utils/logger.ts`），禁止 `console.log` |
| 错误处理 | 工具返回错误字符串不 throw；意外异常用 `src/utils/errors.ts` 类型 |
| 行为保留 | 见 `../design-langgraph-ts.md` Appendix B |
| Zod schema | 不用 `.optional()`，用 `.default()` 避免 OpenAI API 警告 |

## 导入约定

- `src/` 内部模块统一使用 `@/` 作为根路径别名，例如 `@/graphs/manus`
- `src/` 源码内部导入统一省略文件后缀；构建产物由 `tsc-alias` 自动补成 `.js`
- 允许使用 Node 内置包和第三方包的裸导入；仅项目内部模块使用 `@/`
- `web/` 子项目是否使用同样的别名，单独按其构建配置处理，不要在未配置前混用

## 核心架构决策

| 决策 | 说明 |
|------|------|
| Annotation API | `Annotation.Root({...})` 定义状态 |
| `messagesStateReducer` | 消息自动追加，不手动管理 |
| ToolNode（prebuilt） | `new ToolNode(tools, { handleToolErrors: true })` 替代手动执行 |
| `tool()` 函数 | `@langchain/core/tools` 的 `tool()` + zod schema 替代 `BaseTool` 类 |
| 无类继承 | Agent 通过 `buildReactAgent()` 传入不同工具 / prompt 创建 |
| Terminate 路由 | 条件边路由到 `END`，不通过状态突变 |
| LLM 统一工厂 | `initChatModel` 支持多 provider，`api_type` 控制路由 |

## LangGraph 约束

- State collection 字段必须有 reducer。消息使用 `messagesStateReducer`
- 节点返回 partial update，不要原地修改 `state`
- 不要原地修改 message 对象；需要截断或改写时创建新 message
- 条件边返回值必须在 declared destinations / path map 中，或返回 `END`
- 使用 `interrupt()` 必须有 checkpointer，调用 `invoke` / `stream` / `getState` 时必须传 `configurable.thread_id`
- `Command({ resume })` 只能用于带 checkpointer 的 graph
- 工具调用必须和 `ToolMessage` 成对。`ask_human` 是特殊工具，由 `humanReviewNode` 处理
- OpenAI 并行 tool calls 会让 `ask_human` 与普通工具并行时出现悬空 tool call；当前实现应保持 `parallel_tool_calls=false`
- `recursionLimit` 在当前 LangGraph TS 版本中是 `invoke` / `stream` config，不是 `compile()` 参数

## 目录地图

```text
src/
  config/     配置加载、LLM 工厂、常量、persistence/thread config
  state/      LangGraph state schema
  nodes/      think、humanReview、checkStuck、prepareContext 等图节点
  graphs/     reactAgent、manus、swe、dataAnalysis、planning、sandboxManus
  tools/      core tools、sandbox tools、MCP/planning/browser/search/editor
  prompts/    系统提示词和 planning prompt
  sandbox/    Docker sandbox、terminal、manager
  a2a/        A2A HTTP 服务
  mcp/        MCP 服务端
  utils/      logger、error types
```

## 当前已知风险

进入相关模块前先看 `IMPROVEMENTS.md`。尤其注意：

- `code_execute` 仍直接在宿主机执行 Python，安全上应默认走隔离 sandbox
- 文件路径边界和 shell 参数拼接需要继续加固和测试
- 生产级 persistence 只具备 helper，尚未完整接入 agent builder 和运行入口
- Planning 子图上下文共享策略尚未定稿
- 非 CLI 入口的 HITL resume 语义仍需统一，尤其 A2A 和 Planning 子图
- `planningTool` 的工具挂载、planId 隔离和状态同步仍需完善

## 安全边界

- 不要把 LLM 生成代码默认放在宿主机执行
- 不要使用简单 `startsWith` 判断路径边界；使用 `path.relative` 或等价方式
- 不要把未转义路径拼进 shell 字符串；优先使用 Node fs API 或 `spawn(command, args, { shell: false })`
- 日志和 trace 需要脱敏 API key、cookie、token、用户敏感输入
- 不要新增破坏性命令或自动清理逻辑，除非任务明确要求并有清晰边界

## 提交前检查

```bash
npx tsc --noEmit
npx tsx src/test-graph.ts
git diff --check
```

如果由于缺少 API key、Docker、浏览器或网络导致验证不能跑，要在交付说明中明确写出未验证项和原因。

## 原始 Python 源码对照表

| 组件 | Python 源文件 |
|------|--------------|
| Agent 基类 | `../app/agent/base.py`、`../app/agent/react.py` |
| 工具调用 | `../app/agent/toolcall.py` |
| Manus Agent | `../app/agent/manus.py` |
| Browser Agent | `../app/agent/browser.py` |
| SWE Agent | `../app/agent/swe.py` |
| 数据分析 Agent | `../app/agent/data_analysis.py` |
| SandboxManus | `../app/agent/sandbox_agent.py` |
| MCPAgent | `../app/agent/mcp.py` |
| Planning Flow | `../app/flow/planning.py`、`../app/flow/base.py` |
| Planning Tool | `../app/tool/planning.py` |
| 所有工具 | `../app/tool/*.py` |
| 沙箱工具集 | `../app/tool/sandbox/sb_shell_tool.py`、`sb_browser_tool.py`、`sb_files_tool.py`、`sb_vision_tool.py` |
| 图表可视化 | `../app/tool/chart_visualization/` |
| 提示词 | `../app/prompt/*.py` |
| LLM 接口 | `../app/llm.py` |
| Bedrock 客户端 | `../app/bedrock.py` |
| 配置系统 | `../app/config.py` |
| 沙箱系统 | `../app/sandbox/core/sandbox.py`、`terminal.py`、`manager.py` |
| 文件操作 | `../app/tool/file_operators.py` |
| 日志 | `../app/logger.py`、`../app/utils/logger.py` |
| 异常 | `../app/exceptions.py` |
| 搜索引擎 | `../app/tool/search/*.py` |
| MCP 客户端 | `../app/tool/mcp.py` |
| MCP 服务端 | `../app/mcp/server.py` |
| Crawl4AI | `../app/tool/crawl4ai.py` |
| A2A 协议 | `../protocol/a2a/app/` |
| Daytona | `../app/daytona/sandbox.py`、`tool_base.py` |
