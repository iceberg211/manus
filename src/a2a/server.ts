/**
 * A2A Protocol Server — Agent-to-Agent interoperability.
 *
 * Translated from: protocol/a2a/app/main.py + agent.py + agent_executor.py
 *
 * Implements the A2A standard protocol:
 * - AgentCard: declares agent capabilities and skills
 * - HTTP endpoint: receives tasks, executes via agent graph, returns results
 * - TaskStore: in-memory task state management
 * - PushNotifier: notification of task completion
 *
 * Uses Express as HTTP framework (Python used Starlette/Uvicorn).
 * The agent graph is invoked via LangGraph's .invoke() method.
 */
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { createManusAgent } from "../graphs/manus.js";
import { createThreadConfig } from "../config/persistence.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types (matching A2A protocol)
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  skills: AgentSkill[];
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: "pending" | "running" | "input_required" | "completed" | "failed";
  input: string;
  output?: string;
  /** Populated when status=input_required — the question posed via ask_human. */
  pendingQuestion?: string;
  createdAt: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

class TaskStore {
  private tasks = new Map<string, A2ATask>();

  create(contextId: string, input: string): A2ATask {
    const task: A2ATask = {
      id: randomUUID(),
      contextId,
      status: "pending",
      input,
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<A2ATask>): void {
    const task = this.tasks.get(id);
    if (task) Object.assign(task, updates);
  }

  list(): A2ATask[] {
    return [...this.tasks.values()];
  }
}

// ---------------------------------------------------------------------------
// Agent Card (matching Python's main.py skills declaration)
// ---------------------------------------------------------------------------

export const AGENT_CARD: AgentCard = {
  name: "OpenManus",
  description:
    "A versatile AI agent that can solve various tasks using multiple tools",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  skills: [
    {
      id: "python_execute",
      name: "Python Execute Tool",
      description:
        "Executes Python code string. Only print outputs are visible.",
      tags: ["Execute Python Code"],
      examples: ["Execute Python code: print('Hello World')"],
    },
    {
      id: "browser_use",
      name: "Browser Use Tool",
      description: "Browser automation with indexed element interaction.",
      tags: ["Use Browser"],
      examples: ["go_to 'https://www.google.com'"],
    },
    {
      id: "str_replace_editor",
      name: "File Editor Tool",
      description: "View, create, and edit files with str_replace.",
      tags: ["Operate Files"],
      examples: ["Replace 'old' with 'new' in 'file.txt'"],
    },
    {
      id: "ask_human",
      name: "Ask Human Tool",
      description: "Ask human for help or clarification.",
      tags: ["Ask human for help"],
      examples: ["Ask human: 'What time is it?'"],
    },
    {
      id: "terminate",
      name: "Terminate Tool",
      description: "Terminate the interaction when task is complete.",
      tags: ["End task"],
      examples: ["Terminate with status: success"],
    },
  ],
};

// ---------------------------------------------------------------------------
// A2A Server
// ---------------------------------------------------------------------------

export class A2AServer {
  private taskStore = new TaskStore();
  private agent: Awaited<ReturnType<typeof createManusAgent>> | null = null;
  /**
   * Map stable contextId → LangGraph thread_id so multiple invokes with the
   * same contextId resume the same thread. Without this, every call would be a
   * fresh thread and HITL resume would be impossible.
   */
  private contextThreads = new Map<string, string>();

  private async getAgent() {
    if (!this.agent) {
      // HITL requires a checkpointer.
      this.agent = await createManusAgent({ checkpointer: true });
    }
    return this.agent;
  }

  private threadIdFor(contextId: string): string {
    let threadId = this.contextThreads.get(contextId);
    if (!threadId) {
      threadId = randomUUID();
      this.contextThreads.set(contextId, threadId);
    }
    return threadId;
  }

  /** Extract pending interrupt value (ask_human question) from graph state. */
  private async getPendingInterrupt(
    agent: Awaited<ReturnType<typeof createManusAgent>>,
    config: ReturnType<typeof createThreadConfig>,
  ): Promise<string | null> {
    const state = await (agent as any).getState(config);
    const tasks = state?.tasks as
      | Array<{ interrupts?: Array<{ value?: any }> }>
      | undefined;
    if (!tasks) return null;
    for (const t of tasks) {
      for (const i of t.interrupts ?? []) {
        const v = i?.value;
        if (v && typeof v === "object" && typeof v.question === "string") {
          return v.question;
        }
        if (typeof v === "string") return v;
      }
    }
    return null;
  }

  /**
   * Handle an A2A invoke request.
   *
   * If `resume` is provided, resumes the interrupted task identified by
   * `contextId` with the supplied answer (HITL continuation). Otherwise
   * starts a new task.
   *
   * Returns `requireUserInput=true` + the pending question when the graph
   * interrupts via ask_human; the caller should invoke again with `resume`.
   */
  async invoke(
    query: string,
    contextId?: string,
    resume?: string,
  ): Promise<{
    isTaskComplete: boolean;
    requireUserInput: boolean;
    content: string;
    taskId: string;
    contextId: string;
  }> {
    const ctx = contextId ?? randomUUID();
    const task = this.taskStore.create(ctx, query);
    this.taskStore.update(task.id, { status: "running" });

    try {
      const agent = await this.getAgent();
      const config = createThreadConfig(this.threadIdFor(ctx));

      const input = resume !== undefined
        ? new Command({ resume })
        : { messages: [new HumanMessage(query)] };

      const result = await agent.invoke(input, config);

      const pendingQuestion = await this.getPendingInterrupt(agent, config);
      if (pendingQuestion) {
        this.taskStore.update(task.id, {
          status: "input_required",
          pendingQuestion,
        });
        return {
          isTaskComplete: false,
          requireUserInput: true,
          content: pendingQuestion,
          taskId: task.id,
          contextId: ctx,
        };
      }

      const lastMsg = result.messages?.[result.messages.length - 1];
      const content =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : "Task completed";

      this.taskStore.update(task.id, {
        status: "completed",
        output: content,
        completedAt: Date.now(),
      });

      return {
        isTaskComplete: true,
        requireUserInput: false,
        content,
        taskId: task.id,
        contextId: ctx,
      };
    } catch (e: any) {
      this.taskStore.update(task.id, { status: "failed", output: e.message });
      throw e;
    }
  }

  /** Get the agent card. */
  getAgentCard(): AgentCard {
    return AGENT_CARD;
  }

  /** List all tasks. */
  listTasks(): A2ATask[] {
    return this.taskStore.list();
  }

  /** Get a specific task. */
  getTask(id: string): A2ATask | undefined {
    return this.taskStore.get(id);
  }
}

/**
 * Start A2A HTTP server.
 *
 * Requires Express: npm install express @types/express
 *
 * Usage:
 * ```ts
 * import { startA2AServer } from "./a2a/server.js";
 * startA2AServer({ port: 10000 });
 * ```
 */
export async function startA2AServer(
  options: { host?: string; port?: number } = {},
) {
  const { host = "localhost", port = 10000 } = options;

  // Dynamic import — Express is optional
  try {
    const { default: express } = await import("express");
    const app = express();
    app.use(express.json());

    const server = new A2AServer();

    app.get("/.well-known/agent.json", (_req: any, res: any) => {
      res.json(server.getAgentCard());
    });

    app.post("/invoke", async (req: any, res: any) => {
      try {
        const { query, contextId, resume } = req.body ?? {};
        const result = await server.invoke(query, contextId, resume);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get("/tasks", (_req: any, res: any) => {
      res.json(server.listTasks());
    });

    app.get("/tasks/:id", (req: any, res: any) => {
      const task = server.getTask(req.params.id);
      if (task) res.json(task);
      else res.status(404).json({ error: "Task not found" });
    });

    app.listen(port, host, () => {
      logger.info(
        { host, port },
        `A2A server started at http://${host}:${port}`,
      );
      logger.info(`Agent card: http://${host}:${port}/.well-known/agent.json`);
    });
  } catch {
    logger.error("Express not installed. Run: npm install express");
  }
}
