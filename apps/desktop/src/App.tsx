import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { ThemeProvider } from "next-themes";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useDocumentStore } from "@/stores/document-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";

const SIDECAR_URL = "http://localhost:3001";

function WorkspaceWithRuntime() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${SIDECAR_URL}/api/chat`,
        body: { projectDir: projectRoot },
      }),
    [projectRoot],
  );

  const runtime = useChatRuntime({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  useKeyboardShortcuts();

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split("/").pop() || "Open-Prism";
      getCurrentWindow().setTitle(`${name} - Open-Prism`);
    }
  }, [projectRoot]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkspaceLayout />
      <Toaster />
    </AssistantRuntimeProvider>
  );
}

export function App() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <TooltipProvider>
        {projectRoot ? <WorkspaceWithRuntime /> : <ProjectPicker />}
      </TooltipProvider>
    </ThemeProvider>
  );
}
