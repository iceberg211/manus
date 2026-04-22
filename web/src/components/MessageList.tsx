import { useEffect, useRef } from "react";
import { AlertCircle, Bot, User } from "lucide-react";
import Markdown from "react-markdown";
import type { ChatMessage } from "../types.js";
import { ToolCallCard } from "./ToolCallCard.js";

const EMPTY_STATE_HINTS = [
  "List files in the current directory",
  "Create a Python script and run it",
  "Search the web for LangGraph docs",
  "Help me analyze some data",
];

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

function TimeStamp({ ts }: { ts: number }) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <span className="text-[10px] text-muted mt-1 px-1">{time}</span>;
}

function Avatar({ role }: { role: string }) {
  if (role === "user") {
    return (
      <div className="w-7 h-7 rounded-lg bg-user-bubble flex items-center justify-center shrink-0">
        <User size={14} className="text-white" />
      </div>
    );
  }
  return (
    <div className="w-7 h-7 rounded-lg bg-surface-2 border border-border flex items-center justify-center shrink-0">
      <Bot size={14} className="text-accent" />
    </div>
  );
}

export function MessageList({
  messages,
  loading,
  onSuggestionClick,
}: {
  messages: ChatMessage[];
  loading: boolean;
  onSuggestionClick: (text: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Build a map: toolCallId → tool_result message for pairing
  const resultMap = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "tool_result" && m.toolCallId) {
      resultMap.set(m.toolCallId, m);
    }
  }

  // Track which tool_result IDs have been rendered (via their tool_call pair)
  const renderedResultIds = new Set<string>();

  return (
    <div className="flex-1 overflow-auto px-4 py-6">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-muted select-none">
          <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-border flex items-center justify-center mb-4">
            <Bot size={28} className="text-accent opacity-50" />
          </div>
          <p className="text-lg font-medium text-text">OpenManus</p>
          <p className="text-sm mt-1 mb-6">AI Agent powered by LangGraph</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md w-full">
            {EMPTY_STATE_HINTS.map((hint) => (
              <button
                key={hint}
                onClick={() => onSuggestionClick(hint)}
                className="px-3 py-2 text-xs text-text-secondary bg-surface border border-border rounded-lg hover:bg-surface-2 transition-colors cursor-pointer text-left"
              >
                {hint}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4 max-w-3xl mx-auto">
        {messages.map((msg, i) => {
          // Skip tool_result if already rendered as part of a tool_call pair
          if (msg.role === "tool_result" && msg.toolCallId && renderedResultIds.has(msg.toolCallId)) {
            return null;
          }

          // Tool call — pair with its result
          if (msg.role === "tool_call") {
            const result = msg.toolCallId ? resultMap.get(msg.toolCallId) : undefined;
            if (result?.toolCallId) renderedResultIds.add(result.toolCallId);
            return <ToolCallCard key={msg.id} msg={msg} resultMsg={result} />;
          }

          // Standalone tool_result (no matching call)
          if (msg.role === "tool_result") {
            return <ToolCallCard key={msg.id} msg={msg} />;
          }

          // Error
          if (msg.role === "error") {
            return (
              <div key={msg.id} className="flex items-start gap-2 px-4 py-3 rounded-lg bg-danger/10 border border-danger/20">
                <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
                <span className="text-danger text-sm">{msg.content}</span>
              </div>
            );
          }

          // User / Assistant
          const isUser = msg.role === "user";
          const isEmpty = !msg.content && msg.role === "assistant";

          // Skip empty trailing assistant (it's just a streaming placeholder)
          if (isEmpty && !loading) return null;

          return (
            <div key={msg.id} className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
              <Avatar role={msg.role} />
              <div className="flex flex-col min-w-0" style={{ maxWidth: "80%" }}>
                <div
                  className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                    isUser
                      ? "bg-user-bubble text-white rounded-tr-md"
                      : "bg-surface border border-border text-text rounded-tl-md"
                  }`}
                >
                  {isEmpty && loading ? (
                    <StreamingDots />
                  ) : isUser ? (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  ) : (
                    <div className="prose-agent">
                      <Markdown>{msg.content}</Markdown>
                    </div>
                  )}
                </div>
                <TimeStamp ts={msg.timestamp} />
              </div>
            </div>
          );
        })}
      </div>

      <div ref={endRef} />
    </div>
  );
}
