import React, { useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import Markdown from "@/components/chat/Markdown";

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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] space-y-2 sm:max-w-[85%]">
          {attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {attachments.map((file, index) => (
                <AttachmentChip key={`${file.url}-${index}`} file={file} />
              ))}
            </div>
          )}
          {message.content && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-md border border-border/60 bg-secondary/80 px-3.5 py-2.5 text-[15px] leading-[1.65] text-foreground sm:px-4">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group relative flex gap-3.5">
      <span className="mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center">
        <BrandMark className="h-[17px] w-[17px]" />
      </span>
      <div className="min-w-0 flex-1 pt-px">
        {Object.hasOwn(message, "skill") && (
          <span className="mb-2 inline-flex rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {message.skill?.name ? `Used skill: ${message.skill.name}` : "No skill - built-in only"}
          </span>
        )}
        {message.memoriesUsed?.length > 0 && (
          <p className="mb-2 text-[10px] text-muted-foreground">
            Using memories: {message.memoriesUsed.map((memory) => memory.content).join("; ")}
          </p>
        )}
        <Markdown content={message.content} />
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