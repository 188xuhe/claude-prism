import { type FC, useEffect, useMemo, useRef } from "react";
import { BotIcon, UserIcon } from "lucide-react";
import { useClaudeChatStore, type ClaudeStreamMessage, type ContentBlock } from "@/stores/claude-chat-store";
import { MarkdownRenderer } from "./markdown-renderer";
import { ToolWidget } from "./tool-widgets";

export const ChatMessages: FC = () => {
  const messages = useClaudeChatStore((s) => s.messages);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Build a map of tool_use_id → tool_result for inline display
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ContentBlock>();
    for (const msg of messages) {
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Filter displayable messages
  const displayMessages = useMemo(() => {
    return messages.filter((msg) => {
      // Skip system:init (rendered as a subtle header if needed)
      if (msg.type === "system" && msg.subtype === "init") return false;
      // Skip user messages that only contain tool_results
      if (msg.type === "user" && msg.message?.content) {
        const hasOnlyToolResults = msg.message.content.every(
          (b) => b.type === "tool_result"
        );
        if (hasOnlyToolResults) return false;
      }
      return true;
    });
  }, [messages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [displayMessages.length]);

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0 overflow-y-auto scroll-smooth px-4 py-2"
    >
      {displayMessages.length === 0 && !isStreaming && (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Ask Claude about your LaTeX document...
        </div>
      )}

      {displayMessages.map((msg, idx) => (
        <MessageBubble
          key={idx}
          message={msg}
          toolResultMap={toolResultMap}
        />
      ))}

      {isStreaming && (
        <div className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground">
          <div className="flex gap-0.5">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "0ms" }} />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "150ms" }} />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm">Thinking...</span>
        </div>
      )}
    </div>
  );
};

// ─── Message Bubble ───

const MessageBubble: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
}> = ({ message, toolResultMap }) => {
  if (message.type === "user") {
    return <UserMessage message={message} />;
  }
  if (message.type === "assistant") {
    return <AssistantMessage message={message} toolResultMap={toolResultMap} />;
  }
  if (message.type === "result") {
    return <ResultMessage message={message} />;
  }
  return null;
};

// ─── User Message ───

const UserMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const textContent = message.message?.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!textContent) return null;

  return (
    <div className="flex w-full flex-col items-end py-1.5">
      <div className="max-w-[85%] rounded-xl bg-muted px-3 py-1.5 text-foreground text-sm">
        {textContent}
      </div>
    </div>
  );
};

// ─── Assistant Message ───

const AssistantMessage: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
}> = ({ message, toolResultMap }) => {
  const content = message.message?.content;
  if (!content || content.length === 0) return null;

  return (
    <div className="w-full py-1.5">
      <div className="px-1 text-foreground text-sm leading-relaxed">
        {content.map((block, idx) => {
          if (block.type === "text" && block.text) {
            return (
              <MarkdownRenderer
                key={idx}
                content={block.text}
                className="prose prose-sm dark:prose-invert max-w-none"
              />
            );
          }
          if (block.type === "tool_use" && block.id) {
            const result = toolResultMap.get(block.id);
            return (
              <ToolWidget
                key={idx}
                toolUse={block}
                toolResult={result}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
};

// ─── Result Message ───

const ResultMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const isError = message.is_error || message.subtype === "error";
  const resultText = message.result;

  if (!resultText) return null;

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {isError ? (
        <span className="text-destructive">{resultText}</span>
      ) : (
        <span>{resultText}</span>
      )}
      {message.cost_usd && (
        <span className="ml-2">
          Cost: ${message.cost_usd.toFixed(4)}
        </span>
      )}
    </div>
  );
};
