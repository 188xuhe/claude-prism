import { type FC, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { PlusIcon } from "lucide-react";
import "katex/dist/katex.min.css";

import { useDocumentStore } from "@/stores/document-store";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer: FC<MarkdownRendererProps> = ({
  content,
  className,
}) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      className={className ?? "prose prose-sm dark:prose-invert max-w-none"}
      components={{
        code({ className: codeClassName, children, ...props }) {
          const match = /language-(\w+)/.exec(codeClassName || "");
          const language = match?.[1];
          const code = String(children).replace(/\n$/, "");

          if (!match) {
            // Inline code
            return (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          }

          // Code block
          return <CodeBlock language={language || ""} code={code} />;
        },
      }}
    />
  );
};

const CodeBlock: FC<{ language: string; code: string }> = ({
  language,
  code,
}) => {
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const isLatex = language === "latex" || language === "tex";

  const handleInsert = useCallback(() => {
    insertAtCursor(code);
  }, [insertAtCursor, code]);

  return (
    <div className="group relative my-1">
      <pre className="overflow-x-auto rounded bg-muted p-2 text-sm">
        <code>{code}</code>
      </pre>
      {isLatex && (
        <button
          type="button"
          onClick={handleInsert}
          className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-primary-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100"
        >
          <PlusIcon className="size-3" />
          Insert
        </button>
      )}
    </div>
  );
};
