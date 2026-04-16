import { Plus, MessageSquare, Menu, X } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../types.js";

interface Props {
  threads: Thread[];
  activeThreadId?: string;
  onNewChat: () => void;
  onSwitchThread: (id: string) => void;
}

function ThreadList({ threads, activeThreadId, onSwitchThread }: Pick<Props, "threads" | "activeThreadId" | "onSwitchThread">) {
  if (threads.length === 0) {
    return <p className="text-muted text-xs px-3 py-4 text-center">No conversations yet</p>;
  }
  return (
    <div className="space-y-1">
      {threads.map((t) => (
        <button
          key={t.id}
          onClick={() => onSwitchThread(t.id)}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left cursor-pointer transition-colors duration-100
            ${t.id === activeThreadId ? "bg-surface-2 text-text" : "text-text-secondary hover:bg-surface-2/50 hover:text-text"}`}
        >
          <MessageSquare size={14} className="text-muted shrink-0" />
          <span className="truncate">{t.title}</span>
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ threads, activeThreadId, onNewChat, onSwitchThread }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebarContent = (
    <>
      <div className="px-4 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-text font-semibold text-base tracking-tight">OpenManus</h1>
          <p className="text-muted text-xs mt-0.5">LangGraph Agent</p>
        </div>
        <button onClick={() => setMobileOpen(false)} className="md:hidden text-muted hover:text-text cursor-pointer">
          <X size={18} />
        </button>
      </div>

      <div className="p-3">
        <button
          onClick={() => { onNewChat(); setMobileOpen(false); }}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl
            border border-border hover:bg-surface-2
            text-text-secondary text-sm font-medium
            transition-colors duration-150 cursor-pointer"
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3">
        <ThreadList threads={threads} activeThreadId={activeThreadId} onSwitchThread={(id) => { onSwitchThread(id); setMobileOpen(false); }} />
      </div>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-40 p-2 rounded-lg bg-surface border border-border text-muted hover:text-text cursor-pointer"
      >
        <Menu size={18} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="w-72 bg-surface border-r border-border flex flex-col shadow-2xl shadow-black/50">
            {sidebarContent}
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      {/* Desktop */}
      <div className="hidden md:flex flex-col w-64 bg-surface border-r border-border shrink-0">
        {sidebarContent}
      </div>
    </>
  );
}
