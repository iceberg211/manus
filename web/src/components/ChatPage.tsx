import { useChat } from "../hooks/useChat.js";
import { MessageList } from "./MessageList.js";
import { ChatInput } from "./ChatInput.js";
import { InterruptDialog } from "./InterruptDialog.js";
import { Sidebar } from "./Sidebar.js";

export function ChatPage() {
  const { messages, loading, interrupt, threads, activeThreadId, send, resume, newChat, switchThread } = useChat();

  return (
    <div className="flex h-dvh bg-bg text-text font-sans">
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onNewChat={newChat}
        onSwitchThread={switchThread}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header — left space for hamburger */}
        <div className="md:hidden flex items-center gap-2 px-4 py-3 border-b border-border bg-surface">
          <div className="w-8" />
          <span className="text-text font-semibold flex-1 text-center">OpenManus</span>
          <span className="text-xs text-muted bg-surface-2 px-2 py-0.5 rounded">Agent</span>
        </div>

        <MessageList messages={messages} loading={loading} />
        <ChatInput onSend={send} disabled={loading} />
      </div>

      {interrupt && <InterruptDialog interrupt={interrupt} onResume={resume} />}
    </div>
  );
}
