import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CalendarDays,
  Check,
  FileText,
  Github,
  HardDrive,
  Linkedin,
  Loader2,
  Mail,
  MessageSquare,
  Unplug,
} from "lucide-react";
import PageContainer from "@/components/layout/PageContainer";
import { api } from "@/api/client";

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
  const location = useLocation();
  const navigate = useNavigate();
  const [linkedin, setLinkedin] = useState({ configured: false, connected: false, name: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    api.linkedin.status()
      .then((status) => {
        if (active) setLinkedin(status);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "LinkedIn connection status couldn't be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const result = new URLSearchParams(location.search).get("linkedin");
    if (result === "connected") setNotice("LinkedIn is connected.");
    if (result === "denied") setError("LinkedIn authorization was cancelled.");
    if (result) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const connectLinkedIn = () => {
    window.location.assign("/api/linkedin/connect");
  };

  const disconnectLinkedIn = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.linkedin.disconnect();
      setLinkedin((current) => ({ ...current, connected: false, name: null }));
      setNotice("LinkedIn was disconnected.");
    } catch (requestError) {
      setError(requestError.message || "LinkedIn couldn't be disconnected.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer
      title="Connections"
      description="Biz works best with the tools you already use. Each connection will be authorised by you, and only used when you ask."
    >
      <section className="mb-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground">
              <Linkedin className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">LinkedIn</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {loading
                  ? "Checking connection…"
                  : linkedin.connected
                    ? `Connected as ${linkedin.name}`
                    : linkedin.configured
                      ? "Not connected"
                      : "Not configured on the server"}
              </p>
            </div>
          </div>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : linkedin.connected ? (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <Check className="h-3.5 w-3.5" /> Connected
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={disconnectLinkedIn}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!linkedin.configured || busy}
              onClick={connectLinkedIn}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Connect LinkedIn
            </button>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
        {notice && <p role="status" className="mt-3 text-xs text-emerald-600">{notice}</p>}
      </section>

      <div className="rounded-2xl border border-border/70 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] font-medium text-foreground">Active connections</p>
          <span className="rounded-full border border-border/80 px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
            {linkedin.connected ? "1" : "None"}
          </span>
        </div>
        <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-muted-foreground">
          {linkedin.connected
            ? "LinkedIn is connected to your account. Posts are only published after you review and approve them."
            : "No services are connected to your account yet. Nothing is linked or sharing data until you connect a service."}
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