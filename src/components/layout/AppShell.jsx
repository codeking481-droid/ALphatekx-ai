import React, { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import SidebarNav from "@/components/layout/SidebarNav";
import MobileDrawer from "@/components/layout/MobileDrawer";
import TopBar from "@/components/layout/TopBar";
import { isUiPreview } from "@/lib/ui-preview";

export default function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const uiPreview = isUiPreview();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      <aside className="hidden w-[264px] shrink-0 border-r border-border/70 bg-sidebar lg:block">
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenuOpen(true)} />
        {uiPreview && (
          <div
            role="status"
            className="shrink-0 border-b border-primary/10 bg-primary/[0.05] px-4 py-2 text-center text-[11px] leading-relaxed text-muted-foreground"
          >
            UI preview only. Connect the local API to use chat and account features.
          </div>
        )}
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>

      <MobileDrawer open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}