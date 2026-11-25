import React from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import SidebarNav from "@/components/layout/SidebarNav";

export default function MobileDrawer({ open, onOpenChange }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[88%] max-w-[320px] border-r border-border/70 bg-background p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <SheetTitle className="sr-only">Biz navigation</SheetTitle>
        <SidebarNav onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}