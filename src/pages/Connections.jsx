import React from "react";
import {
  CalendarDays,
  FileText,
  Github,
  HardDrive,
  Mail,
  MessageSquare,
} from "lucide-react";
import PageContainer from "@/components/layout/PageContainer";

const SERVICES = [
  {
    name: "Google Drive",
    icon: HardDrive,
    description: "Bring documents and files from your drive into a conversation.",
  },
  {
    name: "Slack",
    icon: MessageSquare,
    description: "Reference workspace discussions and threads as context.",
  },
  {
    name: "Notion",
    icon: FileText,
    description: "Work with pages and databases you already maintain.",
  },
  {
    name: "GitHub",
    icon: Github,
    description: "Read repositories, issues and pull requests.",
  },
  {
    name: "Gmail",
    icon: Mail,
    description: "Search and summarise email when you ask for it.",
  },
  {
    name: "Google Calendar",
    icon: CalendarDays,
    description: "Plan around your schedule and existing events.",
  },
];

export default function Connections() {
  return (
    <PageContainer
      title="Connections"
      description="Biz works best with the tools you already use. Each connection will be authorised by you, and only used when you ask."
    >
      <div className="rounded-2xl border border-border/70 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] font-medium text-foreground">Active connections</p>
          <span className="rounded-full border border-border/80 px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
            None
          </span>
        </div>
        <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-muted-foreground">
          No services are connected to your account yet. Connections are being prepared for
          Biz — nothing is linked or sharing data until one is available and you approve it.
        </p>
      </div>

      <div className="mt-8">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          Planned integrations
        </h2>
        <div className="mt-3 divide-y divide-border/60">
          {SERVICES.map(({ name, icon: Icon, description }) => (
            <div key={name} className="flex items-start gap-3.5 py-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground">
                <Icon className="h-4 w-4" strokeWidth={1.7} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <p className="text-[13.5px] font-medium text-foreground">{name}</p>
                  <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80">
                    Not available yet
                  </span>
                </div>
                <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                  {description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}