import { useState, type KeyboardEvent } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import type { InterruptState } from "../types.js";

interface Props {
  interrupt: InterruptState;
  onResume: (answer: string) => void;
}

export function InterruptDialog({ interrupt, onResume }: Props) {
  const [answer, setAnswer] = useState("");

  const handleSubmit = () => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    onResume(trimmed);
    setAnswer("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-2xl p-6 max-w-md w-[90%] shadow-2xl shadow-black/40">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10">
            <MessageCircleQuestion size={20} className="text-primary" />
          </div>
          <h3 className="text-text font-semibold text-base">Agent needs your input</h3>
        </div>

        <p className="text-text-secondary text-sm leading-relaxed mb-4">
          {interrupt.question}
        </p>

        {interrupt.context && (
          <p className="text-muted text-xs mb-4 px-3 py-2 bg-surface-2 rounded-lg">{interrupt.context}</p>
        )}

        <div className="flex gap-2">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your answer..."
            rows={2}
            autoFocus
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-2 border border-border
              text-text text-sm resize-none outline-none
              focus:border-primary focus:ring-1 focus:ring-primary/30
              placeholder:text-muted transition-colors duration-150"
          />
          <button
            onClick={handleSubmit}
            disabled={!answer.trim()}
            className="self-end p-2.5 rounded-xl bg-accent hover:bg-accent-hover
              text-white transition-colors duration-150
              disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
