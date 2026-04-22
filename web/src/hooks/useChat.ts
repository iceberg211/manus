/**
 * useChat hook — Manages chat state, SSE streaming, HITL interrupts, and threads.
 */
import { useState, useCallback, useRef } from "react";
import type { ChatMessage, InterruptState, Thread } from "../types.js";
import { sendChat, resumeChat } from "../api/client.js";

let msgId = 0;
const nextId = () => `msg-${++msgId}-${Date.now()}`;

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [interrupt, setInterrupt] = useState<InterruptState | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const threadIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const pendingThreadTitleRef = useRef<string | undefined>(undefined);

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const addMessage = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId(), timestamp: Date.now() }]);
  }, []);

  const updateLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      // Find the last assistant message and append to it
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "assistant") {
          const updated = [...prev];
          updated[i] = { ...updated[i], content: updated[i].content + content };
          return updated;
        }
      }
      // No assistant message found — create one
      return [...prev, { id: nextId(), role: "assistant", content, timestamp: Date.now() }];
    });
  }, []);

  // Remove trailing empty assistant message (cleanup after tool-only responses)
  const cleanupEmptyAssistant = useCallback(() => {
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].role === "assistant" && !prev[prev.length - 1].content) {
        return prev.slice(0, -1);
      }
      return prev;
    });
  }, []);

  // Stable callbacks via ref to avoid stale closures
  const callbacksRef = useRef({
    onThinking: (content: string) => updateLastAssistant(content),
    onToolCall: (name: string, args: any, id: string) => {
      cleanupEmptyAssistant();
      addMessage({ role: "tool_call", content: JSON.stringify(args, null, 2), toolName: name, toolCallId: id });
    },
    onToolResult: (name: string, content: string, toolCallId: string) => {
      addMessage({ role: "tool_result", content, toolName: name, toolCallId });
      // Add a fresh assistant slot for the next thinking phase
      addMessage({ role: "assistant", content: "" });
    },
    onInterrupt: (data: InterruptState) => {
      cleanupEmptyAssistant();
      threadIdRef.current = data.threadId;
      setInterrupt(data);
      setLoading(false);
    },
    onError: (message: string) => {
      cleanupEmptyAssistant();
      addMessage({ role: "error", content: message });
      setLoading(false);
    },
    onDone: (threadId: string) => {
      cleanupEmptyAssistant();
      threadIdRef.current = threadId;
      setActiveThreadId(threadId);
      // Update thread list
      setThreads((prev) => {
        const exists = prev.find((t) => t.id === threadId);
        const title = pendingThreadTitleRef.current ?? "New conversation";
        if (exists) {
          return prev.map((t) =>
            t.id === threadId
              ? { ...t, title: t.title === "New conversation" ? title : t.title, messageCount: t.messageCount + 1 }
              : t,
          );
        }
        return [{ id: threadId, title, createdAt: Date.now(), messageCount: 1 }, ...prev];
      });
      pendingThreadTitleRef.current = undefined;
      setLoading(false);
    },
  });
  // Keep ref current
  callbacksRef.current.onThinking = (content: string) => updateLastAssistant(content);

  const send = useCallback(async (text: string) => {
    cancelInFlight();
    const controller = new AbortController();
    abortRef.current = controller;

    addMessage({ role: "user", content: text });
    setLoading(true);
    addMessage({ role: "assistant", content: "" });

    if (!threadIdRef.current) {
      pendingThreadTitleRef.current =
        text.length > 40 ? text.slice(0, 40) + "..." : text;
    }

    try {
      await sendChat(
        text,
        threadIdRef.current,
        callbacksRef.current,
        controller.signal,
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [addMessage, cancelInFlight]);

  const resume = useCallback(async (answer: string) => {
    if (!interrupt) return;
    cancelInFlight();
    const controller = new AbortController();
    abortRef.current = controller;

    addMessage({ role: "user", content: answer });
    setInterrupt(null);
    setLoading(true);
    addMessage({ role: "assistant", content: "" });
    try {
      await resumeChat(
        interrupt.threadId,
        answer,
        callbacksRef.current,
        controller.signal,
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [interrupt, addMessage, cancelInFlight]);

  const newChat = useCallback(() => {
    cancelInFlight();
    setMessages([]);
    setLoading(false);
    setInterrupt(null);
    threadIdRef.current = undefined;
    pendingThreadTitleRef.current = undefined;
    setActiveThreadId(undefined);
  }, [cancelInFlight]);

  const switchThread = useCallback((threadId: string) => {
    // For now just reset — full thread restore needs server-side getState
    newChat();
    threadIdRef.current = threadId;
    setActiveThreadId(threadId);
  }, [newChat]);

  return { messages, loading, interrupt, threads, activeThreadId, send, resume, newChat, switchThread };
}
