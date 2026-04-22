/**
 * Test Suite — verify graph structure and tool execution.
 * Does NOT require an OpenAI API key.
 */
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { buildReactAgent } from "@/graphs/reactAgent";
import { bash, bashSession } from "@/tools/bash";
import { codeExecute } from "@/tools/codeExecute";
import { terminate } from "@/tools/terminate";
import { strReplaceEditor } from "@/tools/strReplaceEditor";
import { webSearch } from "@/tools/webSearch";
import { askHuman } from "@/tools/askHuman";
import { createThreadConfig } from "@/config/persistence";

async function testGraphStructure() {
  console.log("=== Test 1: Graph Structure ===\n");

  const agent = buildReactAgent({
    model: new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0,
      apiKey: "sk-test-dummy",
    }),
    tools: [bash, codeExecute],
    systemPrompt: "You are a test agent.",
  });

  const graphDef = agent.getGraph();
  const nodeIds = Object.keys(graphDef.nodes);
  console.log("Nodes:", nodeIds);

  const edgeList = graphDef.edges.map((e: any) => `${e.source} → ${e.target}`);
  console.log("Edges:", edgeList);

  // Verify expected nodes exist
  const expected = ["__start__", "think", "tools", "inject_unstuck", "__end__"];
  const allPresent = expected.every((n) => nodeIds.includes(n));
  console.log(`\nAll expected nodes present: ${allPresent ? "✅" : "❌"}`);

  // Verify key edges
  const hasStartToThink = edgeList.includes("__start__ → think");
  const hasThinkToTools = edgeList.some(
    (e: string) => e.includes("think") && e.includes("tools"),
  );
  const hasToolsToThink = edgeList.some(
    (e: string) => e.startsWith("tools") && e.includes("think"),
  );
  console.log(`START → think: ${hasStartToThink ? "✅" : "❌"}`);
  console.log(`think → tools: ${hasThinkToTools ? "✅" : "❌"}`);
  console.log(`tools → think: ${hasToolsToThink ? "✅" : "❌"}`);
}

async function testBashTool() {
  console.log("\n=== Test 2: Bash Tool (standalone) ===\n");

  const result1 = await bash.invoke({ command: "echo 'hello from bash'" });
  console.log(
    `echo test: ${result1.includes("hello from bash") ? "✅" : "❌"} — "${result1.trim()}"`,
  );

  // Test session persistence (cd should survive across calls)
  await bash.invoke({ command: "cd /tmp" });
  const result2 = await bash.invoke({ command: "pwd" });
  console.log(
    `session persistence (cd /tmp → pwd): ${result2.includes("/tmp") ? "✅" : "❌"} — "${result2.trim()}"`,
  );

  // Test env var persistence
  await bash.invoke({ command: "export MY_TEST_VAR=langgraph" });
  const result3 = await bash.invoke({ command: "echo $MY_TEST_VAR" });
  console.log(
    `env var persistence: ${result3.includes("langgraph") ? "✅" : "❌"} — "${result3.trim()}"`,
  );

  bashSession.stop();
}

async function testCodeExecuteTool() {
  console.log("\n=== Test 3: CodeExecute Tool (standalone) ===\n");

  const result1 = await codeExecute.invoke({
    code: "print('hello from python')",
  });
  console.log(
    `print test: ${result1.includes("hello from python") ? "✅" : "❌"} — "${result1.trim()}"`,
  );

  const result2 = await codeExecute.invoke({
    code: "import sys; print(sys.version)",
  });
  console.log(
    `sys.version: ${result2.includes("Python") || result2.includes("3.") ? "✅" : "❌"} — "${result2.trim().slice(0, 60)}"`,
  );

  // Test timeout
  const result3 = await codeExecute.invoke({
    code: "import time; time.sleep(10); print('done')",
    timeout: 2,
  });
  console.log(
    `timeout test: ${result3.includes("timeout") ? "✅" : "❌"} — "${result3.trim()}"`,
  );
}

async function testToolNode() {
  console.log("\n=== Test 4: ToolNode integration ===\n");

  const tools = [bash, codeExecute, terminate];
  const toolNode = new ToolNode(tools, { handleToolErrors: true });

  // Simulate an AIMessage with a tool call (what LLM would return)
  const aiMsg = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "call_1",
        name: "bash",
        args: { command: "echo 'ToolNode works!'" },
      },
    ],
  });

  const result = await toolNode.invoke({ messages: [aiMsg] });
  const toolMsg = result.messages[0];
  const output =
    typeof toolMsg.content === "string"
      ? toolMsg.content
      : JSON.stringify(toolMsg.content);
  console.log(
    `ToolNode bash execution: ${output.includes("ToolNode works!") ? "✅" : "❌"} — "${output.trim()}"`,
  );

  bashSession.stop();
}

async function testStrReplaceEditor() {
  console.log("\n=== Test 5: StrReplaceEditor Tool ===\n");
  const testDir = "/tmp/openmanus-test-" + Date.now();
  const testFile = `${testDir}/test.txt`;

  // Setup
  const { mkdirSync } = await import("fs");
  const { readFileSync } = await import("fs");
  mkdirSync(testDir, { recursive: true });

  // Test create
  const r1 = await strReplaceEditor.invoke({
    command: "create",
    path: testFile,
    fileText: "line 1\nline 2\nline 3\nline 4\nline 5",
  });
  console.log(`create: ${r1.includes("created successfully") ? "✅" : "❌"}`);

  // Test create refuses overwrite
  const r2 = await strReplaceEditor.invoke({
    command: "create",
    path: testFile,
    fileText: "overwrite",
  });
  console.log(`create no-overwrite: ${r2.includes("already exists") ? "✅" : "❌"}`);

  // Test view
  const r3 = await strReplaceEditor.invoke({ command: "view", path: testFile });
  console.log(`view: ${r3.includes("line 1") && r3.includes("line 5") ? "✅" : "❌"}`);

  // Test view with range
  const r4 = await strReplaceEditor.invoke({
    command: "view",
    path: testFile,
    viewRange: [2, 3],
  });
  console.log(`view range [2,3]: ${r4.includes("line 2") && r4.includes("line 3") && !r4.includes("line 1") ? "✅" : "❌"}`);

  // Test str_replace
  const r5 = await strReplaceEditor.invoke({
    command: "str_replace",
    path: testFile,
    oldStr: "line 3",
    newStr: "line THREE (replaced)",
  });
  console.log(`str_replace: ${r5.includes("has been edited") ? "✅" : "❌"}`);
  const content5 = readFileSync(testFile, "utf-8");
  console.log(`str_replace content: ${content5.includes("line THREE (replaced)") ? "✅" : "❌"}`);

  // Test str_replace uniqueness (should fail — "line" appears multiple times)
  const r6 = await strReplaceEditor.invoke({
    command: "str_replace",
    path: testFile,
    oldStr: "line",
    newStr: "LINE",
  });
  console.log(`str_replace uniqueness: ${r6.includes("Multiple occurrences") ? "✅" : "❌"}`);

  // Test insert
  const r7 = await strReplaceEditor.invoke({
    command: "insert",
    path: testFile,
    insertLine: 2,
    newStr: "inserted after line 2",
  });
  console.log(`insert: ${r7.includes("has been edited") ? "✅" : "❌"}`);
  const content7 = readFileSync(testFile, "utf-8");
  console.log(`insert content: ${content7.includes("inserted after line 2") ? "✅" : "❌"}`);

  // Test undo_edit
  const r8 = await strReplaceEditor.invoke({
    command: "undo_edit",
    path: testFile,
  });
  console.log(`undo_edit: ${r8.includes("undone successfully") ? "✅" : "❌"}`);
  const content8 = readFileSync(testFile, "utf-8");
  console.log(`undo content: ${!content8.includes("inserted after line 2") ? "✅" : "❌"}`);

  // Test view directory
  const r9 = await strReplaceEditor.invoke({
    command: "view",
    path: testDir,
  });
  console.log(`view directory: ${r9.includes("test.txt") ? "✅" : "❌"}`);

  // Test absolute path validation
  const r10 = await strReplaceEditor.invoke({
    command: "view",
    path: "relative/path",
  });
  console.log(`absolute path check: ${r10.includes("not an absolute path") ? "✅" : "❌"}`);

  // Cleanup
  const { rmSync } = await import("fs");
  rmSync(testDir, { recursive: true, force: true });
}

async function testWebSearch() {
  console.log("\n=== Test 6: WebSearch Tool ===\n");

  const r1 = await webSearch.invoke({ query: "TypeScript programming language" });
  const hasResults = r1.includes("Search results for") && r1.includes("URL:");
  console.log(`search returns results: ${hasResults ? "✅" : "❌"}`);
  if (!hasResults) console.log("  (Note: may fail without internet or if DDG blocks)");

  // Verify structured format
  const hasPosition = /\d+\.\s/.test(r1);
  console.log(`structured format: ${hasPosition ? "✅" : "❌"}`);
}

async function testHITLGraphStructure() {
  console.log("\n=== Test 7: HITL Graph Structure ===\n");

  const agent = buildReactAgent({
    model: new ChatOpenAI({ modelName: "gpt-4o", temperature: 0, apiKey: "sk-test-dummy" }),
    tools: [bash],
    enableHumanInTheLoop: true,
    checkpointer: true,
  });

  const graphDef = agent.getGraph();
  const nodeIds = Object.keys(graphDef.nodes);
  const hasHumanReview = nodeIds.includes("human_review");
  console.log(`human_review node present: ${hasHumanReview ? "✅" : "❌"}`);

  const edgeList = graphDef.edges.map((e: any) => `${e.source} → ${e.target}`);
  const hasThinkToHuman = edgeList.some((e: string) => e.includes("think") && e.includes("human_review"));
  const hasHumanToThink = edgeList.includes("human_review → think");
  console.log(`think → human_review edge: ${hasThinkToHuman ? "✅" : "❌"}`);
  console.log(`human_review → think edge: ${hasHumanToThink ? "✅" : "❌"}`);

  console.log(`Total nodes: ${nodeIds.length} (expect 5: __start__, think, tools, inject_unstuck, human_review, __end__)`);
}

async function testPersistenceConfig() {
  console.log("\n=== Test 8: Persistence Config ===\n");

  // Test thread config creation
  const config1 = createThreadConfig("test-thread-1");
  console.log(`thread config: ${config1.configurable?.thread_id === "test-thread-1" ? "✅" : "❌"}`);

  // Test auto-generated thread ID
  const config2 = createThreadConfig();
  const hasUUID = typeof config2.configurable?.thread_id === "string" && config2.configurable.thread_id.length > 10;
  console.log(`auto thread_id: ${hasUUID ? "✅" : "❌"}`);

  // Test graph with checkpointer accepts thread_id
  const agent = buildReactAgent({
    model: new ChatOpenAI({ modelName: "gpt-4o", temperature: 0, apiKey: "sk-test-dummy" }),
    tools: [bash],
    checkpointer: true,
  });

  // Verify getState works with thread config
  try {
    const state = await agent.getState(config1);
    console.log(`getState with thread: ${state !== null ? "✅" : "❌"}`);
  } catch (e: any) {
    console.log(`getState with thread: ❌ — ${e.message}`);
  }
}

async function main() {
  try {
    await testGraphStructure();
    await testBashTool();
    await testCodeExecuteTool();
    await testToolNode();
    await testStrReplaceEditor();
    await testWebSearch();
    await testHITLGraphStructure();
    await testPersistenceConfig();
    console.log("\n=== All Tests Complete ===\n");
  } catch (e) {
    console.error("Test failed:", e);
    process.exit(1);
  }
}

main();
