# Agent 工作指南

本文件面向后续参与本项目的 AI Agent / 开发者，用来快速理解项目边界、开发流程和容易踩坑的地方。默认使用中文沟通和提交说明，除非任务明确要求英文。

## 项目定位

`openmanus-langgraph-ts` 是 OpenManus Python 版的 TypeScript / LangGraph 重写，不是简单包装。核心目标是用 LangGraph 的 `StateGraph`、checkpoint、interrupt、ToolNode 和 streaming 能力替代原 Python 的 Agent 类继承和手动 memory 管理。

重要参考资料：

- `README.md`: 运行方式、工具列表、项目结构。
- `CLAUDE.md`: 迁移约束、编码规范、原 Python 源码对照表。
- `IMPROVEMENTS.md`: 当前仍需处理的安全、架构、工具和测试改进项。
- `../design-langgraph-ts.md`: 设计文档。实现迁移或大改前优先阅读相关章节。
- `../app/`: 原始 OpenManus Python 源码，对照行为时使用。

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

## 编码原则

- 优先遵循现有结构和命名：文件名 camelCase，tool `name` 使用 snake_case。
- LLM 实例化使用 `createLLM()` / `config/llmFactory.ts`，不要在新代码里硬编码 `new ChatOpenAI()`。
- 常量放到 `src/config/constants.ts`，不要在工具或图节点里散落魔法数字。
- 日志使用 `logger`，避免新增 `console.log`，CLI 输出例外。
- 工具函数通常返回错误字符串，避免把可恢复工具错误 throw 到图外。
- Zod schema 尽量用 `.default()`，避免 OpenAI tool schema 因 optional 字段产生兼容警告。
- 修改迁移逻辑时，对照原 Python 源码，保留必要行为差异并在注释中说明。

## LangGraph 约束

- State collection 字段必须有 reducer。消息使用 `messagesStateReducer`。
- 节点返回 partial update，不要原地修改 `state`。
- 不要原地修改 message 对象；需要截断或改写时创建新 message。
- 条件边返回值必须在 declared destinations / path map 中，或返回 `END`。
- 使用 `interrupt()` 必须有 checkpointer，调用 invoke/stream/getState 时必须传 `configurable.thread_id`。
- `Command({ resume })` 只能用于带 checkpointer 的 graph。
- 工具调用必须和 `ToolMessage` 成对。`ask_human` 是特殊工具，由 `humanReviewNode` 处理。
- OpenAI 并行 tool calls 会让 `ask_human` 与普通工具并行时出现悬空 tool call；当前实现应保持 `parallel_tool_calls=false`。
- `recursionLimit` 在当前 LangGraph TS 版本中是 invoke/stream config，不是 `compile()` 参数。

## 当前已知风险

进入相关模块前先看 `IMPROVEMENTS.md`。尤其注意：

- `code_execute` 仍直接在宿主机执行 Python，安全上应默认走隔离 sandbox。
- 文件路径边界和 shell 参数拼接需要继续加固和测试。
- 生产级 persistence 只具备 helper，尚未完整接入 agent builder 和运行入口。
- Planning 子图上下文共享策略尚未定稿。
- 非 CLI 入口的 HITL resume 语义仍需统一，尤其 A2A 和 Planning 子图。
- `prepareContextNode` 已存在，但浏览器上下文是否接入 graph 需要确认。
- `planningTool` 的工具挂载、planId 隔离和状态同步仍需完善。

## 开发流程

1. 先读相关文件和 `IMPROVEMENTS.md`，确认当前状态，不要凭记忆修改。
2. 如果涉及 LangGraph 图、节点、HITL、persistence，先核对 LangGraph API 约束。
3. 小步修改，避免混入无关重构。
4. 文档和代码保持一致：完成项从 `IMPROVEMENTS.md` 删除或改状态，未完成项不要标成已完成。
5. 至少运行 `npx tsc --noEmit`。涉及工具或图行为时，运行 `npx tsx src/test-graph.ts` 或补专项测试。

## 安全边界

- 不要把 LLM 生成代码默认放在宿主机执行。
- 不要使用简单 `startsWith` 判断路径边界；使用 `path.relative` 或 `resolved === root || resolved.startsWith(root + path.sep)`。
- 不要把未转义路径拼进 shell 字符串；优先使用 Node fs API 或 `spawn(command, args, { shell: false })`。
- 日志和 trace 需要脱敏 API key、cookie、token、用户敏感输入。
- 不要新增破坏性命令或自动清理逻辑，除非任务明确要求并有清晰边界。

## 提交前检查

```bash
npx tsc --noEmit
npx tsx src/test-graph.ts
git diff --check
```

如果由于缺少 API key、Docker、浏览器或网络导致验证不能跑，要在交付说明中明确写出未验证项和原因。
