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
        d="M7.5 4.5h4.8a3.6 3.6 0 0 1 0 7.2H7.5zm0 7.2h5.4a3.9 3.9 0 0 1 0 7.8H7.5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Brand({ compact = false, className }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark className={compact ? "h-6 w-6" : "h-7 w-7"} />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Biz
      </span>
    </span>
  );
}