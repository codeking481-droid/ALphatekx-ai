import React, { useState } from "react";
import { X } from "lucide-react";
import MessageItem from "@/components/chat/MessageItem";

function Promotion({ onDismiss }) {
  return (
    <aside className="rounded-xl border border-border/70 bg-card/60 px-3.5 py-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-foreground">Ad · Biz Pro</p>
          <p className="mt-1 text-muted-foreground">Explore faster AI and an ad-free experience.</p>
          <a href="/settings" className="mt-2 inline-block font-medium text-primary hover:underline">Learn more</a>
        </div>
        <button type="button" aria-label="Dismiss promotion" onClick={onDismiss} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}

function Thinking() {
  return (
    <div className="flex gap-3.5">
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

export default function MessageList({ messages, thinking, showAds = false, hiddenMessageId = null }) {
  const [adsDismissed, setAdsDismissed] = useState(false);
  return (
    <div className="space-y-7">
      {messages.map((message, index) => (
        <React.Fragment key={message.id || `${message.role}-${index}`}>
          {message.id !== hiddenMessageId && <MessageItem message={message} />}
          {showAds && !adsDismissed && (index + 1) % 10 === 0 && (
            <Promotion onDismiss={() => setAdsDismissed(true)} />
          )}
        </React.Fragment>
      ))}
      {thinking && <Thinking />}
    </div>
  );
}