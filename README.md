# OpenManus LangGraph TS

[OpenManus](https://github.com/mannaandpoem/OpenManus) 的 TypeScript 重写版本，基于 [LangGraph](https://langchain-ai.github.io/langgraph/) 构建。

## 快速开始

```bash
# 安装依赖
npm install

# 复制配置文件，填入你的 API Key
cp config/config.example.toml config/config.toml

# 运行（默认使用 config.toml 中的 LLM 配置）
npx tsx src/index.ts "帮我列出当前目录的文件"
```

也可以通过环境变量直接运行（跳过 config.toml）：

```bash
OPENAI_API_KEY=sk-... npx tsx src/index.ts "你的任务"
```

## 运行模式

```bash
# 单 Agent — 逐步输出
npx tsx src/index.ts "搜索 LangGraph 文档并总结"

# 单 Agent — token 级流式（适合 Chat UI 接入）
npx tsx src/index.ts --tokens "解释一下这段代码"

# 单 Agent — 一次性返回
npx tsx src/index.ts --invoke "简单任务"

# 多 Agent 编排（Planning Flow）
npx tsx src/runFlow.ts "写一个 Todo 应用并测试"

# A2A 协议服务（需安装 express: npm install express）
npx tsx src/a2a/server.ts

# MCP 服务（暴露工具给外部 Agent）
npx tsx src/mcp/server.ts
```

## 多模型支持

通过 LangChain `initChatModel` 统一管理，支持 20+ LLM provider。修改 `config/config.toml` 中的 `api_type` 即可切换：

| api_type | Provider | 安装 |
|----------|----------|------|
| `openai` | OpenAI | 已内置 |
| `anthropic` | Anthropic Claude | `npm install @langchain/anthropic` |
| `bedrock` | AWS Bedrock | `npm install @langchain/aws` |
| `google` | Google Gemini | `npm install @langchain/google-genai` |
| `ollama` | Ollama (本地) | `npm install @langchain/ollama` |
| `azure` | Azure OpenAI | 已内置 |
| `groq` | Groq | `npm install @langchain/groq` |
| `deepseek` | DeepSeek | `npm install @langchain/deepseek` |

每个 Agent 可以使用不同的模型：

```toml
[llm]
api_type = "openai"
model = "gpt-4o"

[llm.data]
api_type = "anthropic"
model = "claude-sonnet-4-20250514"
```

## 工具

| 工具 | 说明 |
|------|------|
| `bash` | 持久 Bash 会话（cd/环境变量跨命令保留） |
| `code_execute` | Python 代码执行 |
| `browser_use` | 浏览器自动化 + DOM 元素索引（基于 browser-use） |
| `str_replace_editor` | 文件查看/创建/编辑/撤销 |
| `web_search` | 网络搜索（DuckDuckGo） |
| `crawl4ai` | 网页抓取（Playwright JS 渲染） |
| `chart_visualization` | 智能图表生成（VMind） |
| `planning` | 计划管理（7 命令 CRUD） |
| `ask_human` | 人机交互（基于 LangGraph interrupt） |
| `terminate` | 终止执行 |
| `sandbox_shell` | 沙箱 tmux 会话（需 Docker） |
| `sandbox_files` | 沙箱文件操作 |
| `sandbox_browser` | 沙箱浏览器 |
| `sandbox_vision` | 沙箱截图 / OCR |
| MCP 动态工具 | 通过 MCP 协议加载外部工具 |

## Agent 类型

| Agent | 用途 | 工具集 |
|-------|------|--------|
| Manus | 通用任务 | 全部核心工具 |
| SWE | 软件工程 | bash + editor |
| DataAnalysis | 数据分析 | code_execute + 图表工具 |
| SandboxManus | 隔离执行 | 4 个沙箱工具 |
| Planning Flow | 多 Agent 编排 | 动态选择上述 Agent |

## 高级功能

**Human-in-the-Loop**: Agent 调用 `ask_human` 时自动暂停，等待用户输入后继续。

**持久化**: 支持 MemorySaver（开发）和 PostgresSaver（生产），对话可跨进程恢复。

**Streaming**: 三种模式 — updates（节点级）、messages（token 级）、invoke（一次性）。

**MCP 集成**: 既是 MCP 客户端（加载外部工具）也是 MCP 服务端（暴露工具给外部）。

**A2A 协议**: HTTP 服务，支持 AgentCard 能力声明和 Task 管理。

## 开发

```bash
# 类型检查
npx tsc --noEmit

# 运行测试（不需要 API Key）
npx tsx src/test-graph.ts

# 开发模式（文件变更自动重新运行）
npx tsx watch src/index.ts
```

## 项目结构

```
src/
  config/         # 配置加载、常量、LLM 工厂、持久化
  state/          # LangGraph 状态定义
  tools/          # 14 个核心工具 + 4 个沙箱工具
  nodes/          # 图节点（think、checkStuck、humanReview、prepareContext）
  graphs/         # Agent 图工厂（reactAgent、manus、swe、dataAnalysis、planning、sandboxManus）
  prompts/        # 提示词模板
  sandbox/        # Docker 沙箱（容器、终端、管理器）
  utils/          # 日志、异常类型
  a2a/            # A2A 协议服务
  mcp/            # MCP 服务端
```

## 与原版 OpenManus 的关系

本项目是 OpenManus Python 版的功能对等重写，不是包装。核心差异：

- **框架**: Python Agent 类继承 → LangGraph StateGraph
- **状态管理**: 手动 Memory → MessagesValue reducer 自动追加
- **工具执行**: 自定义 ToolCollection → LangGraph ToolNode
- **HITL**: `input()` 阻塞 → `interrupt()` 非阻塞（支持 Web）
- **持久化**: 无 → Checkpointer（MemorySaver / PostgresSaver）
- **LLM**: 自定义 LLM 类 → LangChain `initChatModel`（20+ provider）

设计文档见 `docs/design.md`。
