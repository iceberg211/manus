# OpenManus → LangGraph TypeScript 重写设计文档

> 本文档是重写工作的**持久化上下文**。
> 每个实现阶段应先阅读本文档，而非依赖对话记忆。

---

## 目录

1. [架构概览](#1-架构概览)
2. [概念映射：OpenManus → LangGraph TS](#2-概念映射)
3. [状态设计](#3-状态设计)
4. [图设计](#4-图设计)
   - 4.1 ReAct Agent 图
   - 4.2 Planning Flow 图
5. [工具迁移参考](#5-工具迁移参考)
   - 5.1 PythonExecute
   - 5.2 Bash
   - 5.3 BrowserUseTool
   - 5.4 StrReplaceEditor
   - 5.5 WebSearch
   - 5.6 MCP 工具
6. [Agent 变体](#6-agent-变体)
   - 6.1 Manus（通用型）
   - 6.2 BrowserAgent
   - 6.3 SWEAgent
   - 6.4 DataAnalysis
7. [高级特性](#7-高级特性)
   - 7.1 人机协作（HITL）
   - 7.2 卡死检测
   - 7.3 Token 限制处理
   - 7.4 流式输出
   - 7.5 持久化
8. [文件结构](#8-文件结构)
9. [实现阶段](#9-实现阶段)
10. [差距分析：功能对等审计](#10-差距分析功能对等审计)
    - 10.1-10.6 初始审计（沙箱、文件操作、Planning、Terminate、Bedrock、Logger）
    - 10.7 其他差距 + **10.7b 新发现差距**（A2A、SandboxManus、沙箱工具、MCPAgent、Crawl4AI、VMind）
    - 10.8 完成度矩阵（修订版）
11. [Phase 7+：剩余工作](#11-phase-7-剩余工作)
    - Phase 7-P0：PlanningTool CRUD、BrowserUse DOM 索引
    - Phase 7a（P1）：Logger、文件操作符、沙箱终端/管理器、Crawl4AI、VMind、沙箱工具
    - Phase 7b（P2）：Bedrock、浏览器注入、Token 重试、A2A、SandboxManus、MCPAgent 刷新
    - Phase 7c（P3）：搜索引擎、异常、MCP Server
    - Phase 7d（P4）：Daytona、Computer Use

---

## 1. 架构概览

### OpenManus 原始架构

```
BaseAgent（状态机：IDLE→RUNNING→FINISHED）
  └── run() 循环：while step < max_steps && state != FINISHED
        └── step() = think() + act()

ReActAgent（抽象 think/act）
  └── ToolCallAgent（LLM 函数调用 + 工具执行）
        ├── Manus        （通用：python + bash + browser + editor + ask_human）
        ├── BrowserAgent （以浏览器为主，含截图上下文）
        ├── SWEAgent     （bash + editor）
        ├── DataAnalysis （python + 可视化）
        ├── MCPAgent     （动态 MCP 工具 + 定期刷新）
        └── SandboxManus （沙箱：sb_shell + sb_browser + sb_files + sb_vision）

PlanningFlow（多 Agent 编排）
  └── LLM 创建计划 → 逐步执行 → 选择 Agent → agent.run(步骤) → 标记完成
```

### LangGraph TS 目标架构

```
ReActAgentGraph（StateGraph，think→act 循环）
  ├── ManusGraph          （工具：code_execute, bash, browser, editor, web_search, crawl4ai）
  ├── SandboxManusGraph   （工具：sb_shell, sb_browser, sb_files, sb_vision）[第11节: 7b-6]
  ├── BrowserGraph        （工具：browser + 上下文注入节点）
  ├── SWEGraph            （工具：bash, editor）
  ├── DataGraph           （工具：code_execute, visualization/VMind）
  └── MCPAgentGraph       （工具：动态 MCP + 刷新机制）[第11节: 7b-8]

PlanningGraph（外层 StateGraph）
  └── create_plan → select_executor → execute_step(子图) → update_plan → 循环
      （执行器 Agent 可访问 PlanningTool 动态修改计划）[第11节: P0-1]
```

> **注意**：本节为初始设计。差距审计中发现了额外的 Agent 变体（SandboxManus、MCPAgent）和重要工具升级（DOM 索引、VMind、带 JS 渲染的 Crawl4AI）——完整情况见第10节和第11节。

---

## 2. 概念映射

| OpenManus（Python） | LangGraph TS | 备注 |
|---|---|---|
| `class BaseAgent(BaseModel)` | `StateGraph<AgentState>` | 无需类层次结构；图本身就是 Agent |
| `Memory`（消息列表） | `State.messages: MessagesValue` | 内置 reducer 自动追加 |
| `AgentState` 枚举（IDLE/RUNNING/FINISHED） | `state.status` 字段 + 条件边到 END | 更简洁 |
| `BaseAgent.run()` while 循环 | 图循环：通过条件边 think→act→think | 图负责迭代 |
| `ReActAgent.step() = think() + act()` | 两个节点：`think` + `tools`，带边 | |
| `ToolCallAgent.think()` | `think` 节点：调用 `model.invoke(messages)` | |
| `ToolCallAgent.act()` | `ToolNode(tools, { handleToolErrors: true })` | 一行代码替代约 80 行 |
| `ToolCollection.to_params()` | `model.bindTools(tools)` | LangChain 处理 schema |
| `BaseTool` 子类 | `@langchain/core/tools` 的 `tool()` | 装饰器/函数模式 |
| `ToolResult` | 返回 `string` 或 `ToolMessage` | LangGraph ToolNode 处理封装 |
| `PlanningFlow` | 外层 `StateGraph<PlanState>` | 每种 Agent 类型用子图 |
| `PlanningTool`（内存 CRUD） | `state.plan` 字段 + 更新节点 → **Phase 7 P0-1：迁移为 LLM 可调用工具** | 当前：仅状态；目标：7 命令 CRUD 工具 |
| `Terminate` 工具 | 条件边返回 `END` | 不需要工具 |
| `AskHuman` 工具 | `interrupt()` + `Command({ resume })` | 非阻塞，可持久化 |
| `is_stuck()` | 在 `think` 节点中检查，注入提示 | 相同逻辑，不同位置 |
| `max_steps` | 编译配置中的 `recursion_limit` | 内置 |
| `config.toml` | `RunnableConfig.configurable` | 运行时注入 |
| `LLM` 单例 | `ChatOpenAI` / `ChatAnthropic` 实例 | LangChain 模型类 |
| `LLM.ask_tool()` | `model.bindTools(tools).invoke(messages)` | 内置 |
| Token 计数 | `model.getNumTokens()` 或 tiktoken | 按模型而定 |

### TypeScript 特有 API 差异

| Python LangGraph | TypeScript LangGraph |
|---|---|
| `TypedDict` + `Annotated[list, operator.add]` | `StateSchema` + `MessagesValue` / `ReducedValue` |
| `add_messages` reducer | `MessagesValue`（内置） |
| `Command[Literal["a","b"]]` 返回类型 | `addNode("name", fn, { ends: ["a","b"] })` |
| `graph.invoke(input, config)` | `await graph.invoke(input, config)`（Promise） |
| `for chunk in graph.stream(...)` | `for await (const chunk of graph.stream(...))` |
| `InMemorySaver()` | `new MemorySaver()` |
| `def node(state, runtime: Runtime)` | `async (state, config) => {...}` |

---

## 3. 状态设计

### 3.1 AgentState（用于 ReAct Agent 图）

```typescript
import { StateSchema, MessagesValue, ReducedValue } from "@langchain/langgraph";
import { z } from "zod";

const AgentState = new StateSchema({
  // 核心：对话历史（通过 reducer 自动追加）
  messages: MessagesValue,

  // 控制：Agent 状态
  status: z.enum(["running", "finished", "stuck"]).default("running"),

  // 浏览器：上次浏览器操作的截图（如有）
  currentScreenshot: z.string().optional(),

  // 元数据
  stepCount: z.number().default(0),
});
```

**设计决策：**
- `messages` 使用 `MessagesValue`——这是关键。OpenManus 到处手动调用 `memory.add_message()`；此处 reducer 自动完成。
- `status` 替代 `AgentState` 枚举。条件边检查此字段以路由到 END。
- `stepCount` 用于卡死检测。`recursion_limit` 处理 max_steps。
- 不需要 `tool_calls` 字段——LangGraph 的 `ToolNode` 直接从最后一条 AIMessage 读取 tool_calls。

### 3.2 PlanState（用于 Planning Flow 图）

```typescript
const PlanStep = z.object({
  text: z.string(),
  status: z.enum(["not_started", "in_progress", "completed", "blocked"]),
  notes: z.string().default(""),
  type: z.string().optional(), // "swe", "data", "browser" 等
});

const PlanState = new StateSchema({
  messages: MessagesValue,
  plan: z.object({
    title: z.string(),
    steps: z.array(PlanStep),
  }).optional(),
  currentStepIndex: z.number().default(-1),
  executorType: z.string().default("manus"),
  stepResults: new ReducedValue(
    z.array(z.string()).default(() => []),
    { reducer: (curr, upd) => curr.concat(upd) },
  ),
});
```

---

## 4. 图设计

### 4.1 ReAct Agent 图

```
START → think ──有工具调用?──→ tools ──→ think（循环）
                    │ 无工具调用 / terminate
                    ↓
                   END
```

```typescript
// 伪代码结构
const builder = new StateGraph(AgentState)
  .addNode("think", thinkNode)
  .addNode("tools", toolNode)
  .addEdge(START, "think")
  .addConditionalEdges("think", shouldContinue, ["tools", END])
  .addEdge("tools", "think");

const graph = builder.compile({ checkpointer: new MemorySaver() });
```

**`think` 节点行为**（译自 `app/agent/toolcall.py:39-129` 的 `ToolCallAgent.think()`）：
1. 用当前消息 + 系统提示 + 绑定工具调用 LLM
2. LLM 返回带可选 `tool_calls` 的 `AIMessage`
3. 返回 `{ messages: [response] }`——reducer 自动追加
4. 条件边检查：有 tool_calls？是 terminate？→ 路由

**`tools` 节点行为**（译自 `app/agent/toolcall.py:131-164` 的 `ToolCallAgent.act()`）：
- `@langchain/langgraph/prebuilt` 的 `ToolNode` 处理一切：
  - 从最后一条 AIMessage 读取 `tool_calls`
  - 执行每个工具
  - 返回 `ToolMessage` 结果
  - 出错时：以 ToolMessage 形式返回错误（LLM 可重试）

**路由函数**（译自 `_handle_special_tool` + 返回逻辑）：
```typescript
function shouldContinue(state: typeof AgentState.State): string {
  const lastMessage = state.messages[state.messages.length - 1];

  // 无工具调用 → 结束
  if (!lastMessage.tool_calls?.length) return END;

  // 调用了 terminate 工具 → 结束
  if (lastMessage.tool_calls.some(tc => tc.name === "terminate")) return END;

  // 状态为 finished（如 token 限制）→ 结束
  if (state.status === "finished") return END;

  return "tools";
}
```

### 4.2 Planning Flow 图

```
START → create_plan → select_executor ──→ execute_step → update_plan → select_executor
                                │                                         （循环）
                           全部完成?
                                ↓ 是
                           summarize → END
```

**`create_plan` 节点**（译自 `app/flow/planning.py:136-211` 的 `PlanningFlow._create_initial_plan`）：
- 用 planning 系统提示调用 LLM
- 将响应解析为结构化计划（标题 + 步骤）
- 存入 `state.plan`

**`select_executor` 节点**（译自 `app/flow/planning.py:213-275` 的 `PlanningFlow._get_current_step_info`）：
- 找到第一个状态为 `not_started` 或 `in_progress` 的步骤
- 从步骤文本的 `[TYPE]` 标签提取步骤类型
- 返回 `Command({ update: { currentStepIndex, executorType }, goto: "execute_step" })`
- 无活跃步骤时：`Command({ goto: "summarize" })`

**`execute_step` 节点**（译自 `app/flow/planning.py:277-304` 的 `PlanningFlow._execute_step`）：
- 根据 `executorType` 选择合适的子图
- 用步骤上下文调用子图
- 返回结果

**`update_plan` 节点**（译自 `app/flow/planning.py:306-335` 的 `PlanningFlow._mark_step_completed`）：
- 将当前步骤标记为"completed"
- 返回更新后的计划

---

## 5. 工具迁移参考

### 核心原则
> 工具内部实现可直接翻译。只有外层包装改变：
> `BaseTool` 子类 → `@langchain/core/tools` 的 `tool()` 函数。

### 5.1 PythonExecute

**来源**：`app/tool/python_execute.py`（76 行）

**行为**：
- 接受 `code: string` 和 `timeout: number = 5`
- 通过子进程执行（Python 用 `multiprocessing`）
- 只捕获 `print()` 输出，**不**捕获返回值
- 超时：N 秒后杀死进程
- 返回 `{ observation: string, success: boolean }`

**TS 实现注意事项**：
- 使用带超时的 `child_process.execSync` 或 `child_process.spawn`
- 写入临时文件 → 用 `python3` 执行 → 捕获 stdout
- 替代方案：使用 `vm` 模块执行 JS 代码而非 Python
- 如果保留 Python 执行：用超时 spawn `python3 -c "code"`

```typescript
// 骨架代码
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const codeExecute = tool(
  async ({ code, timeout = 5 }) => {
    const tmpFile = join(tmpdir(), `exec_${Date.now()}.py`);
    try {
      writeFileSync(tmpFile, code);
      const result = execSync(`python3 ${tmpFile}`, {
        timeout: timeout * 1000,
        encoding: "utf-8",
      });
      return result || "代码执行成功（无输出）";
    } catch (e: any) {
      if (e.killed) return `执行超时，超过 ${timeout} 秒`;
      return `错误: ${e.stderr || e.message}`;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  },
  {
    name: "code_execute",
    description: "执行 Python 代码。只有 print 输出可见，返回值不被捕获。使用 print() 查看结果。",
    schema: z.object({
      code: z.string().describe("要执行的 Python 代码"),
      timeout: z.number().default(5).describe("超时时间（秒）"),
    }),
  }
);
```

### 5.2 Bash

**来源**：`app/tool/bash.py`（158 行）

**行为**：
- **持久会话**：跨调用维护一个 `/bin/bash` 进程
- 命令在同一个 shell 中执行（cd、环境变量持久化）
- 使用哨兵模式：追加 `; echo '<<exit>>'` 来检测输出结束
- 直接从 stdout 缓冲区读取（非 readline，避免等待 EOF）
- 每条命令 120 秒超时
- 支持：空命令（查看日志）、`ctrl+c`（中断）、重启
- 返回 `CLIResult { output, error }`

**TS 实现注意事项**：
- 使用带 stdin/stdout 管道的 `child_process.spawn("/bin/bash")`
- 保持对 spawned 进程的引用（单例）
- 向 stdin 写入命令 + 哨兵
- 读取 stdout 直到找到哨兵
- 用 `setTimeout` + 进程 kill 处理超时

```typescript
// 骨架代码——关键在持久会话
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";

class BashSession {
  private process: ChildProcess | null = null;
  private outputBuffer = "";
  private sentinel = "<<exit>>";
  private timeout = 120_000; // ms

  async start() {
    this.process = spawn("/bin/bash", {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout?.on("data", (data) => {
      this.outputBuffer += data.toString();
    });
  }

  async run(command: string): Promise<{ output: string; error: string }> {
    if (!this.process) await this.start();
    this.outputBuffer = "";
    this.process!.stdin!.write(`${command}; echo '${this.sentinel}'\n`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超时")), this.timeout);
      const check = setInterval(() => {
        if (this.outputBuffer.includes(this.sentinel)) {
          clearInterval(check);
          clearTimeout(timer);
          const output = this.outputBuffer.split(this.sentinel)[0].trimEnd();
          resolve({ output, error: "" });
        }
      }, 200);
    });
  }
}

const session = new BashSession();

const bash = tool(
  async ({ command }) => {
    const result = await session.run(command);
    return result.output || result.error || "命令执行完成（无输出）";
  },
  {
    name: "bash",
    description: `在持久终端会话中执行 bash 命令。
* 长时间运行的命令应在后台执行：command = 'python3 app.py > server.log 2>&1 &'
* 环境和工作目录在调用间持久化
* 超时：120 秒`,
    schema: z.object({
      command: z.string().describe("要执行的 bash 命令"),
    }),
  }
);
```

### 5.3 BrowserUseTool

**来源**：`app/tool/browser_use_tool.py`（568 行）

**行为**：
- 16 个动作，由 `action` 参数（向 LLM 暴露的枚举）调度：
  - 导航：`go_to_url`、`go_back`、`web_search`
  - 交互：`click_element`、`input_text`、`send_keys`
  - 滚动：`scroll_down`、`scroll_up`、`scroll_to_text`
  - 下拉框：`get_dropdown_options`、`select_dropdown_option`
  - 内容：`extract_content`（使用 LLM 子调用从页面 markdown 提取）
  - 标签页：`switch_tab`、`open_tab`、`close_tab`
  - 工具：`wait`
  - 注意：`refresh` 在 execute() 中处理，但**不在**参数枚举中——LLM 无法调用它
- 懒初始化：第一次调用时创建浏览器
- `asyncio.Lock` 防止并发浏览器操作
- 使用 `browser-use` 库（Playwright 包装器）
- `get_current_state()` 返回：截图(base64) + URL + 标签页 + 可交互元素 + 滚动信息
- `extract_content` 内部用页面内容调用 LLM 提取结构化数据

**TS 实现注意事项**：
- **推荐**：使用 npm `browser-use`（v0.6.0+）——TS 优先库，带 DomService 用于元素索引（详见 P0-2）
- 当前 TS 实现使用原生 Playwright（无 DOM 索引）——P0-2 将升级到 browser-use
- 浏览器实例作为单例保持
- 锁机制：简单的 mutex promise
- `extract_content`：用 markdownified 页面内容调用 LLM
- 截图：`page.screenshot({ type: "jpeg", fullPage: true })` → base64

**决策**：这是最复杂的工具。两个选项：
1. **选项 A**：将完整 16 动作工具翻译到 TS（使用 Playwright）
2. **选项 B**：使用更简单的包装器——只保留最常用的动作（go_to_url, click, input, extract, search）

**推荐**：选项 A 以实现完整对等，但增量实现。

```typescript
// 骨架代码——只展示结构，不含完整 16 个动作
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { chromium, Browser, Page, BrowserContext } from "playwright";

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private mutex = Promise.resolve();

  async ensureInitialized() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: false });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
    }
    return this.page!;
  }

  async execute(action: string, params: Record<string, any>): Promise<string> {
    // Mutex 防止并发操作
    return new Promise((resolve) => {
      this.mutex = this.mutex.then(async () => {
        const page = await this.ensureInitialized();
        switch (action) {
          case "go_to_url":
            await page.goto(params.url);
            await page.waitForLoadState();
            resolve(`已导航到 ${params.url}`);
            break;
          case "click_element":
            // ... 基于索引的点击（使用 DOM service）
            break;
          case "extract_content":
            // ... markdownify + LLM 提取
            break;
          // ... 其他 13 个动作
          default:
            resolve(`未知动作：${action}`);
        }
      });
    });
  }

  async getState(): Promise<{ screenshot: string; url: string; /* ... */ }> {
    const page = await this.ensureInitialized();
    const screenshot = await page.screenshot({ type: "jpeg", fullPage: true });
    return {
      screenshot: screenshot.toString("base64"),
      url: page.url(),
    };
  }

  async cleanup() {
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

const browserManager = new BrowserManager();

const browserUse = tool(
  async ({ action, url, index, text, scrollAmount, query, goal, keys, seconds, tabId }) => {
    return browserManager.execute(action, { url, index, text, scrollAmount, query, goal, keys, seconds, tabId });
  },
  {
    name: "browser_use",
    description: `浏览器自动化工具。动作：go_to_url, click_element, input_text, scroll_down, scroll_up, scroll_to_text, send_keys, get_dropdown_options, select_dropdown_option, go_back, web_search, wait, extract_content, switch_tab, open_tab, close_tab。`,
    schema: z.object({
      action: z.enum([
        "go_to_url", "click_element", "input_text", "scroll_down", "scroll_up",
        "scroll_to_text", "send_keys", "get_dropdown_options", "select_dropdown_option",
        "go_back", "web_search", "wait", "extract_content", "switch_tab", "open_tab", "close_tab",
      ]),
      url: z.string().optional(),
      index: z.number().optional(),
      text: z.string().optional(),
      scrollAmount: z.number().optional(),
      tabId: z.number().optional(),
      query: z.string().optional(),
      goal: z.string().optional(),
      keys: z.string().optional(),
      seconds: z.number().optional(),
    }),
  }
);
```

### 5.4 StrReplaceEditor

**来源**：`app/tool/str_replace_editor.py`（433 行）

**行为**：
- 5 个命令：`view`、`create`、`str_replace`、`insert`、`undo_edit`
- `view`：文件 → 带行号的 `cat -n`；目录 → `find -maxdepth 2`
- `create`：仅当文件**不存在**时创建（不可覆盖）
- `str_replace`：`old_str` 必须在文件中**恰好出现一次**；替换为 `new_str`
- `insert`：在 `insert_line` **之后**插入 `new_str`
- `undo_edit`：从 `_file_history` 栈弹出，恢复上一版本
- 输出截断为 16000 字符
- 支持本地文件系统和 Docker 沙箱（通过 `FileOperator` 接口）

**TS 实现注意事项**：
- 使用 `fs/promises` 进行文件操作
- `_file_history`：`Map<string, string[]>`——相同的栈模式
- `str_replace` 唯一性检查：`content.split(old_str).length - 1 === 1`
- 行号格式化：`lines.map((l, i) => \`${i+1}\\t${l}\`).join("\\n")`
- 初期不需要沙箱支持（后续添加）

```typescript
const strReplaceEditor = tool(
  async ({ command, path, fileText, oldStr, newStr, insertLine, viewRange }) => {
    // 实现直接翻译 Python 逻辑
    switch (command) {
      case "view": {
        const stat = await fs.stat(path);
        if (stat.isDirectory()) {
          const { stdout } = await exec(`find ${path} -maxdepth 2 -not -path '*/\\.*'`);
          return stdout;
        }
        let content = await fs.readFile(path, "utf-8");
        if (viewRange) {
          const lines = content.split("\n");
          content = lines.slice(viewRange[0] - 1, viewRange[1] === -1 ? undefined : viewRange[1]).join("\n");
        }
        return formatWithLineNumbers(content, path);
      }
      case "create": { /* ... */ }
      case "str_replace": { /* ... 唯一性检查 ... */ }
      case "insert": { /* ... */ }
      case "undo_edit": { /* ... 从历史栈弹出 ... */ }
    }
  },
  {
    name: "str_replace_editor",
    description: `文件编辑器：view、create、str_replace、insert、undo_edit。
* str_replace：old_str 必须在文件中恰好匹配一次
* create：不能覆盖已有文件
* undo_edit：撤销上次编辑`,
    schema: z.object({
      command: z.enum(["view", "create", "str_replace", "insert", "undo_edit"]),
      path: z.string().describe("文件或目录的绝对路径"),
      fileText: z.string().optional().describe("create 命令的内容"),
      oldStr: z.string().optional().describe("str_replace 要查找的字符串"),
      newStr: z.string().optional().describe("替换字符串"),
      insertLine: z.number().optional().describe("insert 的行号（0 起始，在此行**之后**插入）"),
      viewRange: z.array(z.number()).optional().describe("view 的行范围 [start, end]（1 起始）"),
    }),
  }
);
```

### 5.5 WebSearch

**来源**：`app/tool/web_search.py`（418 行）

**行为**：
- 多引擎：Google → Bing → DuckDuckGo → Baidu（配置中的优先顺序）
- 每个引擎：3 次重试，指数退避
- 所有引擎失败：等待 `retry_delay`（60秒），再重试最多 `max_retries`（3）次
- 可选 `fetch_content`：获取页面，用 BeautifulSoup 去除 HTML，截断至 10000 字符
- 返回结构化 `SearchResponse`：query、results[]、metadata
- 每条结果：position、url、title、description、raw_content

**TS 实现注意事项**：
- Google：使用 `google-it` 或 `serpapi` npm 包
- DuckDuckGo：使用 `duck-duck-scrape`
- Bing：使用 Bing Search API
- 内容获取：`cheerio`（Node.js 的 BeautifulSoup 等价物）
- 降级链：相同的逐引擎尝试逻辑

```typescript
const webSearch = tool(
  async ({ query, numResults = 5, fetchContent = false }) => {
    // 按顺序尝试引擎，带降级
    const engines = ["google", "duckduckgo", "bing"];
    for (const engine of engines) {
      try {
        const results = await searchWithEngine(engine, query, numResults);
        if (results.length > 0) {
          if (fetchContent) {
            await Promise.all(results.map(r => fetchPageContent(r)));
          }
          return formatResults(query, results);
        }
      } catch (e) { continue; }
    }
    return `未找到相关结果：${query}`;
  },
  {
    name: "web_search",
    description: "搜索网络获取实时信息。返回标题、URL、描述，以及可选的完整页面内容。",
    schema: z.object({
      query: z.string().describe("搜索查询"),
      numResults: z.number().default(5).describe("结果数量"),
      fetchContent: z.boolean().default(false).describe("是否获取完整页面内容"),
    }),
  }
);
```

### 5.6 MCP 工具

**来源**：`app/tool/mcp.py`（195 行）

**行为**：
- 通过 SSE 或 stdio 连接 MCP 服务器
- 列出服务器可用工具 → 为每个工具创建 `MCPClientTool` 代理
- 工具名称：`mcp_{server_id}_{original_name}`（净化为 `[a-zA-Z0-9_-]`，最长 64 字符）
- 执行：`session.call_tool(original_name, kwargs)` → 提取 TextContent
- 同时支持多个服务器
- `AsyncExitStack` 管理连接生命周期

**TS 实现注意事项**：
- 使用 `@modelcontextprotocol/sdk` npm 包（官方 MCP TS SDK）
- 使用 `Client` 类连接 MCP 服务器
- 将每个 MCP 工具转换为 LangChain `StructuredTool`
- 启动时动态注册工具

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StructuredTool } from "@langchain/core/tools";

async function loadMCPTools(serverConfig: MCPServerConfig): Promise<StructuredTool[]> {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
  });
  const client = new Client({ name: "openmanus", version: "1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  return tools.map(mcpTool => {
    // 将 MCP 工具 schema 转换为 LangChain 工具
    return new DynamicStructuredTool({
      name: sanitizeName(`mcp_${serverConfig.id}_${mcpTool.name}`),
      description: mcpTool.description || "",
      schema: zodFromJsonSchema(mcpTool.inputSchema), // JSON Schema → Zod
      func: async (input) => {
        const result = await client.callTool({ name: mcpTool.name, arguments: input });
        return result.content.map(c => c.text).join(", ");
      },
    });
  });
}
```

> **注意**：本节涵盖初始设计中的 5.1-5.6 工具。差距审计中发现需要大量重写的工具记录在第11节：
> - **Crawl4AI**（fetch+cheerio → Playwright JS 渲染）：第11节，7a-6
> - **ChartVisualization**（matplotlib 包装器 → VMind 流水线）：第11节，7a-7
> - **BrowserUseTool DOM 索引**：第11节，P0-2
> - **沙箱工具**（sb_shell、sb_browser、sb_files、sb_vision）：第11节，7a-8
> - **PlanningTool**（仅状态 → LLM 可调用 CRUD）：第11节，P0-1

---

## 6. Agent 变体

### 6.1 Manus（通用型）

**来源**：`app/agent/manus.py`（166 行）

**工具**：PythonExecute、BrowserUseTool、StrReplaceEditor、AskHuman、Terminate
**系统提示**："You are OpenManus, an all-capable AI assistant..."
**最大步数**：20
**最大观察**：10000 字符（截断工具输出）
**特别**：MCP 工具集成、浏览器上下文注入

**LangGraph TS**：带 Manus 特定工具和系统提示的 `buildReactAgent()`。

```typescript
const manusGraph = buildReactAgent({
  tools: [codeExecute, bash, browserUse, strReplaceEditor, webSearch, ...mcpTools],
  systemPrompt: MANUS_SYSTEM_PROMPT,
  maxObserve: 10000,
  recursionLimit: 40, // 20 步 ≈ 40 次图迭代（think+act 各一次）
});
```

### 6.2 BrowserAgent

**来源**：`app/agent/browser.py`

**特殊行为**：
- `BrowserContextHelper` 检查浏览器是否最近被使用
- 如果是：将当前浏览器状态（截图、URL、标签页、元素）注入下一个提示
- 截图作为 base64 图片发送到消息中

**LangGraph TS**：在 `think` 之前添加 `prepare_context` 节点，检查最近消息中的浏览器使用情况并注入状态。

```typescript
// 图中：START → prepare_context → think → tools → prepare_context（循环）
function prepareContext(state: typeof AgentState.State) {
  const recentMessages = state.messages.slice(-3);
  const browserUsed = recentMessages.some(m =>
    m.tool_calls?.some(tc => tc.name === "browser_use")
  );
  if (browserUsed) {
    const browserState = await browserManager.getState();
    return {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `当前浏览器状态：URL=${browserState.url}...` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` } },
        ],
      }],
    };
  }
  return {}; // 无需更新
}
```

### 6.3 SWEAgent

**来源**：`app/agent/swe.py`
**工具**：Bash、StrReplaceEditor、Terminate
**系统提示**：面向软件工程的提示

```typescript
const sweGraph = buildReactAgent({
  tools: [bash, strReplaceEditor],
  systemPrompt: SWE_SYSTEM_PROMPT,
  recursionLimit: 60,
});
```

### 6.4 DataAnalysis

**来源**：`app/agent/data_analysis.py`
**Python 工具**：NormalPythonExecute、VisualizationPrepare、DataVisualization、Terminate（无 Bash）

```typescript
const dataGraph = buildReactAgent({
  tools: [codeExecute, bash, visualizationPrepare, chartVisualization],
  // 注意：`bash` 是 TS 新增（Python DataAnalysis 没有 Bash 工具）。
  // 添加用于支持数据预处理 shell 命令（如 csvtool、head、wc）。
  systemPrompt: DATA_ANALYSIS_SYSTEM_PROMPT(workDir),
  nextStepPrompt: DATA_ANALYSIS_NEXT_STEP_PROMPT,
  maxObserve: 15000, // 匹配 DataAnalysis.max_observe
  recursionLimit: 40,
});
```

> **注意**：当前 `visualizationPrepare` 和 `chartVisualization` 是简化的包装器（matplotlib 执行）。Phase 7a-7 将升级为完整的 VMind 流水线，支持智能图表推荐和 Insight 系统。

> **注意**：本节涵盖初始设计中的 4 个 Agent 变体。差距审计中发现的其他变体：
> - **SandboxManus**（`app/agent/sandbox_agent.py`）：独立 Agent，使用 Daytona 沙箱 + 4 个沙箱特定工具——第11节，7b-6
> - **MCPAgent**（`app/agent/mcp.py`）：以 MCP 为主的 Agent，支持动态工具刷新、schema 变化检测、服务关闭感知——第11节，7b-8

---

## 7. 高级特性

### 7.1 人机协作（HITL）

**OpenManus**：`AskHuman` 工具 → `input()` 阻塞进程（同步，仅 CLI）
**LangGraph TS**：`interrupt()` → 图暂停 → 外部系统用 `Command({ resume })` 恢复

```typescript
// 在 think 节点中：检测 ask_human 工具调用 → interrupt
function thinkNode(state: typeof AgentState.State) {
  const response = await model.invoke(state.messages);
  const toolCalls = response.tool_calls || [];

  for (const tc of toolCalls) {
    if (tc.name === "ask_human") {
      const humanAnswer = interrupt({
        question: tc.args.inquire,
        context: "Agent 需要人工输入",
      });
      // 恢复后，humanAnswer 是用户的回答
      return {
        messages: [
          response,
          new ToolMessage({ content: humanAnswer, tool_call_id: tc.id }),
        ],
      };
    }
  }
  return { messages: [response] };
}

// 外部调用方：
const result = await graph.invoke(input, config);
if (result.__interrupt__) {
  // 向用户展示问题，获取答案，然后：
  const resumed = await graph.invoke(new Command({ resume: userAnswer }), config);
}
```

### 7.2 卡死检测

**OpenManus**：`app/agent/base.py:170-186` 的 `BaseAgent.is_stuck()`
- 统计连续相同的 assistant 消息
- 阈值：2 次重复
- 操作：在 `next_step_prompt` 前添加策略更改提示

**LangGraph TS**：在 `think` 节点或独立的 `checkStuck` 节点中检查。

```typescript
function checkStuck(state: typeof AgentState.State): string {
  const aiMessages = state.messages
    .filter(m => m._getType() === "ai" && m.content)
    .slice(-4);

  if (aiMessages.length >= 2) {
    const last = aiMessages[aiMessages.length - 1].content;
    const prev = aiMessages[aiMessages.length - 2].content;
    if (last === prev) {
      // 带策略更改注入返回到 think
      return "inject_unstuck";
    }
  }
  return "think";
}

function injectUnstuck(state: typeof AgentState.State) {
  return {
    messages: [new HumanMessage(
      "你在重复自己。请考虑新策略，避免重复低效路径。"
    )],
  };
}
```

### 7.3 Token 限制处理

**OpenManus**：`LLM.check_token_limit()` 抛出 `TokenLimitExceeded` → 在 `think()` 中捕获 → FINISHED

**LangGraph TS**：在 think 节点中 try/catch → 将状态设为 "finished" → 条件边路由到 END。

```typescript
async function thinkNode(state: typeof AgentState.State) {
  try {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  } catch (e: any) {
    if (e.message?.includes("token") || e.code === "context_length_exceeded") {
      return {
        messages: [new AIMessage("已达到 Token 限制，停止执行。")],
        status: "finished",
      };
    }
    throw e;
  }
}
```

### 7.4 流式输出

**OpenManus**：不支持流式输出。
**LangGraph TS**：内置，4 种模式。

```typescript
// 为聊天 UI 流式传输 LLM tokens
for await (const chunk of graph.stream(input, { ...config, streamMode: "messages" })) {
  const [token, metadata] = chunk;
  if (token.content) process.stdout.write(token.content);
}

// 为进度追踪流式传输状态更新
for await (const chunk of graph.stream(input, { ...config, streamMode: "updates" })) {
  console.log("节点完成：", Object.keys(chunk));
}

// 在节点内部发送自定义进度事件
import { getWriter } from "@langchain/langgraph";
function myNode(state) {
  const writer = getWriter();
  writer({ type: "progress", step: "搜索中..." });
  // ...
}
```

### 7.5 持久化

**OpenManus**：无持久化。进程退出时 Agent 状态丢失。
**LangGraph TS**：Checkpointer 在每一步保存完整状态。

```typescript
// 开发环境
import { MemorySaver } from "@langchain/langgraph";
const graph = builder.compile({ checkpointer: new MemorySaver() });

// 生产环境
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
const checkpointer = PostgresSaver.fromConnString("postgresql://...");
await checkpointer.setup();
const graph = builder.compile({ checkpointer });

// 使用——thread_id 隔离对话
const config = { configurable: { thread_id: "user-123-session-1" } };
await graph.invoke(input, config);

// 崩溃/重启后恢复——自动恢复状态
await graph.invoke(newInput, config); // 从上次中断处继续

// 时间旅行——检查/重放过去状态
for await (const state of graph.getStateHistory(config)) {
  console.log(state.values, state.createdAt);
}
```

---

## 8. 文件结构

> 当前已实现（34 个文件）+ Phase 7 计划文件标注 `[P0/P1/P2]`。

```
openmanus-langgraph-ts/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # 主入口（3 种流式模式 + HITL）
│   ├── runFlow.ts                # Planning flow 入口
│   │
│   ├── state/
│   │   ├── agentState.ts         # AgentState schema
│   │   └── planState.ts          # PlanState schema
│   │
│   ├── tools/
│   │   ├── index.ts              # 统一工具导出
│   │   ├── codeExecute.ts        # Python 代码执行
│   │   ├── bash.ts               # 持久 bash 会话
│   │   ├── browserUse.ts         # 浏览器自动化（Playwright）——[P0] 添加 DOM 索引
│   │   ├── strReplaceEditor.ts   # 文件编辑——[P1] 切换到 FileOperator
│   │   ├── webSearch.ts          # DuckDuckGo 搜索
│   │   ├── crawl4ai.ts           # 网页爬取——[P1] 用 Playwright JS 渲染重写
│   │   ├── chartVisualization.ts # 图表工具——[P1] 用 VMind 流水线重写
│   │   ├── askHuman.ts           # HITL 工具 schema
│   │   ├── terminate.ts          # 终止信号
│   │   ├── mcpTools.ts           # MCP 动态工具加载
│   │   ├── planningTool.ts       # [P0] LLM 可调用 CRUD（7 命令）
│   │   ├── fileOperators.ts      # [P1] FileOperator 接口 + 本地/沙箱实现
│   │   └── sandbox/              # [P1] 沙箱特定工具
│   │       ├── sbShellTool.ts    #   基于 tmux 的持久化 shell
│   │       ├── sbBrowserTool.ts  #   Daytona 浏览器自动化
│   │       ├── sbFilesTool.ts    #   沙箱文件操作 + 路径边界
│   │       └── sbVisionTool.ts   #   OCR / 截图分析
│   │
│   ├── graphs/
│   │   ├── reactAgent.ts         # buildReactAgent() 工厂（含 HITL）
│   │   ├── manus.ts              # 通用 Agent
│   │   ├── swe.ts                # 软件工程 Agent
│   │   ├── dataAnalysis.ts       # 数据分析 Agent
│   │   ├── planning.ts           # 多 Agent 编排
│   │   ├── browser.ts            # [P2] 带上下文注入的浏览器 Agent
│   │   └── sandboxManus.ts       # [P2] 沙箱 Agent（Daytona + 沙箱工具）
│   │
│   ├── nodes/
│   │   ├── think.ts              # LLM 推理节点
│   │   ├── checkStuck.ts         # 卡死检测
│   │   ├── humanReview.ts        # interrupt() HITL
│   │   └── prepareContext.ts     # [P2] 浏览器状态注入节点
│   │
│   ├── prompts/
│   │   ├── index.ts              # 统一导出 + toolcall/mcp 提示
│   │   ├── manus.ts, swe.ts, dataAnalysis.ts, planning.ts
│   │
│   ├── config/
│   │   ├── constants.ts          # 集中式常量
│   │   ├── index.ts              # TOML 配置加载
│   │   └── persistence.ts        # Checkpointer、thread、Store
│   │
│   ├── sandbox/
│   │   ├── docker.ts             # 容器生命周期——[P1] 添加 Terminal + Manager
│   │   ├── terminal.ts           # [P1] 容器内交互式 bash 会话
│   │   ├── manager.ts            # [P1] 沙箱池 + 生命周期管理
│   │   └── index.ts
│   │
│   ├── utils/
│   │   ├── logger.ts             # [P1] 全局结构化日志
│   │   └── errors.ts             # [P3] 类型化异常层次
│   │
│   └── a2a/                      # [P2] A2A 协议服务端
│       ├── server.ts             #   HTTP 端点（Express/Fastify）
│       ├── agent.ts              #   A2AManus 包装器
│       └── executor.ts           #   AgentExecutor + TaskStore
│
├── config/
│   ├── config.example.toml
│   └── mcp.json
│
└── tests/
    ├── tools/
    ├── graphs/
    └── integration/
```

---

## 9. 实现阶段

### Phase 1：骨架 + 最简 ReAct Agent
**目标**：一个可用的 think→tools→think 循环，包含一个工具。
**文件**：`state/agentState.ts`、`tools/bash.ts`、`graphs/reactAgent.ts`、`index.ts`
**验证**：可以执行 `bash("ls -la")` 并获得结果。
**OpenManus 参考**：`app/agent/base.py`、`app/agent/react.py`、`app/agent/toolcall.py`、`app/tool/bash.py`

### Phase 2：迁移核心工具
**目标**：5 个核心工具全部可用。
**文件**：`tools/*.ts`
**验证**：每个工具独立可用，并通过 Agent 图可用。
**OpenManus 参考**：`app/tool/python_execute.py`、`app/tool/bash.py`、`app/tool/browser_use_tool.py`、`app/tool/str_replace_editor.py`、`app/tool/web_search.py`

### Phase 3：Manus Agent + 提示词
**目标**：完整的 Manus Agent 等价实现。
**文件**：`graphs/manus.ts`、`prompts/manus.ts`、`nodes/checkStuck.ts`
**验证**：可以处理多步任务（如"搜索 X 并保存到文件"）。
**OpenManus 参考**：`app/agent/manus.py`、`app/prompt/manus.py`

### Phase 4：Agent 变体
**目标**：Browser、SWE、DataAnalysis Agent。
**文件**：`graphs/browser.ts`、`graphs/swe.ts`、`graphs/dataAnalysis.ts`、`nodes/prepareContext.ts`
**OpenManus 参考**：`app/agent/browser.py`、`app/agent/swe.py`、`app/agent/data_analysis.py`

### Phase 5：Planning Flow
**目标**：基于计划的多 Agent 编排执行。
**文件**：`state/planState.ts`、`graphs/planning.ts`、`nodes/planNodes.ts`
**验证**：创建计划，用正确的 Agent 执行步骤，标记进度。
**OpenManus 参考**：`app/flow/planning.py`、`app/tool/planning.py`

### Phase 6：高级特性
**目标**：HITL、持久化、流式输出、MCP。
**文件**：更新所有图 + `tools/mcpTools.ts`
**验证**：可以暂停/恢复，跨重启持久化，流式传输 tokens。
**OpenManus 参考**：`app/tool/ask_human.py`、`app/tool/mcp.py`、`app/mcp/`

---

## 附录 A：提示词模板

### Manus 系统提示（来自 `app/prompt/manus.py`）

```
You are OpenManus, an all-capable AI assistant, aimed at solving any task presented by the user.
You have various tools at your disposal that you can call upon to efficiently complete complex requests.
Whether it's programming, information retrieval, file processing, web browsing, or human interaction
(only for extreme cases), you can handle it all.
The initial directory is: {directory}
```

### Manus 下一步提示

```
Based on user needs, proactively select the most appropriate tool or combination of tools.
For complex tasks, you can break down the problem and use different tools step by step to solve it.
After using each tool, clearly explain the execution results and suggest the next steps.

If you want to stop the interaction at any point, use the `terminate` tool/function call.
```

### Planning 系统提示（来自 `app/prompt/planning.py` / `app/flow/planning.py:140-160`）

```
You are a planning assistant. Create a concise, actionable plan with clear steps.
Focus on key milestones rather than detailed sub-steps.
Optimize for clarity and efficiency.
```

---

## 附录 B：需要保留的关键行为细节

这些是 OpenManus 中必须在重写中保留的细微行为：

1. **Bash 会话持久性**（`app/tool/bash.py`）：工作目录和环境变量跨调用存活。**不要**每条命令创建新进程。

2. **str_replace 唯一性**（`app/tool/str_replace_editor.py:298-314`）：old_str 必须恰好出现一次。零次匹配 → 提示"未逐字出现"的错误。多次匹配 → 列出行号的错误。

3. **浏览器锁**（`app/tool/browser_use_tool.py:124`）：每次只允许一个浏览器操作。使用 mutex。

4. **extract_content 子 LLM 调用**（`app/tool/browser_use_tool.py:376-444`）：此操作内部用页面内容（markdownified，截断至 `max_content_length`）调用 LLM 提取结构化数据。这是一个使用 AI 的工具，不只是爬取。

5. **WebSearch 降级链**（`app/tool/web_search.py:290-327`）：尝试首选引擎 → 降级引擎 → 剩余引擎。每个引擎 3 次重试。如果全部失败，等待 `retry_delay` 再重试整个链，最多 `max_retries` 次。

6. **卡死检测阈值**（`app/agent/base.py:183-186`）：统计内容**完全相同**的 assistant 消息（非相似）。阈值为 2 次重复。

7. **max_observe 截断**（`app/agent/toolcall.py:147-148`）：工具输出在添加到记忆**之前**截断至 `max_observe` 字符。Manus 默认为 10000。

8. **工具错误处理**（`app/agent/toolcall.py:166-208`）：无效 JSON 参数 → 错误消息给 LLM。未知工具 → 错误消息。异常 → 错误消息。LLM 可以看到并从所有错误中恢复。

9. **PlanningFlow 步骤选择**（`app/flow/planning.py:243-246`）：用正则 `\[([A-Z_]+)\]` 从步骤文本提取 `[TYPE]` 标签，确定哪个 Agent 执行该步骤。

10. **Manus 浏览器上下文注入**（`app/agent/manus.py:140-165`）：只有在**最近 3 条消息**中使用了浏览器才注入浏览器状态到提示中。检查最近消息的 `tool_calls` 是否包含 `BrowserUseTool().name`。

---

## 10. 差距分析：功能对等审计

> 通过对比每个 Python 文件与 TS 实现生成。
> 每条目引用精确的 Python 源文件、缺失内容和严重程度。

### 10.1 沙箱系统

**Python 源**：`app/sandbox/core/sandbox.py`（462）、`terminal.py`（346）、`manager.py`（313）、`client.py`（201）= **共 1322 行**
**TS 当前**：`sandbox/docker.ts`（221 行）——**覆盖率 16%**

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| AsyncDockerizedTerminal（容器内持久 bash） | `terminal.py:19-248`——socket I/O、提示检测、PS1/TERM 设置 | 无 | **整个交互式会话缺失。** TS 每条命令使用一次性 `docker exec`——容器内无 cd/环境持久化 | 严重 |
| SandboxManager（池/生命周期） | `manager.py:14-313`——max_sandboxes、空闲超时、后台清理、每 sandbox_id 的锁、并发操作追踪 | 无 | 无池化、无空闲清理、无资源治理 | 严重 |
| 路径遍历保护 | `sandbox.py:_safe_resolve_path()`——拒绝路径中的 `..` | 无 | 容器路径未检查——可逃逸工作目录 | 高 |
| 命令净化 | `terminal.py:DockerSession._sanitize_command()`——阻止 `rm -rf /`、`mkfs`、`dd`、fork bomb、`chmod -R`、`chown` | 无 | 任意命令传递到容器 | 高 |
| 卷绑定准备 | `sandbox.py:_prepare_volume_bindings()`——创建宿主机目录、避免冲突 | 配置接受 `volumes` 字典，无验证 | 缺少自动目录创建，无冲突避免 | 高 |
| 基于 tar 的文件 I/O | `sandbox.py:_create_tar_stream(), _read_from_tar()`——正确的 tar 归档 | base64 echo 写入、普通 docker cp | 无元数据保留，二进制文件处理脆弱 | 中 |
| 容器命名 | `sandbox_uuid` 唯一名称 | Docker 自动命名 | 无可读标识符 | 低 |
| 优雅关闭 | 停止（5秒超时）→ 强制删除 → 关闭终端 | `docker kill` 立即执行 | 无优雅停止期 | 中 |
| 错误层次 | `SandboxTimeoutError`、`SandboxResourceError`、`SandboxError` | 仅通用 `Error` | 无类型化错误处理 | 中 |
| get_stats() 诊断 | 返回 Map 大小、空闲计数 | 无 | 无可观测性 | 低 |

### 10.2 文件操作符

**Python 源**：`app/tool/file_operators.py`（159 行）
**TS 当前**：无——`strReplaceEditor.ts` 直接使用 `fs`

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| FileOperator 协议 | `file_operators.py:15-40`——抽象：read_file、write_file、is_directory、exists、run_command | 无 | **无抽象层。** 无法在运行时切换本地/沙箱 | 严重 |
| SandboxFileOperator | `file_operators.py:96-159`——委托给 SANDBOX_CLIENT，懒初始化 | 无 | strReplaceEditor 锁死在宿主文件系统 | 严重 |
| 基于配置的切换 | `str_replace_editor.py:106-112`——`config.sandbox.use_sandbox` → 选择 operator | 无 | 无配置检查——始终使用本地 | 严重 |
| LocalFileOperator 类 | `file_operators.py:42-94`——可复用，编码可配置 | 内联 fs 调用 | 工具间无复用 | 中 |
| 接口中的 run_command() | 协议中的 shell 执行能力 | 不在接口中 | 无法通过 operator 执行命令 | 低 |

### 10.3 Planning 工具与流程

**Python 源**：`app/tool/planning.py`（364）+ `app/flow/planning.py`（443）= **807 行**
**TS 当前**：`graphs/planning.ts`（324）+ `state/planState.ts`（92）= **416 行——覆盖率 51%**

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| PlanningTool 作为 LLM 可调用工具 | `planning.py:14-364`——LLM 执行期间可调用的 7 个命令 | 无——计划仅为状态，由图节点修改 | **LLM 无法动态调整计划。** 执行期间无法增删/重排步骤 | 严重 |
| update 命令 | `planning.py:160-207`——修改标题/步骤，保留未更改步骤的状态 | 无 | 计划在创建后不可变 | 严重 |
| delete 命令 | `planning.py:306-320`——删除计划，清除活跃状态 | 无 | 无法丢弃错误计划 | 高 |
| list 命令 | `planning.py:209-226`——枚举所有计划及进度 | 无 | 状态中每次只有一个计划 | 高 |
| set_active 命令 | `planning.py:244-255`——在计划间切换 | 无 | 无多计划支持 | 高 |
| mark_step 中的 step_notes | `planning.py:257-304`——LLM 可为步骤添加备注 | PlanStep.notes 存在但从未写入 | 备注仅为装饰 | 中 |
| 跨调用的内存计划持久化 | `planning.py:69`——`plans: dict = {}` 类变量 | 图完成时状态丢失 | 每次运行从头开始 | 中 |
| 通过工具调用创建初始计划 | `planning.py:170-176`——LLM.ask_tool 使用 planning 工具 → 结构化 create 命令 | LLM 返回自由格式 JSON → 解析 | 计划结构可靠性较低 | 中 |

### 10.4 Terminate 工具

**Python 源**：`app/tool/terminate.py`（26）+ `toolcall.py:210-227`（18 行）
**TS 当前**：`tools/terminate.ts`（30）+ `reactAgent.ts` 中的路由

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| success/failure 状态区分 | `terminate.py:23`——返回状态字符串；`toolcall.py:216`——已记录 | shouldContinue 仅检查名称，忽略状态 | 无法区分成功与失败的终止 | 中 |
| special_tool_names 可配置 | `toolcall.py:31`——每个 Agent 的 `Field(default_factory=...)` | shouldContinue 中硬编码 `"terminate"` 字符串 | 无法在不改代码的情况下添加其他特殊工具 | 中 |
| 终止日志 | `toolcall.py:217`——`logger.info(f"🏁 Special tool '{name}' has completed")` | 终止时无日志 | 静默终止 | 低 |
| 记忆中的工具结果 | `toolcall.py:155-161`——带结果的 ToolMessage 添加到记忆 | ToolNode 不执行 terminate（路由到 END 在 act 之前） | 终止结果不在对话历史中 | 低 |

### 10.5 Bedrock LLM 客户端

**Python 源**：`app/bedrock.py`（335 行）
**TS 当前**：**无**

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| BedrockClient（boto3 包装器） | `bedrock.py:38-46` | 无 | 无法使用 AWS Bedrock 模型 | 严重 |
| 消息格式转换 OpenAI→Bedrock | `bedrock.py:86-132`——系统提取、toolUse/toolResult 块、CURRENT_TOOLUSE_ID 追踪 | 无 | Bedrock 不兼容 | 严重 |
| 工具格式转换 | `bedrock.py:60-84`——OpenAI function → Bedrock toolSpec | 无 | Bedrock 工具损坏 | 严重 |
| 响应转换 Bedrock→OpenAI | `bedrock.py:134-193`——choices、usage、从 toolUse 块提取 tool_calls | 无 | 无法解析 Bedrock 响应 | 严重 |
| 流式输出 | `bedrock.py:220-298`——converse_stream()、事件解析（messageStart、contentBlockDelta 等） | 无 | 无 Bedrock 流式输出 | 高 |
| 非流式调用 | `bedrock.py:195-218`——converse() 调用 | 无 | 完全无 Bedrock 调用 | 高 |

**注意**：LangGraph TS 可以使用 `@langchain/aws`（ChatBedrock）作为 ChatOpenAI 的即插即用替代。这是**推荐方案**，而非翻译原始 boto3 包装器。见 Phase 7 计划。

### 10.6 日志

**Python 源**：`app/logger.py`（43）+ `app/utils/logger.py`（33）= **76 行**
**TS 当前**：`console.log` 散落各处

| 功能 | Python | TS | 差距 | 严重程度 |
|---------|--------|-----|-----|----------|
| 全局日志实例 | `from app.logger import logger`——单一导入 | 直接 `console.log` | 无一致日志 API | 严重 |
| 文件日志 | `logger.py:16-24`——`logs/{timestamp}.log` 滚动文件处理器 | 无 | 退出时日志丢失 | 严重 |
| 日志级别（DEBUG/INFO/WARNING/ERROR） | loguru 处理器，级别可配置 | console 有 log/error/warn/debug 但无统一控制 | 生产环境无法抑制调试输出 | 高 |
| 结构化 JSON（生产） | `utils/logger.py`——`ENV_MODE=PROD` 时 structlog JSONRenderer | 无 | 日志不可机器解析 | 高 |
| 调用位置追踪 | `utils/logger.py`——自动添加 filename、func_name、lineno | 无 | 无法追踪日志来源 | 中 |
| 上下文变量 | structlog contextvars 用于关联 ID | 无 | 无请求范围上下文 | 中 |
| 每条目时间戳 | TimeStamper ISO 格式 | 仅终端隐式 | 日志缺少精确时间 | 低 |

### 10.7 审计中发现的其他差距

| 模块 | Python 源 | 差距 | 严重程度 |
|--------|-------------|-----|----------|
| **BrowserAgent 上下文注入** | `app/agent/browser.py:64-129`——BrowserContextHelper 在最近 3 条消息中使用了浏览器时注入截图+URL+标签页 | TS 有 `browserManager.getState()` 但无将其注入 think 提示的节点 | 高 |
| **MCP Server（暴露工具）** | `app/mcp/server.py`（180 行）——FastMCP 服务器，向外部 MCP 客户端暴露 OpenManus 工具 | TS 仅有客户端，无服务端 | 中 |
| **搜索引擎（Google/Bing/Baidu）** | `app/tool/search/google_search.py`（33）、`bing_search.py`（144）、`baidu_search.py`（54） | TS 仅有 DDG | 中 |
| **Daytona 远程沙箱** | `app/daytona/sandbox.py`（165）、`tool_base.py`（138） | 配置类型存在，无实现 | 低 |
| **Computer Use 工具** | `app/tool/computer_use_tool.py`（487）——VNC/RDP 桌面自动化 | 无 | 低（小众） |
| **LLM Token 计数** | `app/llm.py:TokenCounter`（60 行）——图片、消息、文本的精确 token 计数 | 无——依赖 LLM 提供商限制 | 中 |
| **LLM 带退避重试** | `app/llm.py:308-340`——6 次重试、指数退避、跳过 TokenLimitExceeded | think.ts 捕获 token 错误，无通用重试 | 中 |
| **异常层次** | `app/exceptions.py`——ToolError、OpenManusError、TokenLimitExceeded | 仅通用 Error | 低 |
| **files_utils** | `app/utils/files_utils.py`（87）——文件排除列表（node_modules、.git 等） | 无 | 低 |

### 10.7b 新发现差距（第二次审查）

> 以下模块在初始审计（10.1-10.7）中被完全遗漏，由后续 review 发现。

**A2A 协议**（`protocol/a2a/app/`，约 300 行）：
Python 实现了完整的 A2A 标准协议 HTTP 服务端。`A2AManus` 继承 Manus 并包装 `invoke()`/`stream()` 接口；`ManusExecutor` 实现 `AgentExecutor`，处理 A2A 请求/响应；服务端基于 Starlette/Uvicorn，含 `AgentCard` 能力声明、`InMemoryTaskStore`、`InMemoryPushNotifier`。TS 无任何实现。

**SandboxManus Agent**（`app/agent/sandbox_agent.py`，224 行）：
独立 Agent 变体，工具集与普通 Manus 完全不同：SandboxBrowserTool、SandboxFilesTool、SandboxShellTool、SandboxVisionTool。通过 Daytona SDK 创建/删除沙箱，生成 VNC URL 和网站预览 URL。有独立入口 `sandbox_main.py`。TS 无任何实现。

**沙箱工具集**（`app/tool/sandbox/`，4 个文件，约 1400 行）：
- `sb_shell_tool.py`：基于 tmux 的非阻塞 shell 会话管理（execute_command、check_command_output、terminate_command、list_commands），与 bash.ts 的一次性 docker exec 有本质区别
- `sb_browser_tool.py`：通过 Daytona API 远程操控沙箱内浏览器
- `sb_files_tool.py`：沙箱文件操作 + `/workspace` 路径边界保护
- `sb_vision_tool.py`：OCR 截图分析
TS 无任何实现。

**MCPAgent 动态刷新**（`app/agent/mcp.py`，刷新相关逻辑约 60-80 行）：
Python 的 MCPAgent 每 `_refresh_tools_interval`（5）步自动调用 `_refresh_tools()` → 重新 `list_tools()` → 对比 `tool_schemas` 检测新增/删除/变更的工具 → 注入系统消息通知 LLM。工具全部移除时判定服务关闭。还处理多媒体响应（base64_image → 特殊 prompt）。TS 的 mcpTools.ts 仅有连接 + 工具转换，无运行时刷新行为。

**Crawl4AI 实现深度差异**：
Python 用 `crawl4ai.AsyncWebCrawler`（Chromium 内核），支持 JS 渲染、iframe 处理、overlay 移除、DOM 加载等待、缓存策略。TS 用 `fetch+cheerio`，只能处理纯 HTML 静态页面，无法抓取 SPA/动态内容。这是本质性的能力差距。

**DataVisualization 实现深度差异**：
Python 的图表流水线：`VisualizationPrepare`（CSV 清洗 → JSON 元数据）→ `DataVisualization`（读取 JSON → 调用 VMind Node.js 子进程 → 输出 HTML/PNG 图表）→ 可选 Insight（分析图表生成 Markdown 洞察报告）。VMind 是字节 VisActor 的智能图表引擎，能根据数据自动推荐图表类型。LLM 配置透传给 VMind。TS 的 `chartVisualization.ts` 只是一个 `execSync("python3 ...")` 的 matplotlib 执行器，缺少整个 VMind 流水线和 Insight 系统。

### 10.8 完成度矩阵（修订版）

> 以下覆盖率经过二次 review 修正，比初始评估更保守但更准确。

| 组件 | Python 行数 | TS 行数 | 覆盖率 | 关键差距 | 优先级 |
|-----------|-------------|----------|----------|---------|----------|
| ReAct Agent 核心 | 450 | 190 | **90%** | 核心已完成；补充：MCPAgent 刷新（P2）、SandboxManus（P2） | 已完成 + P2 补充 |
| 工具（10 个） | 2500 | 1300 | **60-65%** | DOM 索引（**P0**）；Crawl4AI/ChartViz 需重写（P1） | P0 + P1 |
| Planning Flow | 807 | 416 | **40-45%** | PlanningTool 7 命令 CRUD 完全缺失 | **P0** |
| BrowserUse DOM 索引 | （含在上面） | 0 | **0%** | 无元素编号系统，LLM 无法可靠操控浏览器 | **P0** |
| 沙箱系统 | 1322 | 221 | **20%** | 缺 Terminal、Manager | P1 |
| 沙箱工具集（4 个） | ~1400 | 0 | **0%** | sb_shell（tmux）、sb_browser、sb_files、sb_vision | P1/P2 |
| SandboxManus Agent | 224 | 0 | **0%** | 独立 Agent + Daytona 集成 | P2 |
| A2A 协议 | ~300 | 0 | **0%** | HTTP Server + Agent 互操作标准 | P2 |
| 文件操作符 | 159 | 0 | **0%** | 无抽象层，strReplaceEditor 锁死本地 FS | P1 |
| 日志 | 76 | 0 | **0%** | console.log 散落各处 | P1 |
| MCPAgent 动态刷新 | 185 | 60 | **30%** | 缺刷新间隔、schema 变化检测、服务关闭感知 | P2 |
| Bedrock LLM | 335 | 0 | **0%** | 用 @langchain/aws 替代 | P2 |
| 配置系统 | 373 | 200 | **70%** | 类型完整，TOML 解析待完善 | P2 |
| 浏览器上下文注入 | 129 | 0 | **0%** | getState() 有但无注入节点 | P2 |
| Token 计数/重试 | 120 | 20 | **15%** | 仅基础 token 错误捕获 | P2 |
| CreateChatCompletion | 170 | 0 | **0%**（有意） | LangGraph 原生 withStructuredOutput() 替代 | 不迁移 |
| MCP Server | 180 | 0 | **0%** | 仅客户端，无服务端 | P3 |
| 搜索引擎 | 231 | 60 | **25%** | 仅 DDG | P3 |
| 异常 | 20 | 0 | **0%** | 无类型化异常 | P3 |
| Daytona | 303 | 0 | **0%** | 远程沙箱 | P4 |
| Computer Use | 487 | 0 | **0%** | VNC/RDP | P4 |

**整体完成度估算：~55%**（初始声称 ~70%，修正后更准确）

不迁移的模块：
- **CreateChatCompletion**：LangGraph TS 的 `model.withStructuredOutput(zodSchema)` 是更好的原生替代
- **NormalPythonExecute**：与 PythonExecute 区别仅为不用 multiprocessing，TS 的 codeExecute 已覆盖

---

## 11. Phase 7+：剩余工作

### Phase 7-P0：使用前必须修复

#### P0-1：PlanningTool——LLM 可调用的 7 命令 CRUD（`src/tools/planningTool.ts`）
- 来自：`app/tool/planning.py`（364 行）
- 当前 TS 版本的 Planning 是纯状态，LLM 无法动态修改计划
- 需求：
  - 7 个命令：create、update、list、get、set_active、mark_step、delete
  - 内存存储（`Map<string, Plan>`）
  - 活跃计划追踪
  - 步骤备注
  - 作为工具注入到 planning flow 的执行器 Agent 中
  - LLM 可在执行步骤时调用 update 添加/删除步骤

#### P0-2：BrowserUse DOM 索引服务
- 来自：`app/tool/browser_use_tool.py`——依赖 browser-use 库的 DomService
- 当前 TS 用原生 Playwright CSS/XPath，LLM 无法说"点击第5个元素"
- **推荐方案**：使用 npm `browser-use`（v0.6.0+）——TS 优先库，与 Python 的 `browser-use` 同源
  - 提供 DomService 等价功能：元素索引、`get_dom_element_by_index()`、`clickable_elements_to_string()`
  - Python 核心链路：`DomService(page)` → `context.get_dom_element_by_index(index)` → `state.element_tree.clickable_elements_to_string()`
  - TS 对接现有库，工作量从"大量自实现"降为"集成对接"
- 需求：
  - `npm install browser-use` 替换当前原生 Playwright 实现
  - 重写 `browserUse.ts`：用 browser-use 的 Browser/BrowserContext 替代手动 Playwright 管理
  - get_current_state() 返回编号后的可交互元素列表（`clickable_elements_to_string()`）
  - click_element(index) / input_text(index, text) 通过数字索引操作
  - extract_content 恢复 LLM 子调用（markdownify 页面内容 → LLM 提取结构化数据）

### Phase 7a：关键基础设施（P1）

**目标**：沙箱执行、计划灵活性、文件操作和可观测性的功能对等。

#### 7a-1：日志（`src/utils/logger.ts`）
- 来自：`app/logger.py` + `app/utils/logger.py`
- 使用 `pino` 或 `winston` npm 包
- 需求：
  - 全局单例：`import { logger } from "./utils/logger.js"`
  - 级别：debug/info/warn/error
  - 文件输出：`logs/{timestamp}.log`
  - `NODE_ENV=production` 时结构化 JSON 模式
  - 替换现有代码中的所有 `console.log` 调用

#### 7a-2：文件操作符（`src/tools/fileOperators.ts`）
- 来自：`app/tool/file_operators.py`
- 需求：
  - `FileOperator` 接口：readFile、writeFile、isDirectory、exists、runCommand
  - 实现它的 `LocalFileOperator` 类
  - 委托给 SANDBOX_CLIENT 的 `SandboxFileOperator` 类
  - 检查 `config.sandbox.use_sandbox` 的 `getOperator(config)` 工厂
  - 更新 `strReplaceEditor.ts` 接受 FileOperator 而非直接调用 fs

#### 7a-3：沙箱终端（`src/sandbox/terminal.ts`）
- 来自：`app/sandbox/core/terminal.py`
- 需求：
  - 通过 `docker exec -it` 在容器内运行交互式 bash 会话
  - 持久会话（cd、环境变量跨命令存活）
  - 提示检测用于输出边界
  - 命令净化（阻止危险模式）
  - 路径遍历保护

#### 7a-4：沙箱管理器（`src/sandbox/manager.ts`）
- 来自：`app/sandbox/core/manager.py`
- 需求：
  - 有 `maxSandboxes` 限制的池
  - 空闲超时追踪 → 自动清理
  - 后台清理间隔
  - 每沙箱并发锁
  - 镜像拉取/验证
  - `getStats()` 诊断

#### 7a-5：PlanningTool
> **已合并到 Phase 7-P0，见 P0-1。**（原放于此处，审查后提升为 P0 优先级。）

#### 7a-6：Crawl4AI 真正实现——JS 渲染（`src/tools/crawl4ai.ts` 重写）
- 当前 TS 用 fetch+cheerio，无法处理 SPA/动态内容
- Python 用 `crawl4ai.AsyncWebCrawler`（Chromium 内核）：headless 浏览、JS 执行、iframe、overlay 移除
- TS 方案：
  - 用已安装的 Playwright 做 JS 渲染：`page.goto(url)` → `page.content()` → cheerio 提取
  - 或安装 `crawlee` npm 包（Apify 的 Node.js 爬虫框架，自带浏览器池管理）
  - 保留 fetch+cheerio 作为轻量快速路径（无 JS 的静态页面）

#### 7a-7：DataVisualization VMind 流水线（`src/tools/chartVisualization.ts` 重写）
- 当前 TS 只是 matplotlib 执行器，缺少智能图表推荐
- Python 流水线：`VisualizationPrepare（CSV 清洗 + JSON 元数据）` → `DataVisualization（VMind 子进程）` → 图表 + Insight
- TS 方案：
  - `npm install @visactor/vmind` 原生 Node.js 集成（Python 反而要通过 npx ts-node 子进程调用）
  - VMind 需要 LLM 配置：透传 base_url/model/api_key（从 getConfig().llm 读取）
  - VisualizationPrepare：保持为独立工具，负责 CSV→清洗→JSON 元数据生成，输出 JSON 路径
  - DataVisualization：读取 JSON → 调用 VMind → 输出 HTML/PNG 图表
  - Insight 系统：VMind 返回 insights_id → 二次调用 VMind 生成 Markdown 洞察
  - 双模式保留：visualization（生成图表）+ insight（添加洞察到图表）
- **注意**：VMind 内部独立调用 LLM（用于图表类型推荐和 Insight 生成），这些调用在 LangGraph graph 之外，token 消耗不被 graph 追踪。且 VMind 只支持 OpenAI-compatible endpoint（base_url/model/api_key 三字段），如果用户配了 Bedrock/Anthropic 原生 API，需要额外适配或提供 OpenAI-compatible 代理。

#### 7a-8：沙箱工具集（`src/tools/sandbox/`）
- 来自：`app/tool/sandbox/`（4 个文件，约 1400 行）
- **sb_shell_tool**（419 行）：基于 tmux 的持久化 shell 会话
  - 4 个动作：execute_command、check_command_output、terminate_command、list_commands
  - 非阻塞执行（tmux session）、命令列表管理、进程终止
  - 与 bash.ts 的一次性 docker exec 完全不同
- **sb_browser_tool**（450 行）：沙箱内浏览器自动化（通过 Daytona API）
- **sb_files_tool**（361 行）：沙箱文件操作 + 路径边界检查（防止逃逸 /workspace）
- **sb_vision_tool**（178 行）：OCR / 截图分析 / 屏幕内容识别

### Phase 7b：增强特性（P2）

> 以下均为 P2 优先级。P1 项目已全部上移到 Phase 7a。

#### 7b-1：Bedrock 支持
- 安装 `@langchain/aws` 包
- 在 `buildReactAgent()` 中添加 `ChatBedrockConverse` 作为 `ChatOpenAI` 的替代
- 配置：`llm.api_type: "bedrock"` → 实例化 ChatBedrockConverse
- 无需移植原始 boto3 包装器——LangChain 处理转换

#### 7b-2：浏览器上下文注入（`src/nodes/prepareContext.ts`）
- 来自：`app/agent/browser.py:64-129`、`app/agent/manus.py:140-165`
- 需求：
  - 在支持浏览器的图中 `think` 之前运行的节点
  - 检查最近 3 条消息中是否调用了 `browser_use`
  - 如果是：调用 `browserManager.getState()` → 以多模态消息注入截图 + URL + 标签页
  - 创建使用此节点的 `graphs/browser.ts` 变体

#### 7b-3：LLM 重试 & Token 计数
- 来自：`app/llm.py:308-340`（重试）、`app/llm.py:TokenCounter`（计数）
- 在 think 节点上使用 LangGraph 内置的 `RetryPolicy`：
  ```typescript
  .addNode("think", thinkNode, { retryPolicy: { maxAttempts: 3 } })
  ```
- Token 计数：使用 `model.getNumTokens()` 或 `@langchain/tiktoken` 包

#### 7b-4：Config TOML 解析
- 安装 `smol-toml` 包进行正确的 TOML 解析
- 完善 `config/index.ts` 的 loadConfig() 以解析所有节

#### 7b-5：A2A 协议（`src/a2a/`）
- 来自：`protocol/a2a/app/`（main.py + agent.py + agent_executor.py，约 300 行）
- 完整的 HTTP 服务端，实现 A2A 标准协议（Agent-to-Agent 互操作）
- Python 实现：Starlette/Uvicorn，A2AManus 继承 Manus，ManusExecutor 处理请求/响应
- 需求：
  - A2A server：可用 Express/Fastify 实现 HTTP endpoint
  - AgentCard：声明 Agent 能力和技能（A2A 特有，LangGraph Platform 不提供）
  - TaskStore + PushNotifier：任务状态管理
  - invoke/stream 接口包装 LangGraph graph
- **关于 LangGraph Platform**：LangGraph Platform 解决**部署**问题（HTTP endpoint + 线程管理），A2A 解决**互操作**问题（标准协议 + AgentCard 能力声明 + Task/Artifact 模型）。两者互补不互替。如果只需要 HTTP 部署，用 Platform 足够（P3）；如果需要与其他 A2A Agent 互通，仍需实现 A2A 协议层，可在 Platform 之上构建。

#### 7b-6：SandboxManus Agent（`src/graphs/sandboxManus.ts`）
- 来自：`app/agent/sandbox_agent.py`（224 行）+ `sandbox_main.py`
- 独立的 Agent 变体，与普通 Manus 完全不同的工具集
- 依赖 7a-8（沙箱工具集）和 7a-3/7a-4（沙箱终端/管理器）
- 需求：
  - `createSandboxManusAgent()` 工厂函数
  - 沙箱生命周期管理（create → use → cleanup/delete）
  - Daytona 集成：VNC URL + 网站预览 URL 生成

#### 7b-7：MCPAgent 动态刷新机制
- 来自：`app/agent/mcp.py`（185 行，其中动态刷新逻辑约 60-80 行）
- 当前 TS 的 mcpTools.ts 只有连接和工具转换，缺少运行时行为
- 需求：
  - `_refresh_tools_interval`：每 N 步自动刷新工具列表
  - `tool_schemas` 追踪：检测工具 schema 变化（新增/删除/修改）
  - 服务关闭感知：`tool_map` 为空时优雅结束
  - 多媒体响应处理（图片类型的 MCP 工具结果 → 系统消息提示）

### Phase 7c：可选增强（P3）

#### 7c-1：搜索引擎
- 添加 Google（通过 `serpapi` 或 `google-search-results-nodejs`）
- 添加 Bing（通过 `@azure/cognitiveservices-websearch` 或直接 API）
- 更新 `webSearch.ts` 降级链以使用配置中的引擎顺序

#### 7c-2：自定义异常类型（`src/utils/errors.ts`）
- `ToolError`、`OpenManusError`、`TokenLimitExceeded`、`SandboxError`
- 更新工具 catch 块以抛出类型化错误

#### 7c-3：MCP Server
- 来自：`app/mcp/server.py`
- 使用 `@modelcontextprotocol/sdk` 将 OpenManus 工具作为 MCP 服务器暴露

### Phase 7d：专项功能（P4）

- Daytona 远程沙箱集成
- Computer Use 工具（VNC/RDP）
