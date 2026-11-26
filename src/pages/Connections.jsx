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
  Plus,
  RefreshCw,
  ExternalLink,
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

const POPULAR_MCP_SERVICES = [
  { name: "Notion", exampleUrl: "https://mcp.example.com/notion", docs: "https://developers.notion.com/docs/getting-started" },
  { name: "Slack", exampleUrl: "https://mcp.example.com/slack", docs: "https://docs.slack.dev/ai/slack-mcp-server" },
  { name: "Gmail", exampleUrl: "https://mcp.example.com/gmail", docs: "https://developers.google.com/workspace/gmail/api" },
  { name: "Google Calendar", exampleUrl: "https://mcp.example.com/calendar", docs: "https://developers.google.com/workspace/calendar/api" },
  { name: "GitHub", exampleUrl: "https://mcp.example.com/github", docs: "https://docs.github.com/en/rest" },
  { name: "Google Drive", exampleUrl: "https://mcp.example.com/drive", docs: "https://developers.google.com/workspace/drive/api" },
];

export default function Connections() {
  const location = useLocation();
  const navigate = useNavigate();
  const [linkedin, setLinkedin] = useState({ configured: false, connected: false, name: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpApiKey, setMcpApiKey] = useState("");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [mcpError, setMcpError] = useState("");
  const [mcpNotice, setMcpNotice] = useState("");
  const [visibleTools, setVisibleTools] = useState(null);
  const [toolsLoading, setToolsLoading] = useState(false);

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
    let active = true;
    api.mcp.list()
      .then(({ items }) => {
        if (active) setMcpServers(items || []);
      })
      .catch((requestError) => {
        if (active) setMcpError(requestError.message || "MCP servers couldn't be loaded.");
      })
      .finally(() => {
        if (active) setMcpLoading(false);
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

  const setMcpToolEnabled = async (server, tool) => {
    setMcpBusy(true);
    setMcpError("");
    try {
      const updated = await api.mcp.setToolEnabled(server.id, tool.name, !tool.enabled);
      setVisibleTools((current) => current?.serverId === server.id
        ? { ...current, items: current.items.map((item) => item.name === tool.name ? { ...item, enabled: updated.enabled } : item) }
        : current);
      setMcpNotice(`${tool.name} is ${updated.enabled ? "enabled" : "disabled"} for chat.`);
    } catch (requestError) {
      setMcpError(requestError.message || "MCP tool setting couldn't be changed.");
    } finally {
      setMcpBusy(false);
    }
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

  const addMcpServer = async (event) => {
    event.preventDefault();
    if (mcpBusy) return;
    setMcpBusy(true);
    setMcpError("");
    setMcpNotice("");
    try {
      let headers = {};
      if (mcpHeaders.trim()) {
        try {
          headers = JSON.parse(mcpHeaders);
        } catch {
          throw new Error("Additional headers must be valid JSON, such as {\"X-API-Key\":\"your-key\"}.");
        }
      }
      const server = await api.mcp.connect({ name: mcpName, url: mcpUrl, apiKey: mcpApiKey, headers });
      setMcpServers((current) => [...current.filter((item) => item.id !== server.id), server]);
      setMcpApiKey("");
      setMcpHeaders("");
      setMcpNotice(`${server.name} connected with ${server.toolsCount} tools.`);
    } catch (requestError) {
      setMcpError(requestError.message || "MCP server couldn't be connected.");
    } finally {
      setMcpBusy(false);
    }
  };

  const testMcpServer = async (server) => {
    setMcpBusy(true);
    setMcpError("");
    setMcpNotice("");
    try {
      const updated = await api.mcp.test(server.id);
      setMcpServers((current) => current.map((item) => item.id === server.id ? updated : item));
      setMcpNotice(`${server.name} is reachable; ${updated.toolsCount} tools are available.`);
    } catch (requestError) {
      setMcpServers((current) => current.map((item) => item.id === server.id
        ? { ...item, status: "failed", lastError: requestError.message || "The server could not be reached." }
        : item));
      setMcpError(requestError.message || `${server.name} couldn't be reached.`);
    } finally {
      setMcpBusy(false);
    }
  };

  const viewMcpTools = async (server) => {
    setToolsLoading(true);
    setMcpError("");
    try {
      const result = await api.mcp.tools(server.id);
      setVisibleTools({ serverId: server.id, items: result.items || [] });
    } catch (requestError) {
      setMcpError(requestError.message || "MCP tools couldn't be loaded.");
    } finally {
      setToolsLoading(false);
    }
  };

  const disconnectMcpServer = async (server) => {
    setMcpBusy(true);
    setMcpError("");
    setMcpNotice("");
    try {
      await api.mcp.disconnect(server.id);
      setMcpServers((current) => current.filter((item) => item.id !== server.id));
      if (visibleTools?.serverId === server.id) setVisibleTools(null);
      setMcpNotice(`${server.name} was disconnected.`);
    } catch (requestError) {
      setMcpError(requestError.message || `${server.name} couldn't be disconnected.`);
    } finally {
      setMcpBusy(false);
    }
  };

  const selectPopularMcp = (name) => {
    const service = POPULAR_MCP_SERVICES.find((item) => item.name === name);
    setMcpName(name);
    setMcpUrl(service?.exampleUrl || "");
    setMcpApiKey("");
  };

  const startPopularMcpConnection = (name) => {
    selectPopularMcp(name);
    document.getElementById("mcp-connect-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <PageContainer
      title="Connections"
      description="Biz works best with the tools you already use. Each connection will be authorised by you, and only used when you ask."
    >
      <section className="mb-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 text-[#0A66C2]">
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
              className="rounded-lg bg-[#0A66C2] px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Connect LinkedIn
            </button>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
        {notice && <p role="status" className="mt-3 text-xs text-emerald-600">{notice}</p>}
      </section>

      <section className="mb-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground">
            <Plus className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">MCP servers</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Connect your own Model Context Protocol server. Biz validates public HTTPS endpoints and encrypts the optional API key.
            </p>
          </div>
        </div>
        <form id="mcp-connect-form" onSubmit={addMcpServer} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-foreground/80">
            Server name
            <input
              value={mcpName}
              onChange={(event) => setMcpName(event.target.value)}
              required
              maxLength={100}
              placeholder="My MCP server"
              className="mt-1.5 h-10 w-full rounded-xl border border-border/80 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </label>
          <label className="text-xs font-medium text-foreground/80">
            MCP server URL (HTTPS)
            <input
              type="url"
              value={mcpUrl}
              onChange={(event) => setMcpUrl(event.target.value)}
              required
              maxLength={2048}
              placeholder="https://your-server.example/mcp"
              className="mt-1.5 h-10 w-full rounded-xl border border-border/80 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </label>
          <label className="text-xs font-medium text-foreground/80 sm:col-span-2">
            API key <span className="font-normal text-muted-foreground">(optional; never displayed after save)</span>
            <input
              type="password"
              autoComplete="new-password"
              value={mcpApiKey}
              onChange={(event) => setMcpApiKey(event.target.value)}
              maxLength={2000}
              placeholder="Paste your server key"
              className="mt-1.5 h-10 w-full rounded-xl border border-border/80 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </label>
          <label className="text-xs font-medium text-foreground/80 sm:col-span-2">
            Additional headers <span className="font-normal text-muted-foreground">(optional JSON object; values are encrypted)</span>
            <textarea
              value={mcpHeaders}
              onChange={(event) => setMcpHeaders(event.target.value)}
              rows={2}
              placeholder={'{"X-API-Key":"your-secret"}'}
              className="mt-1.5 w-full resize-y rounded-xl border border-border/80 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={mcpBusy || mcpLoading}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mcpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Connect MCP server
            </button>
          </div>
        </form>

        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Popular MCPs</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {POPULAR_MCP_SERVICES.map(({ name, docs }) => (
              <span key={name} className="inline-flex items-center gap-1 rounded-full border border-border/80 pl-3 pr-1.5 py-1">
                <button
                  type="button"
                  onClick={() => selectPopularMcp(name)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {name}
                </button>
                <a
                  href={docs}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${name} documentation`}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            The prefilled .example URLs are placeholders, not live servers. Replace them with a real MCP endpoint from the provider or server documentation. Biz does not install servers or supply keys.
          </p>
        </div>

        {(mcpError || mcpNotice) && (
          <p role={mcpError ? "alert" : "status"} className={`mt-3 text-xs ${mcpError ? "text-destructive" : "text-emerald-600"}`}>
            {mcpError || mcpNotice}
          </p>
        )}

        <div className="mt-4 space-y-3">
          {mcpLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : mcpServers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No MCP servers connected yet.</p>
          ) : mcpServers.map((server) => (
            <div key={server.id} className="rounded-xl border border-border/70 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{server.name}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">{server.url}</p>
                  <p className={`mt-1 text-xs ${server.status === "failed" ? "text-destructive" : "text-emerald-600"}`}>
                    {server.status === "failed" ? `Failed · ${server.lastError || "Connection test failed."}` : `Connected · ${server.toolsCount} tools`}{server.hasApiKey ? " · API key saved" : ""}
                    {server.customHeaderNames?.length ? ` · headers: ${server.customHeaderNames.join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={mcpBusy || toolsLoading} onClick={() => viewMcpTools(server)} className="rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
                    {toolsLoading && visibleTools?.serverId === server.id ? "Loading…" : "View tools"}
                  </button>
                  <button type="button" disabled={mcpBusy} onClick={() => testMcpServer(server)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
                    <RefreshCw className="h-3 w-3" /> Test
                  </button>
                  <button type="button" disabled={mcpBusy} onClick={() => disconnectMcpServer(server)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
                    <Unplug className="h-3 w-3" /> Disconnect
                  </button>
                </div>
              </div>
              {visibleTools?.serverId === server.id && (
                <div className="mt-3 divide-y divide-border/60 rounded-lg bg-muted/30 px-3">
                  {visibleTools.items.length ? visibleTools.items.map((tool) => (
                    <div key={tool.name} className="py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium">{tool.name}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                          {tool.requiresApproval ? "Approval required" : "Read-only"}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={tool.enabled}
                          aria-label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`}
                          disabled={mcpBusy}
                          onClick={() => setMcpToolEnabled(server, tool)}
                          className={`ml-auto relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${tool.enabled ? "bg-primary" : "bg-muted"}`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${tool.enabled ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
                    </div>
                  )) : <p className="py-3 text-xs text-muted-foreground">This server does not currently expose tools.</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-2xl border border-border/70 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] font-medium text-foreground">Active connections</p>
          <span className="rounded-full border border-border/80 px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
            {linkedin.connected || mcpServers.length ? `${Number(linkedin.connected) + mcpServers.length}` : "None"}
          </span>
        </div>
        <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-muted-foreground">
          {linkedin.connected || mcpServers.length
            ? `${linkedin.connected ? "LinkedIn posts are only published after you review and approve them. " : ""}${mcpServers.length ? `${mcpServers.length} MCP server${mcpServers.length === 1 ? " is" : "s are"} connected and available to Biz.` : ""}`
            : "No services are connected to your account yet. Nothing is linked or sharing data until you connect a service."}
        </p>
      </div>

      <div className="mt-8">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          Available through MCP
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect your own compatible MCP server for these services. Biz does not provide vendor OAuth connections here.
        </p>
        <div className="mt-3 divide-y divide-border/60">
          {SERVICES.map(({ name, icon: Icon, description }) => {
            const server = mcpServers.find((item) => item.name.trim().toLowerCase() === name.toLowerCase());
            return (
              <div key={name} className="flex items-start gap-3.5 py-4">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground">
                  <Icon className="h-4 w-4" strokeWidth={1.7} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <p className="text-[13.5px] font-medium text-foreground">{name}</p>
                    <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80">
                      {server ? "Connected via MCP" : "Not connected"}
                    </span>
                  </div>
                  <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                </div>
                {server ? (
                  <button
                    type="button"
                    disabled={mcpBusy}
                    onClick={() => disconnectMcpServer(server)}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => startPopularMcpConnection(name)}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
                  >
                    Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </PageContainer>
  );
}