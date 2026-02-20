import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpenIcon,
  ClockIcon,
  XIcon,
  FileTextIcon,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { Button } from "@/components/ui/button";

export function ProjectPicker() {
  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const handleOpenFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open LaTeX Project Folder",
    });
    if (selected) {
      addRecentProject(selected);
      await openProject(selected);
    }
  };

  const handleOpenRecent = async (path: string) => {
    addRecentProject(path);
    await openProject(path);
  };

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex w-full max-w-md flex-col items-center gap-8 px-8">
        <div className="flex flex-col items-center gap-2">
          <FileTextIcon className="size-12 text-primary" />
          <h1 className="font-bold text-2xl">Open-Prism</h1>
          <p className="text-center text-muted-foreground text-sm">
            AI-powered LaTeX writing workspace
          </p>
        </div>

        <Button
          onClick={handleOpenFolder}
          size="lg"
          className="w-full gap-2"
        >
          <FolderOpenIcon className="size-5" />
          Open Project Folder
        </Button>

        {recentProjects.length > 0 && (
          <div className="w-full">
            <div className="mb-3 flex items-center gap-2 text-muted-foreground text-sm">
              <ClockIcon className="size-4" />
              <span>Recent Projects</span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className="group flex items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted"
                >
                  <button
                    className="flex flex-1 flex-col items-start overflow-hidden text-left"
                    onClick={() => handleOpenRecent(project.path)}
                  >
                    <span className="truncate font-medium text-sm">
                      {project.name}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {project.path}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(project.path);
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
