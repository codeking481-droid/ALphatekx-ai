import React from "react";
import { Clapperboard, Linkedin, Search } from "lucide-react";
import { BrandMark } from "@/components/Brand";

const SUGGESTIONS = [
  {
    label: "Research a topic",
    description: "Find useful information and summarize it",
    prompt: "Research current AI automation trends and give me a concise, sourced summary.",
    icon: Search,
  },
  {
    label: "Create an animation",
    description: "Make a downloadable motion graphic",
    prompt: "Make a motion graphics intro for Biz.",
    icon: Clapperboard,
  },
  {
    label: "Use LinkedIn",
    description: "Create a post draft for approval",
    prompt: "Make a post on LinkedIn about Biz and show me the draft for approval.",
    icon: Linkedin,
  },
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
        <BrandMark className="h-14 w-14" />
      </div>

      <h1 className="mt-6 font-heading text-[32px] font-bold leading-[1.05] tracking-[-0.035em] text-foreground sm:mt-8 sm:text-[42px]">
        {greeting()}
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground sm:mt-3.5 sm:text-[18px]">
        What should Biz do for you today?
      </p>
      <p className="mt-2 text-xs font-semibold tracking-[0.12em] text-primary sm:text-sm">
        Chat. Connect. Automate.
      </p>

      <div className="-mx-5 mt-7 flex w-[calc(100%+2.5rem)] snap-x snap-mandatory gap-2.5 overflow-x-auto px-5 pb-2 text-left [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:mt-8 sm:grid sm:w-full sm:grid-cols-3 sm:snap-none sm:justify-center sm:gap-2 sm:overflow-visible sm:px-0 sm:pb-0">
        {SUGGESTIONS.map(({ label, description, prompt, icon: Icon }) => (
          <button
            key={label}
            type="button"
            onClick={() => onPick(prompt)}
            className="flex min-h-[88px] min-w-[72%] snap-start items-start gap-3 rounded-[20px] border border-[#1E2B22] bg-[#0A0F0C] p-4 text-left leading-relaxed shadow-lg shadow-black/15 transition-colors hover:border-primary/45 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-0"
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.8} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}