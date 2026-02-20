import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useDocumentStore } from "@/stores/document-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";

function WorkspaceWithClaude() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  useKeyboardShortcuts();

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split("/").pop() || "Open-Prism";
      getCurrentWindow().setTitle(`${name} - Open-Prism`);
    }
  }, [projectRoot]);

  return (
    <>
      <WorkspaceLayout />
      <Toaster />
    </>
  );
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <TooltipProvider>
        {projectRoot ? <WorkspaceWithClaude /> : <ProjectPicker />}
      </TooltipProvider>
    </ThemeProvider>
  );
}
