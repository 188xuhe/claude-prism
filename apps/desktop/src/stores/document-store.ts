import { create } from "zustand";
import {
  scanProjectFolder,
  readTexFileContent,
  writeTexFileContent,
  readImageAsDataUrl,
  createFileOnDisk,
  deleteFileFromDisk,
  renameFileOnDisk,
  join,
} from "@/lib/tauri/fs";

export interface ProjectFile {
  id: string; // relativePath is the id
  name: string;
  relativePath: string;
  absolutePath: string;
  type: "tex" | "image" | "bib";
  content?: string;
  dataUrl?: string;
  isDirty: boolean;
}

interface DocumentState {
  projectRoot: string | null;
  files: ProjectFile[];
  activeFileId: string;
  cursorPosition: number;
  selectionRange: { start: number; end: number } | null;
  jumpToPosition: number | null;
  isThreadOpen: boolean;
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;
  isSaving: boolean;
  initialized: boolean;

  openProject: (rootPath: string) => Promise<void>;
  closeProject: () => void;
  setActiveFile: (id: string) => void;
  addFile: (file: Omit<ProjectFile, "id" | "isDirty">) => string;
  deleteFile: (id: string) => void;
  renameFile: (id: string, name: string) => void;
  updateFileContent: (id: string, content: string) => void;
  setCursorPosition: (position: number) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  requestJumpToPosition: (position: number) => void;
  clearJumpRequest: () => void;
  setThreadOpen: (open: boolean) => void;
  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (isCompiling: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  insertAtCursor: (text: string) => void;
  replaceSelection: (start: number, end: number, text: string) => void;
  findAndReplace: (find: string, replace: string) => boolean;
  setInitialized: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: (name: string, type: "tex" | "image") => Promise<void>;
  reloadFile: (relativePath: string) => Promise<void>;

  get fileName(): string;
  get content(): string;
  setFileName: (name: string) => void;
  setContent: (content: string) => void;
}

function getActiveFile(state: { files: ProjectFile[]; activeFileId: string }) {
  return state.files.find((f) => f.id === state.activeFileId);
}

// Auto-save: debounced save 2 seconds after last content change
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Store reference set after creation to avoid TDZ issues
let storeRef: typeof useDocumentStore | null = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    const store = storeRef;
    if (!store) return;
    const state = store.getState();
    const dirtyFiles = state.files.filter((f) => f.isDirty && f.content);
    if (dirtyFiles.length > 0) {
      await state.saveAllFiles();
    }
  }, 2000);
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  projectRoot: null,
  files: [],
  activeFileId: "",
  cursorPosition: 0,
  selectionRange: null,
  jumpToPosition: null,
  isThreadOpen: false,
  pdfData: null,
  compileError: null,
  isCompiling: false,
  isSaving: false,
  initialized: false,

  openProject: async (rootPath: string) => {
    const fsFiles = await scanProjectFolder(rootPath);
    const projectFiles: ProjectFile[] = [];

    for (const f of fsFiles) {
      const pf: ProjectFile = {
        id: f.relativePath,
        name: f.relativePath.split("/").pop() || f.relativePath,
        relativePath: f.relativePath,
        absolutePath: f.absolutePath,
        type: f.type,
        isDirty: false,
      };

      // Load content for tex/bib files
      if (f.type === "tex" || f.type === "bib") {
        try {
          pf.content = await readTexFileContent(f.absolutePath);
        } catch {
          pf.content = "";
        }
      }

      // Load dataUrl for image files
      if (f.type === "image") {
        try {
          pf.dataUrl = await readImageAsDataUrl(f.absolutePath);
        } catch {
          // Image loading failed, that's ok
        }
      }

      projectFiles.push(pf);
    }

    // Find the main tex file
    const mainTex =
      projectFiles.find((f) => f.name === "main.tex" || f.name === "document.tex") ||
      projectFiles.find((f) => f.type === "tex");

    set({
      projectRoot: rootPath,
      files: projectFiles,
      activeFileId: mainTex?.id || projectFiles[0]?.id || "",
      pdfData: null,
      compileError: null,
      initialized: true,
      cursorPosition: 0,
      selectionRange: null,
    });
  },

  closeProject: () => {
    set({
      projectRoot: null,
      files: [],
      activeFileId: "",
      pdfData: null,
      compileError: null,
      initialized: false,
    });
  },

  setActiveFile: (id) =>
    set({ activeFileId: id, cursorPosition: 0, selectionRange: null }),

  setSelectionRange: (range) => set({ selectionRange: range }),

  requestJumpToPosition: (position) => set({ jumpToPosition: position }),

  clearJumpRequest: () => set({ jumpToPosition: null }),

  addFile: (file) => {
    const id = file.relativePath;
    set((state) => ({
      files: [...state.files, { ...file, id, isDirty: false }],
      activeFileId: id,
    }));
    return id;
  },

  deleteFile: (id) => {
    const state = get();
    if (state.files.length <= 1) return;
    const file = state.files.find((f) => f.id === id);
    if (file) {
      deleteFileFromDisk(file.absolutePath).catch(console.error);
    }
    const newFiles = state.files.filter((f) => f.id !== id);
    const newActiveId =
      state.activeFileId === id ? newFiles[0].id : state.activeFileId;
    set({ files: newFiles, activeFileId: newActiveId });
  },

  renameFile: (id, name) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || !state.projectRoot) return;

    const dir = file.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : "";
    const newRelativePath = dir ? `${dir}/${name}` : name;

    join(state.projectRoot, newRelativePath).then((newAbsPath) => {
      renameFileOnDisk(file.absolutePath, newAbsPath).catch(console.error);
      set((s) => ({
        files: s.files.map((f) =>
          f.id === id
            ? {
                ...f,
                name,
                relativePath: newRelativePath,
                absolutePath: newAbsPath,
                id: newRelativePath,
              }
            : f,
        ),
        activeFileId: s.activeFileId === id ? newRelativePath : s.activeFileId,
      }));
    });
  },

  updateFileContent: (id, content) => {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, content, isDirty: true } : f,
      ),
    }));
    scheduleAutoSave();
  },

  setThreadOpen: (open) => set({ isThreadOpen: open }),

  setPdfData: (data) => set({ pdfData: data, compileError: null }),

  setCompileError: (error) => set({ compileError: error, pdfData: null }),

  setIsCompiling: (isCompiling) => set({ isCompiling }),

  setIsSaving: (isSaving) => set({ isSaving }),

  setCursorPosition: (position) => set({ cursorPosition: position }),

  insertAtCursor: (text) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || (activeFile.type !== "tex" && activeFile.type !== "bib"))
      return;

    const content = activeFile.content ?? "";
    const { cursorPosition } = state;
    const newContent =
      content.slice(0, cursorPosition) + text + content.slice(cursorPosition);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: cursorPosition + text.length,
    });
  },

  replaceSelection: (start, end, text) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || (activeFile.type !== "tex" && activeFile.type !== "bib"))
      return;

    const content = activeFile.content ?? "";
    const newContent = content.slice(0, start) + text + content.slice(end);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: start + text.length,
    });
  },

  findAndReplace: (find, replace) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || (activeFile.type !== "tex" && activeFile.type !== "bib"))
      return false;

    const content = activeFile.content ?? "";
    if (!content.includes(find)) return false;

    const newContent = content.replace(find, replace);
    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
    });
    return true;
  },

  setInitialized: () => set({ initialized: true }),

  saveFile: async (id) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || !file.isDirty || !file.content) return;

    await writeTexFileContent(file.absolutePath, file.content);
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id ? { ...f, isDirty: false } : f,
      ),
    }));
  },

  saveAllFiles: async () => {
    const state = get();
    const dirtyFiles = state.files.filter((f) => f.isDirty && f.content);
    await Promise.all(
      dirtyFiles.map((f) => writeTexFileContent(f.absolutePath, f.content!)),
    );
    set((s) => ({
      files: s.files.map((f) => ({ ...f, isDirty: false })),
    }));
  },

  saveCurrentFile: async () => {
    const state = get();
    await state.saveFile(state.activeFileId);
  },

  createNewFile: async (name, type) => {
    const state = get();
    if (!state.projectRoot) return;

    const content =
      type === "tex"
        ? `\\documentclass{article}\n\n\\begin{document}\n\n% Your content here\n\n\\end{document}\n`
        : "";

    const fullPath = await createFileOnDisk(state.projectRoot, name, content);
    const relativePath = name;

    set((s) => ({
      files: [
        ...s.files,
        {
          id: relativePath,
          name,
          relativePath,
          absolutePath: fullPath,
          type,
          content: type === "tex" ? content : undefined,
          isDirty: false,
        },
      ],
      activeFileId: relativePath,
    }));
  },

  reloadFile: async (relativePath) => {
    const state = get();
    const file = state.files.find((f) => f.relativePath === relativePath);
    if (!file) return;

    if (file.type === "tex" || file.type === "bib") {
      const content = await readTexFileContent(file.absolutePath);
      set((s) => ({
        files: s.files.map((f) =>
          f.id === file.id ? { ...f, content, isDirty: false } : f,
        ),
      }));
    }
  },

  get fileName() {
    const activeFile = getActiveFile(get());
    return activeFile?.name ?? "document.tex";
  },

  get content() {
    const activeFile = getActiveFile(get());
    return activeFile?.content ?? "";
  },

  setFileName: (name) => {
    const state = get();
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId ? { ...f, name } : f,
      ),
    });
  },

  setContent: (content) => {
    const state = get();
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId
          ? { ...f, content, isDirty: true }
          : f,
      ),
    });
    scheduleAutoSave();
  },
}));

storeRef = useDocumentStore;
