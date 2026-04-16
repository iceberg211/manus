# Manus — AI Agent Framework (LangGraph TypeScript)

基于 [OpenManus](https://github.com/mannaandpoem/OpenManus) 重写，使用 LangGraph 作为核心框架。

- **设计文档**: `docs/design.md`
- **改进清单**: `IMPROVEMENTS.md`
- **原始 Python 参考**: [OpenManus](https://github.com/mannaandpoem/OpenManus) `app/` 目录

## 必须调用的 Skill

| Skill | 调用时机 |
|-------|---------|
| `langgraph-fundamentals` | 编写任何 Graph、Node、Edge、Command、Send 代码时 |
| `langgraph-docs` | 需要查阅 API 参考或实现模式时 |
| `langgraph-human-in-the-loop` | 实现 interrupt()、Command(resume=) 等 HITL 功能时 |
| `langgraph-persistence` | 实现 Checkpointer、thread_id、Store、时间旅行时 |

## 开发工作流

每个实施阶段遵循以下流程：

1. **读设计文档** — `docs/design.md` 对应章节
2. **读原始 Python 源码** — 对应的 `OpenManus/app/` 源文件
3. **调用 LangGraph Skill** — 写图/状态/节点代码前
4. **实现** — 将 Python 逻辑翻译为 TypeScript LangGraph
5. **测试** — `npx tsx src/test-graph.ts` 或写专项测试
6. **验证** — 确保行为与原始 OpenManus 一致

## 编码规范

| 规范 | 说明 |
|------|------|
| 文件命名 | camelCase |
| 工具 name 字段 | snake_case |
| LLM 实例化 | 使用 `createLLM()` (`config/llmFactory.ts`，内部调 `initChatModel`)，禁止硬编码 `new ChatOpenAI()` |
| 文件头注释 | `Translated from: app/path/file.py` 标注原始来源 |
| 常量 | 统一放 `config/constants.ts`，不在工具文件里写魔数 |
| 日志 | 使用 `logger` (from `utils/logger.ts`)，禁止 `console.log` |
| 错误处理 | 工具返回错误字符串不 throw；意外异常用 `utils/errors.ts` 类型 |
| 行为保留 | 见 `docs/design.md` Appendix B（10 个必须保留的微妙行为）|
| Zod schema | 不用 `.optional()`，用 `.default()` 避免 OpenAI API 警告 |

## 核心架构决策

| 决策 | 说明 |
|------|------|
| Annotation API | `Annotation.Root({...})` 定义状态 |
| MessagesValue reducer | 消息自动追加，不手动管理 |
| ToolNode (prebuilt) | `new ToolNode(tools, { handleToolErrors: true })` 替代手动执行 |
| tool() 函数 | `@langchain/core/tools` 的 `tool()` + zod schema 替代 `BaseTool` 类 |
| 无类继承 | Agent 通过 `buildReactAgent()` 传入不同工具/prompt 创建 |
| Terminate 路由 | 条件边路由到 END，不通过状态突变 |
| LLM 统一工厂 | `initChatModel` 支持 20+ provider，`api_type` 控制路由 |

## 原始 Python 源码对照表

| 组件 | Python 源文件 |
|------|-------------|
| Agent 基类 | `OpenManus/app/agent/base.py`、`OpenManus/app/agent/react.py` |
| 工具调用 | `OpenManus/app/agent/toolcall.py` |
| Manus Agent | `OpenManus/app/agent/manus.py` |
| Browser Agent | `OpenManus/app/agent/browser.py` |
| SWE Agent | `OpenManus/app/agent/swe.py` |
| 数据分析 Agent | `OpenManus/app/agent/data_analysis.py` |
| SandboxManus | `OpenManus/app/agent/sandbox_agent.py` |
| MCPAgent | `OpenManus/app/agent/mcp.py` |
| Planning Flow | `OpenManus/app/flow/planning.py`、`OpenManus/app/flow/base.py` |
| Planning Tool | `OpenManus/app/tool/planning.py` |
| 所有工具 | `OpenManus/app/tool/*.py` |
| 沙箱工具集 | `OpenManus/app/tool/sandbox/sb_shell_tool.py`、`sb_browser_tool.py`、`sb_files_tool.py`、`sb_vision_tool.py` |
| 图表可视化 | `OpenManus/app/tool/chart_visualization/` |
| 提示词 | `OpenManus/app/prompt/*.py` |
| LLM 接口 | `OpenManus/app/llm.py` |
| Bedrock 客户端 | `OpenManus/app/bedrock.py` |
| 配置系统 | `OpenManus/app/config.py` |
| 沙箱系统 | `OpenManus/app/sandbox/core/sandbox.py`、`terminal.py`、`manager.py` |
| 文件操作 | `OpenManus/app/tool/file_operators.py` |
| 日志 | `OpenManus/app/logger.py`、`OpenManus/app/utils/logger.py` |
| 异常 | `OpenManus/app/exceptions.py` |
| 搜索引擎 | `OpenManus/app/tool/search/*.py` |
| MCP 客户端 | `OpenManus/app/tool/mcp.py` |
| MCP 服务端 | `OpenManus/app/mcp/server.py` |
| Crawl4AI | `OpenManus/app/tool/crawl4ai.py` |
| A2A 协议 | `OpenManus/protocol/a2a/app/` |
| Daytona | `OpenManus/app/daytona/sandbox.py`、`tool_base.py` |
