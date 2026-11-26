import React, { useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";
import Markdown from "@/components/chat/Markdown";

function displayContent(content) {
  return String(content || "")
    .replace(/^\s*(?:Used skill:.*|No skill - built-in only|Task task[_-]\d+.*|tool-task-\d+.*)\s*$/gim, "")
    .replace(/\btool-task-\d+\b/gi, "Task")
    .replace(/\bTask\s+task_\d+\b/gi, "Task")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function AttachmentChip({ file }) {
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noreferrer"
      className="flex max-w-[220px] items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-[12px] text-foreground/85 transition-colors hover:bg-accent"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />
      <span className="truncate">{file.name}</span>
      <Download className="h-3 w-3 shrink-0 text-muted-foreground" strokeWidth={1.7} />
    </a>
  );
}

export default function MessageItem({ message }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const attachments = message.attachments || [];
  const content = isUser ? message.content || "" : displayContent(message.content);
  const motionGraphicId = !isUser
    ? content.match(/\/api\/files\/([a-f0-9-]{36})\/preview/i)?.[1]
    : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] space-y-2">
          {attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {attachments.map((file, index) => (
                <AttachmentChip key={`${file.url}-${index}`} file={file} />
              ))}
            </div>
          )}
          {message.content && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-md border border-[#234534] bg-[#1C2A23] px-3.5 py-2.5 text-[16px] leading-[1.6] text-foreground sm:px-4">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      <div className="min-w-0 pt-px pr-8">
        {message.memoriesUsed?.length > 0 && (
          <p className="mb-2 text-[10px] text-muted-foreground">
            Using memories: {message.memoriesUsed.map((memory) => memory.content).join("; ")}
          </p>
        )}
        <Markdown content={content} />
        {motionGraphicId && (
          <div className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-card/60">
            <iframe
              title="Motion graphic preview"
              src={`/api/files/${motionGraphicId}/preview`}
              sandbox=""
              loading="lazy"
              className="h-64 w-full bg-white"
            />
            <a href={`/api/files/${motionGraphicId}`} className="block border-t border-border/70 px-3 py-2 text-xs font-medium text-primary hover:underline">
              Download motion graphic
            </a>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy reply"
        className="absolute -top-1 right-0 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.7} />
        )}
      </button>
    </div>
  );
}