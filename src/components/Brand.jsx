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
      <circle
        cx="12"
        cy="12"
        r="10.4"
        fill="#0A0F0C"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M7.2 5.6h5.1a3.1 3.1 0 0 1 0 6.2H7.2zm0 6.2h5.6a3.3 3.3 0 0 1 0 6.6H7.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M15.2 7.1c.1-1.6 1.1-2.7 2.8-2.9-.1 1.7-1.1 2.7-2.8 2.9Z"
        fill="currentColor"
      />
      <path d="m15.2 7.1 2.3-2.3" stroke="currentColor" strokeWidth="1.1" />
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