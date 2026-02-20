import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
}

export interface ClaudeStreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
}

interface ClaudeChatState {
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // Actions
  sendPrompt: (userPrompt: string) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;

  // Internal actions (called by event hook)
  _appendMessage: (msg: ClaudeStreamMessage) => void;
  _setSessionId: (id: string) => void;
  _setStreaming: (streaming: boolean) => void;
  _setError: (error: string | null) => void;
}

// ─── Helpers ───

function buildPromptWithContext(userPrompt: string): string {
  const docState = useDocumentStore.getState();
  const activeFile = docState.files.find(
    (f) => f.id === docState.activeFileId
  );
  if (!activeFile || !activeFile.content) {
    return userPrompt;
  }

  const fileName = activeFile.name;
  const content = activeFile.content;
  const selRange = docState.selectionRange;
  const selectedText =
    selRange ? content.slice(selRange.start, selRange.end) : null;

  let contextBlock = `You are a LaTeX writing assistant integrated into the Open-Prism editor.\n\n`;
  contextBlock += `## Current Document: ${fileName}\n`;
  contextBlock += `\`\`\`latex\n${content}\n\`\`\`\n\n`;

  if (selectedText) {
    contextBlock += `## Selected Text\n\`\`\`\n${selectedText}\n\`\`\`\n\n`;
  }

  contextBlock += `## Instructions\n`;
  contextBlock += `When modifying the document, use your Edit or Write tools directly on the .tex files.\n`;
  contextBlock += `When providing LaTeX suggestions, use \`\`\`latex code blocks.\n\n`;
  contextBlock += `## User Request\n${userPrompt}`;

  return contextBlock;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  sendPrompt: async (userPrompt: string) => {
    const { sessionId, isStreaming } = get();
    if (isStreaming) return;

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set({ error: "No project open" });
      return;
    }

    // Add user message to the list for display
    const userMessage: ClaudeStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: userPrompt }],
      },
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      isStreaming: true,
      error: null,
    }));

    const prompt = buildPromptWithContext(userPrompt);
    const model = "sonnet";

    try {
      if (sessionId) {
        // Resume existing session
        await invoke("resume_claude_code", {
          projectPath,
          sessionId,
          prompt,
          model,
        });
      } else {
        // New session
        await invoke("execute_claude_code", {
          projectPath,
          prompt,
          model,
        });
      }
    } catch (err: any) {
      set({
        isStreaming: false,
        error: err?.message || String(err),
      });
    }
  },

  cancelExecution: async () => {
    try {
      await invoke("cancel_claude_execution");
    } catch {
      // ignore
    }
    set({ isStreaming: false });
  },

  clearMessages: () => {
    set({
      messages: [],
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  newSession: () => {
    set({
      messages: [],
      sessionId: null,
      error: null,
      isStreaming: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  _appendMessage: (msg: ClaudeStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      return {
        messages: [...state.messages, msg],
        totalInputTokens: state.totalInputTokens + inputDelta,
        totalOutputTokens: state.totalOutputTokens + outputDelta,
      };
    });
  },

  _setSessionId: (id: string) => {
    set({ sessionId: id });
  },

  _setStreaming: (streaming: boolean) => {
    set({ isStreaming: streaming });
  },

  _setError: (error: string | null) => {
    set({ error });
  },
}));
