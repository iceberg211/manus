# Manus 项目学习指南

## 这个项目做了什么

一句话：**用 TypeScript + LangGraph 重写了一个完整的 AI Agent 框架**。

Agent 能做什么？你给它一个任务（比如"帮我写个 Python 脚本并运行"），它会：
1. 自己思考该用什么工具
2. 调用工具（写文件、执行代码、搜索网络、操作浏览器...）
3. 看结果，决定下一步
4. 循环直到任务完成

这就是 **ReAct 模式**（Reasoning + Acting），是当前 AI Agent 的主流架构。

---

## 从哪里开始看

### 建议的阅读顺序

```
1. 理解状态       →  src/state/agentState.ts        (30 行，最简单)
2. 理解核心循环    →  src/graphs/reactAgent.ts       (核心，200 行)
3. 理解 LLM 调用   →  src/nodes/think.ts             (LLM 怎么被调用的)
4. 理解工具       →  src/tools/bash.ts              (最典型的工具)
5. 理解多 Agent    →  src/graphs/planning.ts         (编排多个 Agent)
6. 理解 Web 层     →  server/index.ts + web/src/     (前后端怎么连的)
```

不需要一次全看。先看 1-3 就能理解 80% 的架构。

---

## 核心概念

### 1. StateGraph — 图就是 Agent

LangGraph 的核心思想：**把 Agent 的行为建模为一个有向图**。

```
START → think → tools → think → tools → ... → END
```

每个节点是一个函数，边决定下一步去哪。这取代了传统的 while 循环。

**对应文件**: `src/graphs/reactAgent.ts`

```typescript
const graph = new StateGraph(AgentState)
  .addNode("think", thinkNode)          // 节点：调 LLM
  .addNode("tools", toolNode)           // 节点：执行工具
  .addEdge(START, "think")              // 起点 → think
  .addConditionalEdges("think", shouldContinue, ["tools", END])  // think 后决定去哪
  .addEdge("tools", "think")            // tools 后回到 think
  .compile();
```

**为什么用图不用 while 循环？**
- 图可以被可视化、调试
- 图天然支持持久化（每步存 checkpoint）
- 图天然支持中断恢复（interrupt/resume）
- 图的边可以做条件路由（比如检测到终止工具就去 END）

### 2. State — 共享记忆

Agent 的所有节点共享一个 State 对象。最重要的字段是 `messages`：

**对应文件**: `src/state/agentState.ts`

```typescript
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,  // 关键：自动追加，不覆盖
    default: () => [],
  }),
  status: Annotation<"running" | "finished" | "stuck">({ ... }),
});
```

`reducer: messagesStateReducer` 是 LangGraph 的核心机制——当节点返回 `{ messages: [newMsg] }` 时，**追加**到已有列表，不是覆盖。这样对话历史自动累积。

### 3. Think 节点 — LLM 做决策

**对应文件**: `src/nodes/think.ts`

```typescript
async function thinkNode(state) {
  const messages = [systemPrompt, ...state.messages, nextStepPrompt];
  const response = await model.invoke(messages);  // 调 LLM
  return { messages: [response] };                 // 返回 AIMessage（可能带 tool_calls）
}
```

LLM 返回的 AIMessage 可能包含 `tool_calls`——这是 LLM 在说"我想调用这些工具"。然后路由函数检查：有 tool_calls → 去 tools 节点；没有 → 去 END。

### 4. Tools 节点 — 执行工具

**对应文件**: `@langchain/langgraph/prebuilt` 的 `ToolNode`

```typescript
const toolNode = new ToolNode(tools, { handleToolErrors: true });
```

一行代码。ToolNode 自动：
- 读取最后一条 AIMessage 的 tool_calls
- 逐个调用对应的工具函数
- 返回 ToolMessage（工具结果）
- 如果出错，把错误包装成 ToolMessage（LLM 可以看到并重试）

### 5. 工具 — 用 `tool()` 函数定义

**对应文件**: `src/tools/bash.ts`（以 bash 为例）

```typescript
export const bash = tool(
  async ({ command }) => {
    const result = await session.run(command);
    return result.output;
  },
  {
    name: "bash",
    description: "Execute a bash command in the terminal.",
    schema: z.object({
      command: z.string().describe("The bash command to execute."),
    }),
  }
);
```

三部分：执行函数 + name/description（告诉 LLM 这个工具干什么）+ zod schema（参数格式）。

LLM 看到 description 后决定是否调用。schema 确保参数格式正确。

### 6. 路由 — 条件边决定流向

**对应文件**: `src/graphs/reactAgent.ts` 的 `shouldContinue`

```typescript
function shouldContinue(state): "tools" | "human_review" | "__end__" {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = lastMsg.tool_calls;

  if (!toolCalls?.length) return END;           // 没有工具调用 → 结束
  if (hasHumanRequest(state)) return "human_review";  // 需要人工 → 暂停
  if (isTerminate(toolCalls)) return END;       // 调了 terminate → 结束
  return "tools";                               // 有工具要调 → 去执行
}
```

这就是 Agent 的"大脑"——不是 LLM 自己决定循环多少次，而是图的条件边控制。

---

## 工具层

上面只展示了 bash 作为示例。实际项目有 **18 个工具**，是 Agent 能力的核心来源。

**完整工具文档见 [tools.md](./tools.md)**，涵盖：
- 每个工具的设计原理、实现策略、关键约束
- bash 的持久会话 + 哨兵模式
- str_replace_editor 的唯一性检查 + FileOperator 抽象
- browser_use 的 DOM 索引系统（LLM 通过数字索引操作页面元素）
- web_search 的多引擎降级链
- crawl4ai 的 Playwright JS 渲染 vs fetch 静态双模式
- planningTool 的 7 命令 CRUD（LLM 可动态修改执行计划）
- MCP 动态工具加载（运行时从外部服务器发现新工具）
- VMind 智能图表流水线
- 4 个沙箱工具（tmux 会话、路径安全文件操作、截图 OCR）
- 不同 Agent 类型的工具组合策略

建议在理解完核心循环后，重点阅读 tools.md 的 bash、browser_use、planningTool 三个工具。

---

## 进阶概念

### Human-in-the-Loop (HITL)

当 Agent 需要人工输入时，用 `interrupt()` 暂停图：

```typescript
// src/nodes/humanReview.ts
function humanReviewNode(state) {
  const answer = interrupt({ question: "你想怎么处理？" });
  // interrupt() 在这里暂停整个图
  // 外部调用 Command({ resume: "用户的回答" }) 时继续
  return { messages: [new ToolMessage(answer)] };
}
```

**关键**：需要 Checkpointer 来保存暂停时的状态，需要 thread_id 来标识哪个对话。

### Planning Flow — 多 Agent 编排

**对应文件**: `src/graphs/planning.ts`

```
START → create_plan → select_step → execute_step → update_plan → select_step → ... → summarize → END
```

Planning Flow 是一个**外层图**，它的 `execute_step` 节点内部调用一个**子图**（某个 Agent）。选哪个 Agent 由步骤中的 `[TYPE]` 标签决定：

```
步骤: "[SWE] Fix the login bug"  → 选 SWE Agent
步骤: "[DATA] Analyze sales data" → 选 DataAnalysis Agent
步骤: "Search for documentation"  → 选默认 Manus Agent
```

### LLM 工厂 — 一行切换模型

**对应文件**: `src/config/llmFactory.ts`

```typescript
const model = await initChatModel("gpt-4o", { modelProvider: "openai" });
const model = await initChatModel("claude-sonnet-4-20250514", { modelProvider: "anthropic" });
```

`initChatModel` 是 LangChain 的统一工厂，自动加载对应 provider 包。config.toml 里改 `api_type` 就能切换。

---

## 数据流全链路

一次完整的对话流转：

```
用户: "列出当前目录文件"
  ↓
[State] messages: [HumanMessage("列出当前目录文件")]
  ↓
[think 节点] → 调 LLM → LLM 返回 AIMessage(tool_calls: [{name: "bash", args: {command: "ls"}}])
  ↓
[shouldContinue] → 有 tool_calls → 去 "tools"
  ↓
[tools 节点] → ToolNode 执行 bash("ls") → 返回 ToolMessage("file1.ts\nfile2.ts\n...")
  ↓
[State] messages: [Human, AI(tool_calls), Tool(result)]
  ↓
[think 节点] → 调 LLM → LLM 看到工具结果 → 返回 AIMessage("当前目录有以下文件: ...")
  ↓
[shouldContinue] → 没有 tool_calls → 去 END
  ↓
完成
```

关键理解：**LLM 不直接执行工具**。LLM 只输出"我想调用 bash 命令 ls"，由 ToolNode 真正执行，结果再反馈给 LLM。

---

## Web 层架构

```
浏览器 (React)                    API Server (Hono)              Agent (LangGraph)
     │                                  │                              │
     │  POST /api/chat {message}        │                              │
     ├─────────────────────────────────>│                              │
     │                                  │  graph.stream(input)         │
     │                                  ├─────────────────────────────>│
     │                                  │                              │
     │  SSE: event:thinking data:{...}  │  think 节点完成              │
     │<─────────────────────────────────│<─────────────────────────────│
     │                                  │                              │
     │  SSE: event:tool_call data:{...} │  LLM 返回 tool_calls        │
     │<─────────────────────────────────│<─────────────────────────────│
     │                                  │                              │
     │  SSE: event:tool_result data:{}  │  tools 节点完成              │
     │<─────────────────────────────────│<─────────────────────────────│
     │                                  │                              │
     │  SSE: event:done data:{threadId} │  图运行结束                  │
     │<─────────────────────────────────│<─────────────────────────────│
```

前端用 SSE（Server-Sent Events）接收流式更新，每个图节点完成时推一个事件。

**对应文件**:
- API: `server/index.ts` + `server/sse.ts`
- 前端: `web/src/api/client.ts`（SSE 解析）+ `web/src/hooks/useChat.ts`（状态管理）

---

## 关键文件速查

| 想了解什么 | 看哪个文件 | 行数 |
|-----------|-----------|------|
| Agent 怎么循环 | `src/graphs/reactAgent.ts` | ~200 |
| LLM 怎么被调用 | `src/nodes/think.ts` | ~100 |
| 工具怎么定义 | `src/tools/bash.ts` | ~200 |
| 状态怎么定义 | `src/state/agentState.ts` | ~30 |
| 怎么决定调哪个工具 | `src/graphs/reactAgent.ts` 的 `shouldContinue` | ~20 |
| 卡死怎么检测 | `src/nodes/checkStuck.ts` | ~40 |
| 人机交互怎么做 | `src/nodes/humanReview.ts` | ~50 |
| 多 Agent 怎么编排 | `src/graphs/planning.ts` | ~300 |
| Manus Agent 有什么工具 | `src/graphs/manus.ts` | ~50 |
| LLM 怎么切换 provider | `src/config/llmFactory.ts` | ~70 |
| API 怎么接 Agent | `server/index.ts` | ~170 |
| 前端怎么收 SSE | `web/src/api/client.ts` | ~100 |
| 前端聊天状态 | `web/src/hooks/useChat.ts` | ~110 |

---

## 动手实验

### 实验 1：跟踪一次工具调用

在 `src/nodes/think.ts` 的 `return { messages: [response] }` 前加一行：

```typescript
console.log("LLM response:", JSON.stringify(response.tool_calls, null, 2));
```

然后运行 `npx tsx src/index.ts "列出当前目录文件"`，观察 LLM 返回了什么 tool_calls。

### 实验 2：加一个自定义工具

在 `src/tools/` 下创建 `hello.ts`：

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const hello = tool(
  async ({ name }) => `Hello, ${name}! The current time is ${new Date().toLocaleTimeString()}.`,
  {
    name: "hello",
    description: "Greet someone and tell them the time.",
    schema: z.object({ name: z.string().describe("Name of the person to greet.") }),
  }
);
```

然后在 `src/graphs/manus.ts` 的 tools 数组里加上 `hello`，运行 `npx tsx src/index.ts "跟 Alice 打个招呼"`。

### 实验 3：观察 Planning Flow

运行：
```bash
npx tsx src/runFlow.ts "创建一个计算器 Python 脚本，然后测试它"
```

观察终端输出，看 Planning Flow 怎么把任务拆成多个步骤，每个步骤选择哪个 Agent 执行。

### 实验 4：启动 Web 界面

```bash
npm install              # 安装后端依赖
cd web && npm install     # 安装前端依赖
cd ..
npm run server           # 终端 1: 启动 API
npm run web              # 终端 2: 启动前端
```

打开 `http://localhost:5173`，在聊天框发消息，观察工具调用卡片的展开/折叠。

---

## 与原版 OpenManus 的对比

如果你读过 OpenManus Python 版，这是概念映射：

| Python (OpenManus) | TypeScript (本项目) | 为什么变了 |
|---|---|---|
| `BaseAgent` 类 + `run()` while 循环 | `StateGraph` + 条件边 | 图比循环更灵活（可视化、持久化、中断恢复） |
| `Memory.add_message()` 手动追加 | `messagesStateReducer` 自动追加 | 不会忘记加 message |
| `ToolCallAgent.act()` 80 行 | `ToolNode(tools)` 一行 | LangGraph 内置 |
| `BaseTool` 类继承 | `tool()` 函数 + zod | 更简洁，无类继承 |
| `PlanningTool` 内存 dict | `PlanStorage` + `tool()` | 一样，但 LLM 可以在执行中动态修改计划 |
| `AskHuman` 用 `input()` 阻塞 | `interrupt()` 非阻塞 | 支持 Web，不阻塞进程 |
| 无持久化 | `MemorySaver` / `PostgresSaver` | 对话可恢复 |
| 无 streaming | 3 种 stream mode | 实时看到 Agent 思考过程 |
| `LLM` 自定义类 | `initChatModel()` | 一行切换 20+ provider |

---

## 推荐学习路径

1. **今天**：读 `agentState.ts` + `reactAgent.ts` + `think.ts`，理解核心循环
2. **明天**：做实验 1 和 2，动手改代码
3. **第三天**：读 `planning.ts`，理解多 Agent 编排
4. **第四天**：读 `server/index.ts` + `web/src/hooks/useChat.ts`，理解 Web 层
5. **之后**：读 `docs/design.md` 的 Gap Analysis，看看还有什么没做完

有问题直接问我。
