import React from "react";
import { BrandMark } from "@/components/Brand";
import MessageItem from "@/components/chat/MessageItem";

function Thinking() {
  return (
    <div className="flex gap-3.5">
      <span className="mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center">
        <BrandMark className="h-[18px] w-[18px]" />
      </span>
      <div className="flex items-center gap-1.5 pt-2">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${dot * 160}ms`, animationDuration: "1.1s" }}
          />
        ))}
      </div>
    </div>
  );
}

export default function MessageList({ messages, thinking }) {
  return (
    <div className="space-y-7">
      {messages.map((message, index) => (
        <MessageItem key={message.id || `${message.role}-${index}`} message={message} />
      ))}
      {thinking && <Thinking />}
    </div>
  );
}