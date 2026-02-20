import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";

/**
 * Hook that manages Tauri event listeners for Claude CLI streaming output.
 *
 * Follows the dual-listener pattern from opcode:
 * 1. Start with generic `claude-output` listener to catch the first `system:init` message
 * 2. Extract session_id from init → switch to `claude-output:{sessionId}` listeners
 * 3. On `claude-complete` → clean up listeners
 */
export function useClaudeEvents() {
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const listenersRef = useRef<UnlistenFn[]>([]);
  const sessionSpecificListenersRef = useRef<UnlistenFn[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isStreaming) return;

    const store = useClaudeChatStore.getState();
    currentSessionIdRef.current = null;

    // Track tool_use messages for matching with tool_results
    const pendingToolUses = new Map<
      string,
      { name: string; input: any }
    >();

    function handleStreamMessage(payload: string) {
      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }

      const chatStore = useClaudeChatStore.getState();

      // Extract session_id from system:init
      if (
        msg.type === "system" &&
        msg.subtype === "init" &&
        msg.session_id
      ) {
        currentSessionIdRef.current = msg.session_id;
        chatStore._setSessionId(msg.session_id);
        // Attach session-specific listeners
        attachSessionListeners(msg.session_id);
      }

      // Track tool_use blocks for file change detection
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            pendingToolUses.set(block.id, {
              name: block.name,
              input: block.input,
            });
          }
        }
      }

      // Detect file modifications from tool_results
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const toolUse = pendingToolUses.get(block.tool_use_id);
            if (
              toolUse &&
              !block.is_error &&
              (toolUse.name === "Write" ||
                toolUse.name === "write" ||
                toolUse.name === "Edit" ||
                toolUse.name === "edit" ||
                toolUse.name === "MultiEdit" ||
                toolUse.name === "multiedit")
            ) {
              const filePath =
                toolUse.input?.file_path || toolUse.input?.path;
              if (filePath) {
                // Reload the file in the document store
                useDocumentStore.getState().reloadFile(filePath);
              }
            }
          }
        }
      }

      // Skip duplicate user messages we already added locally
      if (
        msg.type === "user" &&
        msg.message?.content?.length === 1 &&
        msg.message.content[0].type === "text"
      ) {
        // This is Claude echoing back the user prompt — skip it
        return;
      }

      chatStore._appendMessage(msg);
    }

    function handleComplete(payload: boolean) {
      useClaudeChatStore.getState()._setStreaming(false);
      cleanupAll();
    }

    function handleError(payload: string) {
      // Stderr lines — could be warnings, not necessarily errors
      console.warn("[claude-stderr]", payload);
    }

    async function attachSessionListeners(sessionId: string) {
      // Add session-specific listeners
      const unlistenOutput = await listen<string>(
        `claude-output:${sessionId}`,
        (event) => {
          // Session-specific messages are handled here
          // Generic listener may have already processed the init message,
          // but subsequent messages come through both — we only process once.
          // Since we set up session listeners after init, the generic listener
          // handles the first few messages and session-specific handles the rest.
        }
      );
      const unlistenComplete = await listen<boolean>(
        `claude-complete:${sessionId}`,
        (event) => handleComplete(event.payload)
      );
      const unlistenError = await listen<string>(
        `claude-error:${sessionId}`,
        (event) => handleError(event.payload)
      );

      sessionSpecificListenersRef.current.push(
        unlistenOutput,
        unlistenComplete,
        unlistenError
      );
    }

    function cleanupAll() {
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
      for (const unlisten of sessionSpecificListenersRef.current) {
        unlisten();
      }
      sessionSpecificListenersRef.current = [];
    }

    // Set up generic listeners
    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<string>(
        "claude-output",
        (event) => {
          if (!cancelled) handleStreamMessage(event.payload);
        }
      );
      const unlistenComplete = await listen<boolean>(
        "claude-complete",
        (event) => {
          if (!cancelled) handleComplete(event.payload);
        }
      );
      const unlistenError = await listen<string>(
        "claude-error",
        (event) => {
          if (!cancelled) handleError(event.payload);
        }
      );

      if (cancelled) {
        unlistenOutput();
        unlistenComplete();
        unlistenError();
        return;
      }

      listenersRef.current.push(
        unlistenOutput,
        unlistenComplete,
        unlistenError
      );
    })();

    return () => {
      cancelled = true;
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
      for (const unlisten of sessionSpecificListenersRef.current) {
        unlisten();
      }
      sessionSpecificListenersRef.current = [];
    };
  }, [isStreaming]);
}
