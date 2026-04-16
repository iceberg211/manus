/**
 * Persistence Configuration — Checkpointer setup and thread management.
 *
 * LangGraph persistence concepts (from langgraph-persistence skill):
 *
 * - Checkpointer: Saves/loads graph state at every super-step
 *   - MemorySaver: dev only, data lost on restart
 *   - PostgresSaver: production, persistent across restarts
 *
 * - Thread ID: Identifies separate checkpoint sequences (conversations)
 *   - Different threads maintain isolated state
 *   - Same thread resumes from last checkpoint
 *
 * - Store: Cross-thread memory (user preferences, facts)
 *   - InMemoryStore for dev, persistent store for prod
 *
 * OpenManus had NO persistence — agent state was lost when process exits.
 * This is a major upgrade.
 */
import { MemorySaver, InMemoryStore } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { randomUUID } from "crypto";

// Re-export for convenience
export { MemorySaver, InMemoryStore };

/**
 * Create a development checkpointer (in-memory, lost on restart).
 */
export function createDevCheckpointer(): MemorySaver {
  return new MemorySaver();
}

/**
 * Create a production checkpointer (PostgreSQL).
 *
 * Requires: npm install @langchain/langgraph-checkpoint-postgres
 *
 * Usage:
 * ```ts
 * const checkpointer = await createProdCheckpointer("postgresql://user:pass@localhost/db");
 * const graph = builder.compile({ checkpointer });
 * ```
 */
export async function createProdCheckpointer(connectionString: string) {
  // Dynamic import — only load if postgres package is installed
  try {
    // @ts-expect-error — optional dependency, only loaded when installed
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    const checkpointer = PostgresSaver.fromConnString(connectionString);
    await checkpointer.setup(); // Create tables on first use
    return checkpointer;
  } catch (e: any) {
    throw new Error(
      `Failed to create PostgresSaver. Install: npm install @langchain/langgraph-checkpoint-postgres\n${e.message}`
    );
  }
}

/**
 * Create a config with thread_id for stateful execution.
 *
 * Usage:
 * ```ts
 * const config = createThreadConfig("user-123-session-1");
 * await graph.invoke(input, config);
 * // Later, resume same conversation:
 * await graph.invoke(newInput, config);
 * ```
 */
export function createThreadConfig(
  threadId?: string,
  extra?: Record<string, any>
): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId ?? randomUUID(),
      ...extra,
    },
  };
}

/**
 * Create a cross-thread memory store (for user preferences, etc.)
 *
 * Usage:
 * ```ts
 * const store = createMemoryStore();
 * store.put(["user-123", "prefs"], "language", { value: "en" });
 * const graph = builder.compile({ checkpointer, store });
 * ```
 */
export function createMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}

/**
 * Helper: resume an interrupted graph (HITL).
 *
 * Usage:
 * ```ts
 * // First run hits interrupt()
 * const result = await graph.invoke(input, config);
 * // result.__interrupt__ contains the question
 *
 * // Resume with user's answer
 * const resumed = await resumeWithAnswer(graph, config, "user's answer");
 * ```
 */
export async function resumeWithAnswer(
  graph: { invoke: (input: any, config: any) => Promise<any> },
  config: RunnableConfig,
  answer: string | Record<string, any>
) {
  const { Command } = await import("@langchain/langgraph");
  return graph.invoke(new Command({ resume: answer }), config);
}
