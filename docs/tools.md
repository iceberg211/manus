# 工具层详解

> 工具是 Agent 与外部世界交互的唯一通道。LLM 本身只能生成文本，工具让它能执行代码、编辑文件、搜索网络、操作浏览器。
>
> 本项目有 **18 个工具**（14 个核心 + 4 个沙箱），涵盖代码执行、文件操作、网络访问、浏览器控制、任务规划、人机交互六大类。

---

## 工具的统一结构

每个工具都是一个 LangChain `tool()` 函数，三部分组成：

```typescript
export const myTool = tool(
  async ({ param1, param2 }) => {        // 1. 执行函数 — 做什么
    return "result string";
  },
  {
    name: "my_tool",                      // 2. 名称 — LLM 通过这个名字调用
    description: "Tool description...",   // 3. 描述 — LLM 看到这个决定是否调用
    schema: z.object({                    //    参数 schema — 约束 LLM 传什么
      param1: z.string().describe("..."),
      param2: z.number().default(5),
    }),
  }
);
```

LLM 的决策链路：看到所有工具的 name + description → 选一个 → 按 schema 生成参数 → ToolNode 执行 → 结果返回给 LLM。

---

## 一、代码执行

### bash — 持久命令行会话

**文件**: `src/tools/bash.ts` (232 行)
**核心能力**: 在一个长驻的 `/bin/bash` 进程中执行命令，cd、环境变量跨命令保留。

**关键设计**:

```
用户: bash("cd /project")
用户: bash("pwd")          →  输出 "/project"（会话持久）
用户: bash("export A=1")
用户: bash("echo $A")     →  输出 "1"（环境变量持久）
```

**实现原理**:
- 用 `child_process.spawn("/bin/bash")` 创建一个**单例**子进程
- 每次命令追加随机 UUID 哨兵：`command; echo '__SENTINEL_abc123__'`
- 轮询 stdout buffer 直到看到哨兵 → 截取哨兵前的内容作为输出
- 120 秒超时 → 标记 timed out，后续调用自动重启

**安全措施**:
- 命令过滤：7 种危险模式黑名单（`rm -rf /`, `mkfs`, `dd`, fork bomb 等）
- 随机哨兵：防止命令输出恰好包含固定哨兵字符串导致截断

**为什么不用 `execSync`**: `execSync` 每次创建新进程，cd/env 不保留。Agent 需要"在同一个终端里工作"的体验。

### code_execute — Python 代码执行

**文件**: `src/tools/codeExecute.ts` (68 行)
**核心能力**: 执行 LLM 生成的 Python 代码，捕获 print 输出。

**实现原理**:
- 代码写入临时文件 → `execSync("python3 tmpfile")` → 捕获 stdout → 删除临时文件
- 默认 5 秒超时，超时则杀进程

**局限**: 当前直接在宿主机执行，无沙箱隔离。生产环境应启用 Docker 沙箱（`config.sandbox.use_sandbox = true`）。

---

## 二、文件操作

### str_replace_editor — 精确文件编辑

**文件**: `src/tools/strReplaceEditor.ts` (353 行)
**核心能力**: 5 个子命令覆盖文件操作全场景。

| 命令 | 功能 | 关键约束 |
|------|------|---------|
| `view` | 查看文件（带行号）或目录（2 层深） | 支持 `viewRange: [10, 20]` 行范围 |
| `create` | 创建新文件 | **拒绝覆盖**已有文件 |
| `str_replace` | 精确字符串替换 | `old_str` 必须在文件中**恰好出现一次** |
| `insert` | 在指定行后插入文本 | 按行号定位 |
| `undo_edit` | 撤销上一次编辑 | 从内存历史栈恢复 |

**str_replace 的唯一性检查是核心设计**:
```
文件内容: "aaa\nbbb\naaa"
str_replace(old_str="aaa") → 报错: "Multiple occurrences in lines [1, 3]"
str_replace(old_str="aaa\nbbb") → 成功: 唯一匹配
```

这迫使 LLM 提供足够多的上下文来精确定位，避免误替换。

**FileOperator 抽象层** (`src/tools/fileOperators.ts`):
```
getOperator() → config.sandbox.use_sandbox?
  → true:  SandboxFileOperator（通过 Docker 容器操作）
  → false: LocalFileOperator（直接操作本地文件系统）
```

strReplaceEditor 不直接调 `fs`，而是通过 FileOperator 接口。切换沙箱模式只需改配置，工具代码不动。

**路径边界保护** (`checkPathBoundary`):
- 只允许 workspace 目录 + cwd + /tmp 内的文件操作
- 阻止 `/etc/passwd`、`/workspace_evil`（前缀绕过） 等路径

---

## 三、网络访问

### web_search — 多引擎搜索 + 降级

**文件**: `src/tools/webSearch.ts` (195 行)
**核心能力**: 搜索互联网，返回标题/URL/描述，可选抓取页面全文。

**降级策略**:
```
DuckDuckGo（主引擎）
  ↓ 失败（3 次指数退避重试）
全部引擎失败
  ↓ 等待 retry_delay
重试整个链（最多 max_retries 次）
```

**内容抓取** (`fetchContent: true`):
- 用 `fetch` 获取 HTML → `cheerio` 去掉 script/style/nav → 提取正文
- 截断到 10000 字符，避免撑爆 LLM 上下文

### crawl4ai — JS 渲染网页抓取

**文件**: `src/tools/crawl4ai.ts` (210 行)
**核心能力**: 抓取 SPA / 动态页面（web_search 搞不定的场景）。

**双模式**:
```
useJsRendering: true  → Playwright 启动 Chromium → 执行 JS → 渲染完成后抓取 DOM
useJsRendering: false → fetch + cheerio（快速路径，适合静态页面）
```

**Playwright 渲染**做了什么：
1. `page.goto(url)` → 等 DOM 加载完
2. `page.waitForTimeout(1000)` → 等动态内容渲染
3. `page.content()` → 获取完整 HTML（含 JS 渲染的内容）
4. `cheerio` 去掉 script/style/overlay 元素 → 提取纯文本

**批量支持**: 一次传多个 URL，并行抓取。

**web_search vs crawl4ai 的区别**:
- `web_search`: 搜索引擎查询 → 返回搜索结果列表
- `crawl4ai`: 给定 URL → 抓取页面全文内容（不经过搜索引擎）

---

## 四、浏览器自动化

### browser_use — DOM 索引 + 16 种操作

**文件**: `src/tools/browserUse.ts` (360 行)
**核心能力**: 像人一样操作浏览器——导航、点击、输入、滚动、截图、提取内容。

**这是项目中最复杂的工具。**

**DOM 索引系统**（核心价值）:

普通 Playwright 操作需要 CSS/XPath 选择器，LLM 很难准确生成。browser-use 库的做法：

```
页面上所有可交互元素自动编号:
[0] <button>登录</button>
[1] <input type="text" placeholder="用户名">
[2] <input type="password" placeholder="密码">
[3] <a href="/register">注册</a>

LLM 只需说: click_element(index=0)  → 点击"登录"按钮
          input_text(index=1, text="admin")  → 输入用户名
```

**16 种操作**:

| 类别 | 操作 | 说明 |
|------|------|------|
| 导航 | `go_to_url` | 打开 URL |
| | `go_back` | 后退 |
| | `web_search` | DuckDuckGo 搜索 |
| 交互 | `click_element` | 按索引点击 |
| | `input_text` | 按索引输入文字 |
| | `send_keys` | 发送键盘按键（Enter、Tab 等）|
| 滚动 | `scroll_down` / `scroll_up` | 按像素滚动 |
| | `scroll_to_text` | 滚动到包含指定文字的位置 |
| 下拉框 | `get_dropdown_options` | 获取选项列表 |
| | `select_dropdown_option` | 选择选项 |
| 内容 | `extract_content` | 提取页面文本（不调 LLM，由 Agent 自己分析）|
| Tab | `switch_tab` / `open_tab` / `close_tab` | 多标签页管理 |
| 等待 | `wait` | 等待 N 秒 |

**互斥锁**: 浏览器操作是串行的（`Mutex`），防止并发操作导致页面状态混乱。

**状态快照** (`getState()`):
```typescript
{
  screenshot: "base64...",              // 当前页面截图
  url: "https://example.com",          // 当前 URL
  title: "Example Page",               // 页面标题
  interactiveElements: "[0] button...", // 可交互元素列表（编号后）
  tabCount: 3                           // 打开的标签数
}
```

这个快照可以注入到 LLM 的下一轮 prompt 中，让 LLM "看到" 页面。

---

## 五、任务规划

### planning — 7 命令 CRUD

**文件**: `src/tools/planningTool.ts` (315 行)
**核心能力**: LLM 可以在执行过程中动态创建、修改、追踪任务计划。

**这不只是一个工具——是 Planning Flow 的数据存储后端。**

| 命令 | 功能 |
|------|------|
| `create` | 创建计划（标题 + 步骤列表）|
| `update` | 修改步骤（保留未变步骤的状态）|
| `list` | 列出所有计划及进度 |
| `get` | 查看计划详情 |
| `set_active` | 切换当前活跃计划 |
| `mark_step` | 标记步骤状态 + 备注 |
| `delete` | 删除计划 |

**步骤状态流转**:
```
not_started → in_progress → completed
                          → blocked（被阻塞）
                          → failed（执行出错，改进自 Python 原版）
```

**为什么 Planning 是工具而不是纯状态**:

Python 原版的 PlanningTool 就是 LLM 可调用的工具——LLM 在执行步骤时可以说"这个任务比预想的复杂，我需要加两个步骤"，然后调用 `planning.update()` 修改计划。如果 planning 只是 graph state，LLM 就无法自主调整计划。

---

## 六、人机交互 & 控制

### ask_human — 请求人工输入

**文件**: `src/tools/askHuman.ts` (29 行)
**核心能力**: Agent 遇到无法自行决策的问题时，暂停执行并询问用户。

**这个工具本身不执行任何操作**。它只是一个 schema 定义——当 LLM 调用它时，graph 的路由函数检测到 `ask_human` → 走 `human_review` 节点 → 调用 `interrupt()` 暂停图。

```
LLM: "我不确定用哪个数据库，让我问问用户"
     → tool_calls: [{name: "ask_human", args: {inquire: "你想用 MySQL 还是 PostgreSQL?"}}]
     → 图暂停
     → 前端弹出对话框
     → 用户回答 "PostgreSQL"
     → Command({ resume: "PostgreSQL" })
     → 图恢复，LLM 看到答案继续工作
```

### terminate — 终止执行

**文件**: `src/tools/terminate.ts` (29 行)
**核心能力**: Agent 完成任务后调用此工具结束执行。

两个状态：`success`（任务完成）或 `failure`（无法继续）。

路由函数 `shouldContinue` 检测到 terminate → 直接走 `END`，不执行工具。

---

## 七、MCP 动态工具

### mcpTools — 运行时加载外部工具

**文件**: `src/tools/mcpTools.ts` (390 行)
**核心能力**: 连接 MCP 服务器，把远程工具转为本地可用的 LangChain tool。

**MCP (Model Context Protocol)** 是一个标准协议，允许 Agent 发现和调用外部服务的工具。

```typescript
const manager = new MCPToolManager();

// 连接一个文件系统 MCP 服务
await manager.connectStdio({
  id: "fs",
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
});

// 现在 agent 可以用 mcp_fs_read_file, mcp_fs_write_file 等工具
const tools = manager.getAllTools();
```

**连接方式**:
- `stdio`: 启动本地子进程，通过 stdin/stdout 通信
- `SSE`: 连接远程 HTTP 服务，通过 Server-Sent Events 通信

**动态刷新** (`refreshTools()`):
- 每 N 步重新 `listTools()`
- 检测新增/删除/schema 变更的工具
- 服务器关闭时优雅结束

**工具名规则**: `mcp_{serverId}_{toolName}` → 只保留 `[a-zA-Z0-9_-]`，最长 64 字符。

---

## 八、数据可视化

### chart_visualization + visualization_preparation — VMind 图表流水线

**文件**: `src/tools/chartVisualization.ts` (251 行)
**核心能力**: 从数据自动生成智能图表。

**两个工具配合使用**:

```
visualization_preparation (Python 代码)
  → 加载 CSV/Excel → 清洗数据 → 输出 JSON 元数据文件
  → JSON: [{csvFilePath: "clean.csv", chartTitle: "月度销售额趋势"}]

chart_visualization (VMind 引擎)
  → 读取 JSON → 加载 CSV → VMind 自动推荐图表类型 → 生成 HTML/PNG
  → 可选: 添加洞察 (Insight) 报告
```

**VMind** 是字节跳动 VisActor 团队的智能图表引擎——给它数据和标题，它自己决定用折线图、柱状图还是饼图。

**双模式**:
- `visualization`: 数据 → 图表
- `insight`: 图表 → 分析洞察（Markdown 报告）

---

## 九、沙箱工具集

> 以下 4 个工具运行在 Docker 容器内，提供隔离执行环境。需要 Docker 和沙箱配置。

### sandbox_shell — tmux 非阻塞会话

**文件**: `src/tools/sandbox/sbShellTool.ts` (127 行)

与主 `bash` 工具的关键区别：

| | bash | sandbox_shell |
|---|---|---|
| 执行环境 | 宿主机 | Docker 容器 |
| 会话管理 | 单一持久进程 | tmux 多命名会话 |
| 阻塞行为 | 阻塞等待输出 | **默认非阻塞**（后台运行）|
| 用途 | 快速命令 | 长时间任务（服务器、构建）|

**4 个操作**:
```
execute_command  → 启动 tmux 会话执行命令（默认非阻塞）
check_command_output → 查看会话输出
terminate_command → 杀掉会话
list_commands → 列出所有活跃会话
```

**典型用法**:
```
sandbox_shell(action="execute_command", command="npm run dev", session_name="dev-server")
  → "Command started in session 'dev-server' (non-blocking)"

sandbox_shell(action="check_command_output", session_name="dev-server")
  → "Server running on port 3000..."

sandbox_shell(action="terminate_command", session_name="dev-server")
  → "Session 'dev-server' terminated."
```

### sandbox_files — 路径安全文件操作

**文件**: `src/tools/sandbox/sbFilesTool.ts` (118 行)

所有操作限制在容器的 `/workspace` 内，路径边界检查防止逃逸。

6 个操作: `read`, `write`, `list`, `search`, `mkdir`, `delete`

`search` 支持在文件内容中搜索模式（`grep -rn`），适合代码搜索。

### sandbox_browser — 容器内浏览器

**文件**: `src/tools/sandbox/sbBrowserTool.ts` (65 行)

在沙箱内操作浏览器。当前通过 `curl` 实现基本的 HTTP 访问，完整的 VNC 浏览器控制需要 Daytona 集成。

### sandbox_vision — 截图与 OCR

**文件**: `src/tools/sandbox/sbVisionTool.ts` (88 行)

3 个操作:
- `screenshot`: 截取屏幕（需要 Xvfb + scrot/import）
- `read_screen`: 读取终端/tmux 当前文本内容
- `ocr`: 对截图做文字识别（需要 tesseract）

---

## 工具组合：不同 Agent 的工具集

每个 Agent 类型选择不同的工具组合来完成特定领域的任务：

```
Manus（通用）
├── bash, code_execute, browser_use, str_replace_editor
├── web_search, crawl4ai, ask_human, terminate

SWE（软件工程）
├── bash, str_replace_editor, terminate
│   （只需要命令行和文件编辑）

DataAnalysis（数据分析）
├── code_execute, bash, visualization_preparation
├── chart_visualization, terminate

SandboxManus（隔离执行）
├── sandbox_shell, sandbox_files
├── sandbox_browser, sandbox_vision, terminate

Planning Flow（编排层）
├── 上面任意 Agent 作为执行器
├── planning_tool（动态修改计划）
```

---

## 工具开发模式

### 添加一个新工具的步骤

1. 在 `src/tools/` 创建文件
2. 用 `tool()` 函数定义（name + description + schema + execute）
3. 在 `src/tools/index.ts` 导出
4. 在目标 Agent 的 graph 文件（如 `src/graphs/manus.ts`）的 tools 数组中添加
5. 测试：工具会自动出现在 LLM 的可用工具列表中

### 工具设计原则

| 原则 | 说明 |
|------|------|
| **返回字符串不 throw** | 工具出错时返回 `"Error: ..."` 字符串，不抛异常。LLM 看到错误后可以自行重试 |
| **description 决定一切** | LLM 选工具完全靠 description。写清楚"什么时候用、怎么用、有什么限制" |
| **用 `.default()` 不用 `.optional()`** | Zod schema 中可选参数用 `.default(value)` 避免 OpenAI API 兼容警告 |
| **幂等优先** | 工具应尽量幂等——调两次和调一次效果相同。便于重试和错误恢复 |
| **输出截断** | 工具输出超过 `maxObserve`（默认 10000 字符）会被截断，防止撑爆上下文 |

### 工具 vs 节点 vs 图

| 层级 | 用途 | 示例 |
|------|------|------|
| **工具 (tool)** | 单一操作 | `bash("ls")`, `web_search("LangGraph")` |
| **节点 (node)** | 一轮决策 | `think` 调 LLM，`checkStuck` 检查重复 |
| **图 (graph)** | 完整流程 | ReAct 循环，Planning 编排 |

工具被节点调用，节点被图编排。三者各司其职。
