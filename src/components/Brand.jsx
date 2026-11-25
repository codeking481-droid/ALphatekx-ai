import React from "react";
import { cn } from "@/lib/utils";

export function BrandMark({ className = "h-7 w-7" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("text-primary", className)}
    >
      <path
        d="M4.6 19.4 12 4.6l7.4 14.8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.5 14.4h7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export default function Brand({ compact = false, className }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark className={compact ? "h-6 w-6" : "h-7 w-7"} />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        AlphaTekx
      </span>
    </span>
  );
}