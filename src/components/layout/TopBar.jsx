import React from "react";
import { Link } from "react-router-dom";
import { Menu, Plus } from "lucide-react";
import useCurrentUser from "@/hooks/useCurrentUser";
import { BrandMark } from "@/components/Brand";

function initials(name) {
  if (!name) return "A";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export default function TopBar({ onMenu }) {
  const user = useCurrentUser();

  return (
    <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center justify-between border-b border-border/60 px-3 pt-[env(safe-area-inset-top)] sm:px-4 lg:hidden">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open menu"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" strokeWidth={1.7} />
        </button>
        <Link to="/" aria-label="Biz home" className="flex min-w-0 items-center gap-2">
          <BrandMark className="h-5 w-5 shrink-0" />
          <span className="truncate text-[14px] font-semibold tracking-[-0.02em]">Biz</span>
        </Link>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Link
          to="/"
          aria-label="Start a new chat"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-5 w-5" strokeWidth={1.8} />
        </Link>
        <Link
          to="/settings"
          aria-label="Account settings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/20 transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials(user?.full_name)}
        </Link>
      </div>
    </header>
  );
}