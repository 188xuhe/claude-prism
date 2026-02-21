import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { syntaxHighlighting, syntaxTreeAvailable } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle } from "@codemirror/language";
import { useTheme } from "next-themes";
import {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery as setSearchQueryEffect,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { unifiedMergeView, getChunks, acceptChunk, rejectChunk } from "@codemirror/merge";
import { latex, latexLinter } from "codemirror-lang-latex";
import { linter, lintGutter, forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useProposedChangesStore, type ProposedChange } from "@/stores/proposed-changes-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useHistoryStore } from "@/stores/history-store";
import { compileLatex } from "@/lib/latex-compiler";
import { EditorToolbar } from "./editor-toolbar";
import { SelectionToolbar, type ToolbarAction } from "./selection-toolbar";
import { SpellCheckIcon } from "lucide-react";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { ProposedChangesPanel } from "@/components/claude-chat/proposed-changes-panel";
import { ImagePreview } from "./image-preview";
import { SearchPanel } from "./search-panel";
import { ProblemsPanel, type DiagnosticItem } from "./problems-panel";
import { PdfViewer } from "@/components/workspace/preview/pdf-viewer";
import { readFile } from "@tauri-apps/plugin-fs";

function getActiveFileContent(): string {
  const state = useDocumentStore.getState();
  const activeFile = state.files.find((f) => f.id === state.activeFileId);
  return activeFile?.content ?? "";
}

export function LatexEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const setContent = useDocumentStore((s) => s.setContent);
  const setCursorPosition = useDocumentStore((s) => s.setCursorPosition);
  const setSelectionRange = useDocumentStore((s) => s.setSelectionRange);
  const jumpToPosition = useDocumentStore((s) => s.jumpToPosition);
  const clearJumpRequest = useDocumentStore((s) => s.clearJumpRequest);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isTextFile = activeFile?.type === "tex" || activeFile?.type === "bib" || activeFile?.type === "style" || activeFile?.type === "other";
  const activeFileContent = activeFile?.content;

  const [imageScale, setImageScale] = useState(1.0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [mergeChunkInfo, setMergeChunkInfo] = useState({ total: 0, current: 0 });
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [selectionCoords, setSelectionCoords] = useState<{ top: number; left: number } | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const { resolvedTheme } = useTheme();

  const compileRef = useRef<() => void>(() => {});
  const isSearchOpenRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const isMergeActiveRef = useRef(false);
  const pendingChangeRef = useRef<ProposedChange | null>(null);
  const handleKeepAllRef = useRef<() => void>(() => {});
  const handleUndoAllRef = useRef<() => void>(() => {});
  const diagnosticsRef = useRef<DiagnosticItem[]>([]);

  useEffect(() => { isSearchOpenRef.current = isSearchOpen; }, [isSearchOpen]);

  // Proposed changes for active file
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const activeFileChange = useMemo(() => {
    if (!activeFile) return null;
    return proposedChanges.find((c) => c.filePath === activeFile.relativePath) ?? null;
  }, [proposedChanges, activeFile]);

  // Keep all changes (⌘Y)
  handleKeepAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    setContent(change.newContent);
    useProposedChangesStore.getState().keepChange(change.id);
    pendingChangeRef.current = null;
  };

  // Undo all changes (⌘N)
  handleUndoAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: change.oldContent },
      annotations: Transaction.addToHistory.of(false),
    });
    setContent(change.oldContent);
    useProposedChangesStore.getState().undoChange(change.id);
    pendingChangeRef.current = null;
  };

  // Navigate to a specific chunk by index
  const goToChunk = (index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    if (!chunks || index < 0 || index >= chunks.chunks.length) return;
    const chunk = chunks.chunks[index];
    view.dispatch({
      selection: { anchor: chunk.fromB },
      effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }),
    });
    view.focus();
  };

  // After individual accept/reject, navigate to next chunk or auto-resolve
  const afterChunkAction = (view: EditorView, prevIdx: number) => {
    const remaining = getChunks(view.state);
    if (!remaining || remaining.chunks.length === 0) {
      // All chunks resolved — clean up merge view
      const change = pendingChangeRef.current;
      if (change) {
        isMergeActiveRef.current = false;
        setMergeChunkInfo({ total: 0, current: 0 });
        const finalContent = view.state.doc.toString();
        view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
        setContent(finalContent);
        if (finalContent === change.oldContent) {
          useProposedChangesStore.getState().undoChange(change.id);
        } else {
          useProposedChangesStore.getState().keepChange(change.id);
        }
        pendingChangeRef.current = null;
      }
    } else {
      // Focus the next remaining chunk
      const nextIdx = Math.min(prevIdx, remaining.chunks.length - 1);
      const next = remaining.chunks[nextIdx];
      view.dispatch({
        selection: { anchor: next.fromB },
        effects: EditorView.scrollIntoView(next.fromB, { y: "center" }),
      });
    }
    view.focus();
  };

  const acceptCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    acceptChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  const rejectCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    rejectChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  useEffect(() => {
    if (!searchQuery || !activeFileContent) { setMatchCount(0); setCurrentMatch(0); return; }
    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = activeFileContent.match(regex);
    setMatchCount(matches?.length ?? 0);
    setCurrentMatch(matches && matches.length > 0 ? 1 : 0);
  }, [searchQuery, activeFileContent]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); setIsSearchOpen(true); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({ search: searchQuery, caseSensitive: false, literal: true });
    view.dispatch({ effects: setSearchQueryEffect.of(query) });
    if (searchQuery) findNext(view);
  }, [searchQuery]);

  const handleFindNext = () => { const view = viewRef.current; if (view) { findNext(view); view.focus(); } };
  const handleFindPrevious = () => { const view = viewRef.current; if (view) { findPrevious(view); view.focus(); } };

  // Compile: save all files first, then compile via sidecar using projectDir
  compileRef.current = async () => {
    if (isCompiling || !projectRoot || activeFile?.type !== "tex") return;
    setIsCompiling(true);
    try {
      await saveAllFiles();
      // Pre-compile snapshot
      try {
        await useHistoryStore.getState().createSnapshot(projectRoot, "[compile] Pre-compile");
      } catch { /* snapshot failure should not block compile */ }
      const targetFile = activeFile?.relativePath || "document.tex";
      const data = await compileLatex(projectRoot, targetFile);
      setPdfData(data);
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : "Compilation failed");
    } finally {
      setIsCompiling(false);
    }
  };

  useEffect(() => {
    if (!containerRef.current || !isTextFile) return;
    const currentContent = getActiveFileContent();

    const updateListener = EditorView.updateListener.of((update) => {
      if (isMergeActiveRef.current) {
        const chunks = getChunks(update.state);
        if (chunks) {
          const total = chunks.chunks.length;
          // Track current chunk based on cursor position
          const cursorPos = update.state.selection.main.head;
          let current = 0;
          for (let i = 0; i < chunks.chunks.length; i++) {
            if (cursorPos >= chunks.chunks[i].fromB) current = i + 1;
          }
          setMergeChunkInfo({ total, current: Math.min(Math.max(1, current), total) });

          // Auto-resolve when all chunks have been individually accepted/rejected
          // Note: acceptChunk doesn't change the main doc (only the original),
          // so we check total === 0 regardless of docChanged
          if (total === 0) {
            const change = pendingChangeRef.current;
            if (change) {
              setTimeout(() => {
                const v = viewRef.current;
                if (!v || !isMergeActiveRef.current) return;
                isMergeActiveRef.current = false;
                setMergeChunkInfo({ total: 0, current: 0 });
                const finalContent = v.state.doc.toString();
                v.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
                setContent(finalContent);
                if (finalContent === change.oldContent) {
                  useProposedChangesStore.getState().undoChange(change.id);
                } else {
                  useProposedChangesStore.getState().keepChange(change.id);
                }
                pendingChangeRef.current = null;
              }, 0);
            }
          }
        }
        return;
      }
      if (update.docChanged) setContent(update.state.doc.toString());
      if (update.selectionSet) {
        const { from, to, head } = update.state.selection.main;
        setCursorPosition(head);
        setSelectionRange(from !== to ? { start: from, end: to } : null);

        // Compute toolbar position below the selection end
        // Skip toolbar for "select all" (Cmd+A) to avoid overlay issues
        const isSelectAll = from === 0 && to === update.state.doc.length;
        if (from !== to && !isSelectAll) {
          const startCoords = update.view.coordsAtPos(from);
          const endCoords = update.view.coordsAtPos(to);
          if (endCoords && startCoords) {
            setSelectionCoords({
              top: endCoords.bottom,   // below last line of selection
              left: startCoords.left,  // aligned to selection start
            });
          }
        } else {
          setSelectionCoords(null);
        }
      }

      // Sync diagnostics for Problems panel
      const diags: DiagnosticItem[] = [];
      forEachDiagnostic(update.state, (d, from) => {
        diags.push({
          from,
          to: d.to,
          severity: d.severity,
          message: d.message,
          line: update.state.doc.lineAt(from).number,
        });
      });
      if (
        diags.length !== diagnosticsRef.current.length ||
        diags.some(
          (d, i) =>
            d.from !== diagnosticsRef.current[i]?.from ||
            d.message !== diagnosticsRef.current[i]?.message
        )
      ) {
        diagnosticsRef.current = diags;
        setDiagnostics(diags);
      }
    });

    const compileKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            compileRef.current();
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            const state = useDocumentStore.getState();
            state.setIsSaving(true);
            state.saveCurrentFile().finally(() => setTimeout(() => state.setIsSaving(false), 500));
            return true;
          },
        },
        { key: "Mod-f", run: () => { setIsSearchOpen(true); return true; } },
        { key: "Escape", run: () => { if (isSearchOpenRef.current) { setIsSearchOpen(false); return true; } return false; } },
        { key: "Mod-y", run: () => { if (isMergeActiveRef.current) { handleKeepAllRef.current(); return true; } return false; } },
        { key: "Mod-n", run: () => { if (isMergeActiveRef.current) { handleUndoAllRef.current(); return true; } return false; } },
      ]),
    );

    const state = EditorState.create({
      doc: currentContent,
      extensions: [
        compileKeymap,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        latex({ enableLinting: false }),
        ...(activeFile?.type === "tex" ? [
          linter((view) => {
            // Wait until the Lezer parser has fully parsed the document
            // to avoid false positives from incomplete syntax trees
            if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
              return [];
            }
            const baseLinter = latexLinter();
            const diagnostics = baseLinter(view);
            return diagnostics.map((d: Diagnostic) => ({
              ...d,
              actions: [
                ...(d.actions ?? []),
                {
                  name: "Fix with chat",
                  apply: (v: EditorView, from: number, _to: number) => {
                    const line = v.state.doc.lineAt(from);
                    const docState = useDocumentStore.getState();
                    const file = docState.files.find((f) => f.id === docState.activeFileId);
                    const fileName = file?.relativePath ?? "document.tex";
                    const ctx = `[Lint error in ${fileName}:${line.number}]\n[Error: ${d.message}]`;
                    useClaudeChatStore.getState().sendPrompt(`${ctx}\n\nFix this lint error.`);
                  },
                },
              ],
            }));
          }),
          lintGutter(),
        ] : []),
        themeCompartmentRef.current.of(
          resolvedTheme === "dark"
            ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
            : [syntaxHighlighting(defaultHighlightStyle)]
        ),
        search(),
        highlightSelectionMatches(),
        mergeCompartmentRef.current.of([]),
        updateListener,
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-gutters": { paddingRight: "4px" },
          ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "8px", paddingRight: "4px" },
          ".cm-content": { paddingLeft: "8px", paddingRight: "12px" },
          ".cm-searchMatch": { backgroundColor: "#facc15 !important", color: "#000 !important", borderRadius: "2px", boxShadow: "0 0 0 1px #eab308" },
          ".cm-searchMatch-selected": { backgroundColor: "#f97316 !important", color: "#fff !important", borderRadius: "2px", boxShadow: "0 0 0 2px #ea580c" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(100, 150, 255, 0.3)" },
          ".cm-changedLine": { backgroundColor: "rgba(34, 197, 94, 0.08) !important" },
          ".cm-deletedChunk": { backgroundColor: "rgba(239, 68, 68, 0.12) !important", paddingLeft: "6px", position: "relative" },
          ".cm-insertedLine": { backgroundColor: "rgba(34, 197, 94, 0.15) !important" },
          ".cm-deletedLine": { backgroundColor: "rgba(239, 68, 68, 0.15) !important" },
          ".cm-changedText": { backgroundColor: "rgba(34, 197, 94, 0.25) !important" },
          ".cm-chunkButtons": { position: "absolute", insetInlineEnd: "5px", top: "2px", zIndex: "10" },
          ".cm-chunkButtons button": {
            border: "none",
            cursor: "pointer",
            color: "white",
            margin: "0 2px",
            borderRadius: "3px",
            padding: "2px 8px",
            fontSize: "12px",
            lineHeight: "1.4",
          },
          ".cm-chunkButtons button[name=accept]": { backgroundColor: "#22c55e" },
          ".cm-chunkButtons button[name=reject]": { backgroundColor: "#ef4444" },
          ".cm-changeGutter": { width: "3px", minWidth: "3px" },
          ".cm-changedLineGutter": { backgroundColor: "#22c55e" },
          ".cm-deletedLineGutter": { backgroundColor: "#ef4444" },
          ".cm-diagnostic": {
            padding: "8px 10px",
          },
          ".cm-diagnosticAction": {
            display: "inline-block",
            padding: "4px 12px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            backgroundColor: "var(--muted, rgba(255,255,255,0.08))",
            color: "var(--foreground, #e5e5e5)",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            marginTop: "8px",
            transition: "background-color 0.15s, border-color 0.15s",
          },
          ".cm-diagnosticAction:hover": {
            backgroundColor: "var(--accent, rgba(255,255,255,0.15))",
            borderColor: "var(--foreground, rgba(255,255,255,0.3))",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [activeFileId, isTextFile, setContent, setCursorPosition, setSelectionRange]);

  // Dynamically switch editor theme when resolvedTheme changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const extensions =
      resolvedTheme === "dark"
        ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
        : [syntaxHighlighting(defaultHighlightStyle)];
    view.dispatch({ effects: themeCompartmentRef.current.reconfigure(extensions) });
  }, [resolvedTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile || isMergeActiveRef.current) return;
    const content = activeFileContent ?? "";
    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      view.dispatch({ changes: { from: 0, to: currentContent.length, insert: content } });
    }
  }, [activeFileContent, isTextFile]);

  // Watch for proposed changes → activate/deactivate merge view
  useEffect(() => {
    const view = viewRef.current;
    console.log("[merge-view] effect fired:", {
      hasView: !!view,
      isTextFile,
      activeFileChange: activeFileChange ? { id: activeFileChange.id, filePath: activeFileChange.filePath } : null,
      isMergeActive: isMergeActiveRef.current,
    });
    if (!view || !isTextFile) return;

    if (activeFileChange && !isMergeActiveRef.current) {
      // Activate merge view: load newContent + enable merge extension in ONE atomic dispatch
      console.log("[merge-view] ACTIVATING merge view for:", activeFileChange.filePath);
      pendingChangeRef.current = activeFileChange;
      isMergeActiveRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: activeFileChange.newContent },
          effects: mergeCompartmentRef.current.reconfigure(
            unifiedMergeView({
              original: activeFileChange.oldContent,
              highlightChanges: true,
              gutter: true,
              mergeControls: true,
            })
          ),
          annotations: Transaction.addToHistory.of(false),
        });
        console.log("[merge-view] merge view activated successfully");
      } catch (err) {
        console.error("[merge-view] failed to activate merge view:", err);
        isMergeActiveRef.current = false;
        pendingChangeRef.current = null;
      }
    } else if (!activeFileChange && isMergeActiveRef.current) {
      // Deactivate merge view (externally resolved)
      console.log("[merge-view] DEACTIVATING merge view");
      view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
      isMergeActiveRef.current = false;
      pendingChangeRef.current = null;
    }
  }, [activeFileChange, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpToPosition === null) return;
    view.dispatch({
      selection: { anchor: jumpToPosition },
      effects: EditorView.scrollIntoView(jumpToPosition, { y: "center" }),
    });
    view.focus();
    clearJumpRequest();
  }, [jumpToPosition, clearJumpRequest]);

  // Selection toolbar: compute context label and container-relative position
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const selectionLabel = useMemo(() => {
    const view = viewRef.current;
    if (!selectionRange || !view || !activeFile) return null;
    try {
      const startLine = view.state.doc.lineAt(selectionRange.start);
      const endLine = view.state.doc.lineAt(selectionRange.end);
      const startCol = selectionRange.start - startLine.from + 1;
      const endCol = selectionRange.end - endLine.from + 1;
      const fileName = activeFile.relativePath;
      return `@${fileName}:${startLine.number}:${startCol}-${endLine.number}:${endCol}`;
    } catch {
      return null;
    }
  }, [selectionRange, activeFile]);

  const toolbarPosition = useMemo(() => {
    if (!selectionCoords || !parentRef.current) return null;
    const parentRect = parentRef.current.getBoundingClientRect();
    const relTop = selectionCoords.top - parentRect.top + 4; // 4px gap below selection
    const relLeft = Math.max(8, Math.min(
      selectionCoords.left - parentRect.left,
      parentRect.width - 272, // 264px toolbar + 8px margin
    ));
    return { top: relTop, left: relLeft };
  }, [selectionCoords]);

  const handleToolbarSendPrompt = useCallback(
    (prompt: string) => {
      setSelectionCoords(null);
      useClaudeChatStore.getState().sendPrompt(prompt);
    },
    [],
  );

  const editorToolbarActions: ToolbarAction[] = useMemo(() => [
    { id: "proofread", label: "Proofread", icon: <SpellCheckIcon className="size-4" /> },
  ], []);

  const handleToolbarAction = useCallback(
    (actionId: string) => {
      setSelectionCoords(null);
      if (actionId === "proofread") {
        useClaudeChatStore.getState().sendPrompt("Proofread and fix any errors in this text");
      }
    },
    [],
  );

  const handleToolbarDismiss = useCallback(() => {
    setSelectionCoords(null);
  }, []);

  if (activeFile?.type === "pdf") {
    return <InlinePdfViewer file={activeFile} editorView={viewRef} imageScale={imageScale} onImageScaleChange={setImageScale} />;
  }

  if (!isTextFile && activeFile) {
    return (
      <div className="flex h-full flex-col bg-background">
        <EditorToolbar editorView={viewRef} fileType="image" imageScale={imageScale} onImageScaleChange={setImageScale} />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ImagePreview file={activeFile} scale={imageScale} />
          <ClaudeChatDrawer />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar editorView={viewRef} />
      {isSearchOpen && (
        <SearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onClose={() => { setIsSearchOpen(false); setSearchQuery(""); viewRef.current?.focus(); }}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          matchCount={matchCount}
          currentMatch={currentMatch}
        />
      )}
      <div ref={parentRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />
        <ClaudeChatDrawer />
        {/* Selection toolbar */}
        {toolbarPosition && selectionLabel && !isMergeActiveRef.current && (
          <SelectionToolbar
            position={toolbarPosition}
            contextLabel={selectionLabel}
            actions={editorToolbarActions}
            onSendPrompt={handleToolbarSendPrompt}
            onAction={handleToolbarAction}
            onDismiss={handleToolbarDismiss}
          />
        )}
        {/* Floating chunk navigator pill */}
        {activeFileChange && mergeChunkInfo.total > 0 && (
          <div className="absolute top-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
            <span className="px-1 font-mono text-xs text-muted-foreground">
              ±&nbsp;{mergeChunkInfo.current}/{mergeChunkInfo.total}
            </span>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <button
              onClick={() => goToChunk(mergeChunkInfo.current - 2)}
              disabled={mergeChunkInfo.current <= 1}
              className="rounded p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
              title="Previous change"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button
              onClick={() => goToChunk(mergeChunkInfo.current)}
              disabled={mergeChunkInfo.current >= mergeChunkInfo.total}
              className="rounded p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
              title="Next change"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <button
              onClick={acceptCurrentChunk}
              className="rounded p-0.5 text-green-400 hover:bg-green-600/20 transition-colors"
              title="Accept this change"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button
              onClick={rejectCurrentChunk}
              className="rounded p-0.5 text-red-400 hover:bg-red-600/20 transition-colors"
              title="Reject this change"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
      </div>
      {diagnostics.length > 0 && (
        <ProblemsPanel
          diagnostics={diagnostics}
          fileName={activeFile?.relativePath ?? "document.tex"}
          onNavigate={(from) => {
            const view = viewRef.current;
            if (!view) return;
            view.dispatch({
              selection: { anchor: from },
              effects: EditorView.scrollIntoView(from, { y: "center" }),
            });
            view.focus();
          }}
          onFixWithChat={(message, line) => {
            const fileName = activeFile?.relativePath ?? "document.tex";
            const ctx = `[Lint error in ${fileName}:${line}]\n[Error: ${message}]`;
            useClaudeChatStore.getState().sendPrompt(`${ctx}\n\nFix this lint error.`);
          }}
          onFixAllWithChat={() => {
            const fileName = activeFile?.relativePath ?? "document.tex";
            const errorList = diagnostics
              .map((d) => `- ${fileName}:${d.line} — ${d.message}`)
              .join("\n");
            useClaudeChatStore.getState().sendPrompt(
              `[Lint errors in ${fileName}]\n${errorList}\n\nFix all these lint errors.`
            );
          }}
        />
      )}
      {activeFileChange && (
        <ProposedChangesPanel
          change={activeFileChange}
          onKeep={() => handleKeepAllRef.current()}
          onUndo={() => handleUndoAllRef.current()}
        />
      )}
    </div>
  );
}

// ─── Inline PDF Viewer (for PDF files opened from file tree) ───

function InlinePdfViewer({
  file,
  editorView,
  imageScale,
  onImageScaleChange,
}: {
  file: ProjectFile;
  editorView: React.RefObject<EditorView | null>;
  imageScale: number;
  onImageScaleChange: (scale: number) => void;
}) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError(null);

    readFile(file.absolutePath)
      .then((data) => {
        if (!cancelled) setPdfData(new Uint8Array(data));
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => { cancelled = true; };
  }, [file.absolutePath]);

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar editorView={editorView} fileType="image" imageScale={imageScale} onImageScaleChange={onImageScaleChange} />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {pdfData ? (
          <PdfViewer
            data={pdfData}
            scale={imageScale}
            onScaleChange={onImageScaleChange}
            onError={(msg) => setError(msg)}
          />
        ) : error ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Failed to load PDF: {error}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Loading PDF...
          </div>
        )}
        <ClaudeChatDrawer />
      </div>
    </div>
  );
}
