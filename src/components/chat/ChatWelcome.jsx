import React from "react";
import { FileText, Lightbulb, PenLine } from "lucide-react";
import { BrandMark } from "@/components/Brand";

const SUGGESTIONS = [
  { label: "Explain something complex simply", icon: Lightbulb },
  { label: "Draft a clear, professional email", icon: PenLine },
  { label: "Summarise a document I attach", icon: FileText },
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function ChatWelcome({ onPick }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="welcome-avatar" aria-hidden="true">
        <span className="welcome-avatar__glow" />
        <span className="welcome-avatar__orbit welcome-avatar__orbit--outer">
          <i />
        </span>
        <span className="welcome-avatar__orbit welcome-avatar__orbit--inner">
          <i />
        </span>
        <span className="welcome-avatar__core">
          <BrandMark className="h-7 w-7 text-white" />
        </span>
        <span className="welcome-avatar__spark welcome-avatar__spark--one" />
        <span className="welcome-avatar__spark welcome-avatar__spark--two" />
      </div>

      <h1 className="mt-6 font-display text-[38px] leading-[1.05] text-foreground sm:mt-8 sm:text-[52px]">
        {greeting()}
      </h1>
      <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-muted-foreground sm:mt-3.5 sm:text-[14.5px]">
        What would you like to think through?
      </p>

      <div className="-mx-5 mt-7 flex w-[calc(100%+2.5rem)] snap-x snap-mandatory gap-2.5 overflow-x-auto px-5 pb-2 text-left [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:mt-8 sm:grid sm:w-full sm:grid-cols-3 sm:snap-none sm:justify-center sm:gap-2 sm:overflow-visible sm:px-0 sm:pb-0">
        {SUGGESTIONS.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            onClick={() => onPick(label)}
            className="flex min-h-[76px] min-w-[72%] snap-start items-start gap-3 rounded-2xl border border-border/70 bg-card/60 p-3.5 text-left text-[12.5px] leading-relaxed text-muted-foreground shadow-sm shadow-foreground/[0.02] transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-0 sm:items-center sm:p-3"
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary/75 sm:mt-0" strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}