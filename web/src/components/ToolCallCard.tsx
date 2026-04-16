import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, CheckCircle2, Clock } from "lucide-react";
import type { ChatMessage } from "../types.js";

export function ToolCallCard({ msg, resultMsg }: { msg: ChatMessage; resultMsg?: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isCall = msg.role === "tool_call";
  const hasResult = !!resultMsg;
  const duration = hasResult ? ((resultMsg.timestamp - msg.timestamp) / 1000).toFixed(1) : null;

  return (
    <div className="mx-2 my-1.5 rounded-xl border border-border overflow-hidden bg-surface-2/50">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-mono
          hover:bg-surface-2 transition-colors duration-100 cursor-pointer text-left"
      >
        {hasResult ? (
          <CheckCircle2 size={14} className="text-accent shrink-0" />
        ) : (
          <Wrench size={14} className="text-primary shrink-0 animate-spin" style={{ animationDuration: "2s" }} />
        )}
        <span className="text-text font-medium truncate">{msg.toolName}</span>
        {duration && (
          <span className="text-muted text-xs flex items-center gap-1 ml-auto shrink-0">
            <Clock size={10} />
            {duration}s
          </span>
        )}
        {!hasResult && (
          <span className="text-primary text-xs ml-auto shrink-0 animate-pulse">running...</span>
        )}
        <span className="ml-1">
          {expanded ? (
            <ChevronDown size={14} className="text-muted" />
          ) : (
            <ChevronRight size={14} className="text-muted" />
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border">
          {/* Args */}
          <div className="px-3 py-2">
            <p className="text-muted text-xs mb-1 font-sans">Arguments</p>
            <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {msg.content}
            </pre>
          </div>
          {/* Result */}
          {hasResult && (
            <div className="px-3 py-2 border-t border-border bg-bg/50">
              <p className="text-muted text-xs mb-1 font-sans">Result</p>
              <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {resultMsg.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
