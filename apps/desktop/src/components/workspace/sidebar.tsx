import { useState, useRef, useCallback, useMemo } from "react";
import {
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  PlusIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];

  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;

  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };

  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({
        level: levelMap[type] ?? 2,
        title: title.trim(),
        line: index + 1,
      });
    }
  });

  return toc;
}

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const APP_VERSION = "0.0.1";

export function Sidebar() {
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const content = useDocumentStore((s) => s.content);
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );
  const closeProject = useDocumentStore((s) => s.closeProject);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const { theme, setTheme } = useTheme();

  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const toc = useMemo(() => parseTableOfContents(content), [content]);

  const handleTocClick = useCallback(
    (line: number) => {
      const lines = content.split("\n");
      let position = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        position += lines[i].length + 1;
      }
      requestJumpToPosition(position);
    },
    [content, requestJumpToPosition],
  );
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFileName, setNewFileName] = useState("");

  const handleAddTexFile = () => {
    const name = newFileName.trim() || "untitled.tex";
    const finalName = name.endsWith(".tex") ? name : `${name}.tex`;
    createNewFile(finalName, "tex");
    setNewFileName("");
    setAddDialogOpen(false);
  };

  const handleUploadClick = async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [
        { name: "LaTeX & Images", extensions: ["tex", "png", "jpg", "jpeg", "gif", "svg", "bmp", "webp", "bib"] },
      ],
    });
    // File upload in desktop mode would copy files to the project folder
    // For now, this opens a file dialog - the actual copy is handled in the store
    if (selected && projectRoot) {
      // TODO: copy selected files to project folder
    }
  };

  const openRenameDialog = (file: ProjectFile) => {
    setRenameFileId(file.id);
    setRenameValue(file.name);
    setRenameDialogOpen(true);
  };

  const handleRename = () => {
    if (renameFileId && renameValue.trim()) {
      renameFile(renameFileId, renameValue.trim());
    }
    setRenameDialogOpen(false);
    setRenameFileId(null);
    setRenameValue("");
  };

  const getFileIcon = (file: ProjectFile) => {
    if (file.type === "image") {
      return <ImageIcon className="size-4" />;
    }
    return <FileTextIcon className="size-4" />;
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center justify-between border-sidebar-border border-b px-3">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">OpenPrism</span>
          <span className="text-muted-foreground text-xs">
            {projectRoot?.split("/").pop() || "Desktop"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={closeProject}
          title="Close Project"
        >
          <FolderOpenIcon className="size-3.5" />
        </Button>
      </div>

      <div className="flex h-9 items-center justify-between border-sidebar-border border-b px-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-xs">Files</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6" title="Add">
              <PlusIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setAddDialogOpen(true)}>
              <FileTextIcon className="mr-2 size-4" />
              New LaTeX File
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUploadClick}>
              <UploadIcon className="mr-2 size-4" />
              Import File
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {files.map((file) => (
          <div
            key={file.id}
            className={cn(
              "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              file.id === activeFileId
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/50",
            )}
          >
            <button
              className="flex flex-1 items-center gap-2 overflow-hidden"
              onClick={() => setActiveFile(file.id)}
            >
              {getFileIcon(file)}
              <span className="truncate">
                {file.relativePath}
                {file.isDirty && <span className="ml-1 text-muted-foreground">*</span>}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 opacity-0 group-hover:opacity-100"
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openRenameDialog(file)}>
                  <PencilIcon className="mr-2 size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => deleteFile(file.id)}
                  disabled={files.length <= 1}
                >
                  <Trash2Icon className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      <div className="flex h-9 items-center gap-2 border-sidebar-border border-t px-3">
        <ListIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-xs">Outline</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {toc.length > 0 ? (
          toc.map((item, index) => (
            <button
              key={index}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
              style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
              onClick={() => handleTocClick(item.line)}
            >
              <HashIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.title}</span>
            </button>
          ))
        ) : (
          <div className="px-2 py-1 text-muted-foreground text-xs">
            No sections found
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>OpenPrism v{APP_VERSION}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/assistant-ui/open-prism"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <GithubIcon className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => {
              if (theme === "system") setTheme("light");
              else if (theme === "light") setTheme("dark");
              else setTheme("system");
            }}
            title={
              theme === "system"
                ? "System theme"
                : theme === "light"
                  ? "Light mode"
                  : "Dark mode"
            }
          >
            {theme === "system" ? (
              <MonitorIcon className="size-3.5" />
            ) : theme === "light" ? (
              <SunIcon className="size-3.5" />
            ) : (
              <MoonIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New LaTeX File</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="filename.tex"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddTexFile();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddTexFile}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
