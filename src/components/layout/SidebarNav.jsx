import React from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { History, Plus, Search, Settings2, Plug, ShieldCheck, Sparkles, Brain, FolderKanban } from "lucide-react";
import Brand from "@/components/Brand";
import useCurrentUser from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";

const ITEMS = [
  { label: "Search", to: "/history#search", icon: Search },
  { label: "Projects", to: "/projects", icon: FolderKanban },
  { label: "History", to: "/history", icon: History },
  { label: "Connections", to: "/connections", icon: Plug },
  { label: "Approvals", to: "/approvals", icon: ShieldCheck },
  { label: "Skills", to: "/skills", icon: Sparkles },
  { label: "Memory", to: "/memory", icon: Brain },
  { label: "Settings", to: "/settings", icon: Settings2 },
];

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

export default function SidebarNav({ onNavigate }) {
  const user = useCurrentUser();
  const location = useLocation();

  return (
    <div className="flex h-full flex-col bg-sidebar px-3 py-4">
      <div className="px-2.5 pb-1">
        <Brand />
      </div>

      <Link
        to="/"
        onClick={onNavigate}
        className="mt-7 flex items-center gap-3 rounded-[10px] px-3 py-3 text-[15px] font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
        New chat
      </Link>

      <nav className="mt-5 space-y-1 border-t border-border/60 pt-4">
        {ITEMS.map(({ label, to, icon: Icon }) => {
          const active = to === "/history#search"
            ? location.pathname === "/history" && location.hash === "#search"
            : to === "/history"
              ? location.pathname === "/history" && location.hash !== "#search"
              : location.pathname === to;
          return (
            <NavLink
              key={to}
              to={to}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-[10px] px-3 py-3 text-[15px] transition-colors",
                active
                  ? "relative bg-primary/[0.15] text-primary before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              <Icon
                className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")}
                strokeWidth={1.7}
              />
              {label}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border/60 px-1 pt-3.5">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/[0.15] text-[10.5px] font-semibold text-primary ring-1 ring-inset ring-primary/15">
            {initials(user?.full_name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-medium text-foreground/90">
              {user?.full_name || "Your account"}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {user?.email || "Signed in"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}