import { useState, useCallback, useMemo } from "react";
import {
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ImageIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FileIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTheme } from "next-themes";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { cn } from "@/lib/utils";
import { ZoteroPanel, ZoteroHeader } from "@/components/workspace/zotero-panel";
import { Button } from "@/components/ui/button";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ─── Table of Contents ───

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
      toc.push({ level: levelMap[type] ?? 2, title: title.trim(), line: index + 1 });
    }
  });
  return toc;
}

// ─── File Tree Builder ───

interface TreeNode {
  name: string;
  relativePath: string;
  type: "folder" | "file";
  file?: ProjectFile;
  children: TreeNode[];
}

function buildFileTree(files: ProjectFile[], folders: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  function getOrCreateFolder(path: string): TreeNode[] {
    if (!path) return root;
    if (folderMap.has(path)) return folderMap.get(path)!.children;

    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(parentPath);

    const folder: TreeNode = {
      name,
      relativePath: path,
      type: "folder",
      children: [],
    };
    folderMap.set(path, folder);
    parentChildren.push(folder);
    return folder.children;
  }

  // Ensure all known folders exist as nodes (including empty ones)
  for (const folderPath of folders) {
    getOrCreateFolder(folderPath);
  }

  for (const file of files) {
    const parts = file.relativePath.split("/");
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(folderPath);

    parentChildren.push({
      name: fileName,
      relativePath: file.relativePath,
      type: "file",
      file,
      children: [],
    });
  }

  // Sort: folders first, then alphabetical
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.type === "folder") sortNodes(node.children);
    }
  }
  sortNodes(root);

  return root;
}

// ─── File Icon ───

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-4 shrink-0" />;
  if (file.type === "style") return <FileCodeIcon className="size-4 shrink-0" />;
  if (file.type === "other") return <FileIcon className="size-4 shrink-0" />;
  return <FileTextIcon className="size-4 shrink-0" />;
}

// ─── Constants ───

const APP_VERSION = "0.0.1";

// ─── Sidebar ───

export function Sidebar() {
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const createFolder = useDocumentStore((s) => s.createFolder);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const activeFileContent = useDocumentStore((s) => {
    const active = s.files.find((f) => f.id === s.activeFileId);
    return active?.content ?? "";
  });
  const requestJumpToPosition = useDocumentStore((s) => s.requestJumpToPosition);
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const closeProject = useDocumentStore((s) => s.closeProject);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const folders = useDocumentStore((s) => s.folders);
  const { theme, setTheme } = useTheme();

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogFolder, setAddDialogFolder] = useState<string | undefined>();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogParent, setFolderDialogParent] = useState<string | undefined>();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  // Folder expand/collapse
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(files, folders), [files, folders]);

  // Auto-expand all folders on tree change
  useMemo(() => {
    const allFolders = new Set<string>();
    function collectFolders(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.type === "folder") {
          allFolders.add(n.relativePath);
          collectFolders(n.children);
        }
      }
    }
    collectFolders(tree);
    setExpandedFolders((prev) => {
      const merged = new Set(prev);
      for (const f of allFolders) merged.add(f);
      return merged;
    });
  }, [tree]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Outline
  const toc = useMemo(() => parseTableOfContents(activeFileContent), [activeFileContent]);
  const handleTocClick = useCallback(
    (line: number) => {
      const lines = activeFileContent.split("\n");
      let position = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        position += lines[i].length + 1;
      }
      requestJumpToPosition(position);
    },
    [activeFileContent, requestJumpToPosition],
  );

  // Check if a name already exists in the given folder
  // Case-insensitive on macOS/Windows (default case-insensitive filesystems)
  const isCaseInsensitiveFs = navigator.platform.startsWith("Mac") || navigator.platform.startsWith("Win");
  const nameExistsIn = useCallback(
    (name: string, folder?: string) => {
      const targetPath = folder ? `${folder}/${name}` : name;
      const cmp = (a: string, b: string) =>
        isCaseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
      const existsAsFile = files.some((f) => cmp(f.relativePath, targetPath));
      const existsAsFolder = folders.some((f) => cmp(f, targetPath));
      return existsAsFile || existsAsFolder;
    },
    [files, folders, isCaseInsensitiveFs],
  );

  // Handlers
  const [nameError, setNameError] = useState("");

  const handleAddFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (nameExistsIn(name, addDialogFolder)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    const type = name.endsWith(".tex") || name.endsWith(".ltx") ? "tex" : "tex";
    createNewFile(name, type, addDialogFolder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(false);
    setAddDialogFolder(undefined);
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (nameExistsIn(name, folderDialogParent)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    createFolder(name, folderDialogParent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(false);
    setFolderDialogParent(undefined);
  };

  const handleImport = async (targetFolder?: string) => {
    const selected = await openDialog({
      multiple: true,
      filters: [
        {
          name: "All Files",
          extensions: ["tex", "bib", "sty", "cls", "bst", "png", "jpg", "jpeg", "gif", "svg", "bmp", "webp", "pdf", "txt", "md"],
        },
      ],
    });
    if (selected && projectRoot) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths, targetFolder);
    }
  };

  const openRenameDialog = (id: string, name: string) => {
    setRenameFileId(id);
    setRenameValue(name);
    setNameError("");
    setRenameDialogOpen(true);
  };

  const handleRename = () => {
    const name = renameValue.trim();
    if (!renameFileId || !name) return;
    // Check duplicate: find the parent folder of the file being renamed
    const file = files.find((f) => f.id === renameFileId);
    const parentFolder = file?.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : undefined;
    const isSameName = isCaseInsensitiveFs
      ? name.toLowerCase() === file?.name.toLowerCase()
      : name === file?.name;
    if (nameExistsIn(name, parentFolder) && !isSameName) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    renameFile(renameFileId, name);
    setRenameDialogOpen(false);
    setRenameFileId(null);
    setRenameValue("");
    setNameError("");
  };

  const openNewFileDialog = (folder?: string) => {
    setAddDialogFolder(folder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(true);
  };

  const openNewFolderDialog = (parent?: string) => {
    setFolderDialogParent(parent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(true);
  };

  // ─── Render ───

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-sidebar-border border-b px-3">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">ClaudePrism</span>
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

      {/* Resizable sections */}
      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Files */}
        <Panel defaultSize={50} minSize={15}>
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center justify-between border-sidebar-border border-b px-3">
              <div className="flex items-center gap-2">
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-xs">Files</span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-5" title="Add">
                    <PlusIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => openNewFileDialog()}>
                    <FileTextIcon className="mr-2 size-4" />
                    New LaTeX File
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openNewFolderDialog()}>
                    <FolderPlusIcon className="mr-2 size-4" />
                    New Folder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleImport()}>
                    <UploadIcon className="mr-2 size-4" />
                    Import File
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {tree.map((node) => (
                    <FileTreeNode
                      key={node.relativePath}
                      node={node}
                      depth={0}
                      activeFileId={activeFileId}
                      expandedFolders={expandedFolders}
                      onToggleFolder={toggleFolder}
                      onSelectFile={setActiveFile}
                      onNewFile={openNewFileDialog}
                      onNewFolder={openNewFolderDialog}
                      onImport={handleImport}
                      onRename={openRenameDialog}
                      onDelete={deleteFile}
                      fileCount={files.length}
                    />
                  ))}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => openNewFileDialog()}>
                  <FileTextIcon className="mr-2 size-4" />
                  New File
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openNewFolderDialog()}>
                  <FolderPlusIcon className="mr-2 size-4" />
                  New Folder
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleImport()}>
                  <UploadIcon className="mr-2 size-4" />
                  Import File
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </Panel>

        <PanelResizeHandle className="h-px bg-sidebar-border transition-colors hover:bg-ring data-resize-handle-active:bg-ring" />

        {/* Outline */}
        <Panel defaultSize={30} minSize={10}>
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center gap-2 px-3">
              <ListIcon className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-xs">Outline</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {toc.length > 0 ? (
                toc.map((item, index) => (
                  <button
                    key={index}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-xs transition-colors hover:bg-sidebar-accent/50"
                    style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                    onClick={() => handleTocClick(item.line)}
                  >
                    <HashIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.title}</span>
                  </button>
                ))
              ) : (
                <div className="px-2 py-1 text-muted-foreground text-[11px]">
                  No sections found
                </div>
              )}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="h-px bg-sidebar-border transition-colors hover:bg-ring data-resize-handle-active:bg-ring" />

        {/* Zotero */}
        <Panel defaultSize={20} minSize={10}>
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center">
              <ZoteroHeader />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ZoteroPanel />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Footer */}
      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>ClaudePrism v{APP_VERSION}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/delibae/claude-prism"
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

      {/* New File Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New File{addDialogFolder ? ` in ${addDialogFolder}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="filename.tex"
              value={newFileName}
              onChange={(e) => { setNewFileName(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddFile();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddFile} disabled={!newFileName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New Folder{folderDialogParent ? ` in ${folderDialogParent}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="folder name"
              value={newFolderName}
              onChange={(e) => { setNewFolderName(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── File Tree Node ───

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onNewFile: (folder?: string) => void;
  onNewFolder: (parent?: string) => void;
  onImport: (folder?: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  fileCount: number;
}

function FileTreeNode({
  node,
  depth,
  activeFileId,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onNewFile,
  onNewFolder,
  onImport,
  onRename,
  onDelete,
  fileCount,
}: FileTreeNodeProps) {
  const isExpanded = expandedFolders.has(node.relativePath);

  if (node.type === "folder") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <button
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
              style={{ paddingLeft: `${depth * 16 + 4}px` }}
              onClick={() => onToggleFolder(node.relativePath)}
            >
              {isExpanded ? (
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <FolderIcon className="size-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            {isExpanded &&
              node.children.map((child) => (
                <FileTreeNode
                  key={child.relativePath}
                  node={child}
                  depth={depth + 1}
                  activeFileId={activeFileId}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  onImport={onImport}
                  onRename={onRename}
                  onDelete={onDelete}
                  fileCount={fileCount}
                />
              ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onNewFile(node.relativePath)}>
            <FileTextIcon className="mr-2 size-4" />
            New File Here
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onNewFolder(node.relativePath)}>
            <FolderPlusIcon className="mr-2 size-4" />
            New Folder
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onImport(node.relativePath)}>
            <UploadIcon className="mr-2 size-4" />
            Import File Here
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onRename(node.relativePath, node.name)}>
            <PencilIcon className="mr-2 size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              // Delete all files in this folder
              const filesToDelete = node.children
                .filter((c) => c.type === "file" && c.file)
                .map((c) => c.file!.id);
              for (const id of filesToDelete) onDelete(id);
            }}
          >
            <Trash2Icon className="mr-2 size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // File node
  const file = node.file!;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            file.id === activeFileId
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => onSelectFile(file.id)}
        >
          {getFileIcon(file)}
          <span className="truncate">
            {node.name}
            {file.isDirty && <span className="ml-1 text-muted-foreground">*</span>}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRename(file.id, file.name)}>
          <PencilIcon className="mr-2 size-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onClick={() => onDelete(file.id)}
          disabled={fileCount <= 1}
        >
          <Trash2Icon className="mr-2 size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
