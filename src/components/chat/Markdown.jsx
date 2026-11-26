import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildCodePreviewDocument } from "@/lib/code-preview";

/**
 * @param {{ content: string, className?: string, enableCodePreview?: boolean }} props
 */
export default function Markdown({ content, className, enableCodePreview = false }) {
  const [codePreviewOpen, setCodePreviewOpen] = useState(false);
  const previewDocument = useMemo(
    () => enableCodePreview ? buildCodePreviewDocument(content) : null,
    [content, enableCodePreview]
  );

  return (
    <div className={cn("text-[16px] leading-[1.6] text-foreground/90", className)}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          h1: ({ children }) => (
            <h3 className="mb-2 mt-5 text-[17px] font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-5 text-[16px] font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-2 mt-4 text-[15px] font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h4>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-border/70" />,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          code: ({ className: codeClass, children }) => (
            <code
              className={cn(
                "font-mono text-[13px]",
                !codeClass && "rounded-[5px] bg-muted px-1.5 py-0.5"
              )}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto rounded-xl border border-border/80 bg-card/70 p-4 text-[13px] leading-6 last:mb-0">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
      {previewDocument && (
        <section className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-card/60">
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              Isolated preview · network access blocked
            </p>
            <button
              type="button"
              aria-expanded={codePreviewOpen}
              onClick={() => setCodePreviewOpen((open) => !open)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              {codePreviewOpen ? (
                <EyeOff className="h-3.5 w-3.5" strokeWidth={1.7} />
              ) : (
                <Eye className="h-3.5 w-3.5" strokeWidth={1.7} />
              )}
              {codePreviewOpen ? "Hide preview" : "Preview code"}
            </button>
          </div>
          {codePreviewOpen && (
            <iframe
              title="HTML, CSS, and JavaScript code preview"
              srcDoc={previewDocument}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-80 w-full border-t border-border/70 bg-white"
            />
          )}
        </section>
      )}
    </div>
  );
}