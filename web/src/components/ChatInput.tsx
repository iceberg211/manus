import { useState, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className="px-4 py-3 border-t border-border bg-surface">
      <div className="flex items-end gap-3 max-w-3xl mx-auto">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          placeholder="Send a message... (Enter to send, Shift+Enter for new line)"
          disabled={disabled}
          rows={1}
          className="flex-1 px-4 py-3 rounded-xl bg-surface-2 border border-border
            text-text text-sm font-sans resize-none outline-none
            placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/30
            transition-colors duration-150 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="p-3 rounded-xl bg-primary hover:bg-primary-hover
            text-white transition-colors duration-150
            disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer
            focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
