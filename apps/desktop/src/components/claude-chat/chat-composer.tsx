import { type FC, useCallback, useRef, useState } from "react";
import { ArrowUpIcon, SquareIcon, PlusIcon } from "lucide-react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

export const ChatComposer: FC = () => {
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const cancelExecution = useClaudeChatStore((s) => s.cancelExecution);
  const newSession = useClaudeChatStore((s) => s.newSession);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    sendPrompt(trimmed);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendPrompt]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      // Auto-resize
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    },
    []
  );

  return (
    <div className="shrink-0 p-3">
      <div className="flex w-full flex-col rounded-2xl border border-input bg-muted/30 transition-colors focus-within:border-ring focus-within:bg-background">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask about LaTeX..."
          className="max-h-40 min-h-10 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
          autoFocus
          rows={1}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <TooltipIconButton
            tooltip="New conversation"
            side="top"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            onClick={newSession}
          >
            <PlusIcon className="size-4" />
          </TooltipIconButton>

          <div>
            {isStreaming ? (
              <TooltipIconButton
                tooltip="Stop"
                side="top"
                variant="secondary"
                size="icon"
                className="size-8 rounded-full"
                onClick={cancelExecution}
              >
                <SquareIcon className="size-3 fill-current" />
              </TooltipIconButton>
            ) : (
              <TooltipIconButton
                tooltip="Send"
                side="top"
                variant="default"
                size="icon"
                className="size-8 rounded-full"
                onClick={handleSend}
                disabled={!input.trim()}
              >
                <ArrowUpIcon className="size-4" />
              </TooltipIconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
