# OpenManus LangGraph TS

[OpenManus](https://github.com/mannaandpoem/OpenManus) 的 TypeScript 重写版本，基于 [LangGraph](https://langchain-ai.github.io/langgraph/) 构建。

它的目标不是“包装一下原项目”，而是把 OpenManus 那套 Agent 思路落到 TypeScript + LangGraph 的状态图模型里。项目现在已经可以作为本地 Agent 框架来使用，也可以作为 Web 聊天后端、A2A 服务端、MCP 工具服务来接入别的系统。

## 这个项目现在能做什么

从简单到复杂，大致可以分成这几类：

1. **纯文本任务**
   - 问答
   - 总结网页或文档
   - 改写、翻译、提炼要点

2. **本地工具任务**
   - 执行 Bash 命令
   - 执行 Python 代码
   - 查看、创建、编辑文件
   - 在当前工作目录里做自动化操作

3. **联网任务**
   - Web 搜索
   - 抓取网页正文
   - 用浏览器打开页面、点击、输入、选择下拉框

4. **数据处理任务**
   - 读 CSV / JSON / Excel
   - 用 Python 做清洗、统计、分析
   - 生成图表和分析结果

5. **软件工程任务**
   - 浏览代码库
   - 修改代码
   - 运行命令和脚本
   - 多轮迭代完成一个功能

6. **复杂多步骤任务**
   - 自动拆计划
   - 按步骤执行
   - 根据步骤类型选择通用 Agent、SWE Agent、数据分析 Agent
   - 在执行过程中动态更新计划状态

7. **交互与集成**
   - Human-in-the-Loop：Agent 暂停后等待你输入，再继续执行
   - Web Chat：SSE 流式返回消息和工具调用
   - A2A：作为 Agent 服务端接入别的 Agent
   - MCP：把本项目的工具暴露给外部客户端

## 快速开始

### 1. 安装依赖

推荐使用 `pnpm`：

```bash
pnpm install
```

如果你使用 `npm` 也可以：

```bash
npm install
```

### 2. 配置模型

你可以用 `config/config.toml`，也可以用 `.env`。

复制配置模板：

```bash
cp config/config.example.toml config/config.toml
cp .env.example .env
```

项目会自动加载 `.env`，并读取 `config/config.toml`。  
**优先级是：环境变量 > `config/config.toml` > 默认值。**

### 3. 验证模型连接

```bash
npx tsx src/index.ts --invoke "请只回复：连接成功"
```

如果配置正确，你会看到类似输出：

```text
连接成功
```

## 模型配置

### 推荐用法

项目内部统一通过 LangChain 的 `initChatModel()` 创建模型实例。  
`api_type` 建议直接使用 LangChain 原生 provider 名称。

常见值：

| `api_type` | Provider | 额外安装 |
|---|---|---|
| `openai` | OpenAI / OpenAI 兼容接口 | 已内置 |
| `anthropic` | Claude | `npm install @langchain/anthropic` |
| `azure_openai` | Azure OpenAI | 已内置 |
| `google-genai` | Gemini | `npm install @langchain/google-genai` |
| `bedrock` | AWS Bedrock | `npm install @langchain/aws` |
| `ollama` | 本地模型 | `npm install @langchain/ollama` |
| `groq` | Groq | `npm install @langchain/groq` |
| `deepseek` | DeepSeek | `npm install @langchain/deepseek` |

### OpenAI 示例

`config/config.toml`：

```toml
[llm]
api_type = "openai"
model = "gpt-4o"
base_url = "https://api.openai.com/v1"
api_key = "sk-..."
max_tokens = 4096
temperature = 0.0
```

### 通义千问示例

通义千问走 OpenAI 兼容接口，不需要单独写 provider 适配层。

```toml
[llm]
api_type = "openai"
model = "qwen-plus"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
api_key = "你的 DashScope / 百炼 key"
max_tokens = 4096
temperature = 0.0
```

也可以直接用环境变量：

```bash
LLM_API_TYPE=openai \
LLM_MODEL=qwen-plus \
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
LLM_API_KEY=你的key \
npx tsx src/index.ts --invoke "你好"
```

如果你已经习惯 `OPENAI_*` 变量名，也兼容：

```bash
OPENAI_MODEL=qwen-plus \
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
OPENAI_API_KEY=你的key \
npx tsx src/index.ts --invoke "你好"
```

### 多 Agent 使用不同模型

```toml
[llm]
api_type = "openai"
model = "qwen-plus"

[llm.data]
api_type = "openai"
model = "qwen-max"

[llm.manus]
api_type = "openai"
model = "qwen-plus"
```

## 从简单到复杂，怎么用

### 1. 最简单：把它当命令行问答工具

```bash
npx tsx src/index.ts --invoke "用三句话介绍 LangGraph"
```

适合：

- 单轮问答
- 快速验证模型是否通
- 不关心中间工具调用过程

### 2. 看执行过程：逐步输出

```bash
npx tsx src/index.ts "搜索 LangGraph 文档并总结核心概念"
```

这个模式会按节点输出思考和工具结果，适合观察 Agent 过程。

### 3. Token 流式输出

```bash
npx tsx src/index.ts --tokens "解释一下这段代码的作用"
```

适合：

- 模拟聊天式响应
- 接近前端流式体验

### 4. 本地文件和命令任务

```bash
npx tsx src/index.ts --invoke "查看当前目录文件，并新建一个 hello.py，输出 hello world"
```

这类任务通常会用到：

- `bash`
- `str_replace_editor`
- `code_execute`

### 5. 网页搜索和浏览器任务

```bash
npx tsx src/index.ts "搜索 LangGraph 官方文档，并打开最相关的页面后总结"
```

这类任务通常会用到：

- `web_search`
- `crawl4ai`
- `browser_use`

### 6. 数据分析任务

```bash
npx tsx src/index.ts "读取 workspace/sales.csv，做一个月度销售分析并生成图表"
```

这类任务通常会用到：

- `code_execute`
- `chart_visualization`

### 7. 软件工程任务

```bash
npx tsx src/index.ts "检查当前项目的 package.json 和 src 目录，帮我实现一个最小的 REST API"
```

适合：

- 改代码
- 跑脚本
- 修 bug
- 做局部自动化

### 8. 复杂任务：Planning Flow

```bash
npx tsx src/runFlow.ts "写一个 Todo 应用，包含后端 API、前端页面和基本测试"
```

Planning Flow 会：

1. 先生成计划
2. 选择当前步骤
3. 根据步骤类型选择 Agent
4. 执行并更新步骤状态
5. 最后总结结果

适合：

- 明显需要拆步骤的任务
- 编程 + 数据处理混合任务
- 更长链路的执行流程

## Web 模式

### 启动后端

```bash
npm run server
```

默认端口是 `3000`，可通过 `PORT` 环境变量修改。

### 启动前端

```bash
npm run web
```

前端默认跑在 `5173`，并代理 `/api` 到 `http://localhost:3000`。

### Web API

当前后端主要暴露这些接口：

- `POST /api/chat`
- `POST /api/chat/resume`
- `GET /api/agent-card`

适合：

- 本地聊天界面
- SSE 流式输出
- HITL 中断后恢复执行

## A2A 和 MCP

### A2A 服务

```bash
npx tsx src/a2a/server.ts
```

用途：

- 作为 Agent 服务端暴露能力
- 支持任务列表和任务状态查询
- 支持 HITL 恢复

常用接口：

- `GET /.well-known/agent.json`
- `POST /invoke`
- `GET /tasks`
- `GET /tasks/:id`

### MCP 服务

```bash
npx tsx src/mcp/server.ts
```

用途：

- 把本项目工具暴露为 MCP 工具
- 让外部 Agent 通过 MCP 调用 `bash`、`code_execute`、`str_replace_editor`、`web_search`

## 当前内置工具

| 工具 | 用途 |
|---|---|
| `bash` | 持久 Bash 会话 |
| `code_execute` | 执行 Python 代码 |
| `browser_use` | 浏览器自动化 |
| `str_replace_editor` | 文件查看、创建、编辑、撤销 |
| `web_search` | Web 搜索 |
| `crawl4ai` | 网页抓取 |
| `chart_visualization` | 图表生成 |
| `planning` | 计划管理 |
| `ask_human` | 人工输入 |
| `terminate` | 终止任务 |
| `sandbox_shell` | 沙箱命令执行 |
| `sandbox_files` | 沙箱文件操作 |
| `sandbox_browser` | 沙箱浏览器 |
| `sandbox_vision` | 沙箱截图 / OCR |

## Agent 类型

| Agent | 用途 |
|---|---|
| `Manus` | 通用任务 |
| `SWE` | 软件工程任务 |
| `DataAnalysis` | 数据分析和图表任务 |
| `SandboxManus` | 隔离执行任务 |
| `Planning Flow` | 多步骤编排 |

## Human-in-the-Loop 与持久化

### Human-in-the-Loop

当 Agent 调用 `ask_human` 时，会暂停并等待你的输入，然后从中断点继续执行。

### 持久化

项目支持两种 checkpointer：

- `MemorySaver`：开发环境，本地内存持久化
- `PostgresSaver`：生产环境，跨进程恢复

如果设置了：

```bash
LANGGRAPH_CHECKPOINT_PG=postgresql://user:pass@host:5432/dbname
```

项目会优先尝试 Postgres checkpointer；否则回退到内存实现。

## 常见问题

### 1. CLI 一启动就报 `canvas.node` 找不到

这是 `browser-use` 依赖的 `canvas` 原生模块没有装好。

如果你使用 `pnpm`，项目已经在 `package.json` 里声明允许构建 `canvas`。通常重新执行下面两条就可以：

```bash
pnpm install
pnpm rebuild canvas
```

### 2. 为什么有些任务能回答，但工具相关任务失败

通常是以下几类原因：

- 模型 key 没配对
- 浏览器依赖没装好
- Python 环境不可用
- 工作目录或路径不在允许范围内

### 3. 为什么运行时会看到很多 Zod warning

目前部分工具 schema 仍然使用了 `.optional()` 字段，在 OpenAI 结构化输出模式下会出现兼容性提醒。  
现在不影响执行，但后续最好统一调整 schema 定义。

## 开发

```bash
# 类型检查
npx tsc --noEmit

# 构建
npm run build

# 前端构建
cd web && npm run build

# 图结构测试
npx tsx src/test-graph.ts

# CLI 开发模式
npx tsx watch src/index.ts
```

## 项目结构

```text
src/
  config/         配置加载、常量、LLM 工厂、持久化
  state/          LangGraph 状态定义
  tools/          核心工具和沙箱工具
  nodes/          图节点
  graphs/         Agent 图工厂
  prompts/        提示词模板
  sandbox/        Docker 沙箱
  utils/          日志、异常类型
  a2a/            A2A 服务
  mcp/            MCP 服务

server/
  Web Chat API 与 SSE 服务

web/
  React 前端
```

## 与原版 OpenManus 的关系

本项目是 OpenManus Python 版的功能对等重写，不是简单包装。核心差异：

- Python Agent 类继承 -> LangGraph StateGraph
- 手动 memory 管理 -> LangGraph reducer
- 自定义工具执行层 -> ToolNode
- 阻塞式人工输入 -> `interrupt()` / `resume`
- 无持久化 -> Checkpointer
- 自定义 LLM 封装 -> LangChain `initChatModel()`

设计文档见 [docs/design.md](docs/design.md)。
