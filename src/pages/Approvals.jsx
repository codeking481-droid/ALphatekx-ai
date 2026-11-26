import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";

import { api } from "@/api/client";

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "waiting_approval"]);

export default function Approvals() {
  const [items, setItems] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [skillApprovals, setSkillApprovals] = useState([]);
  const [recent, setRecent] = useState([]);
  const [decisions, setDecisions] = useState({});
  const [rememberSelections, setRememberSelections] = useState({});
  const [jobs, setJobs] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [busySkillId, setBusySkillId] = useState(null);
  const [revokingToolId, setRevokingToolId] = useState(null);
  const [error, setError] = useState("");
  const monitorControllers = useRef(new Map());

  const refresh = useCallback(async () => {
    try {
      const [approvalData, permissionData, skillApprovalData] = await Promise.all([
        api.approvals.list(),
        api.toolPermissions.list(),
        api.skills.pendingApprovals(),
      ]);
      setItems(approvalData.items || []);
      setPermissions(permissionData.items || []);
      setSkillApprovals(skillApprovalData.items || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message || "Approvals couldn't be loaded.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      clearInterval(timer);
      monitorControllers.current.forEach((controller) => controller.abort());
      monitorControllers.current.clear();
    };
  }, [refresh]);

  const monitorJob = async (approvalId, jobId, signal) => {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (signal.aborted) return;
      try {
        const job = await api.jobs.get(jobId, signal);
        setJobs((previous) => ({ ...previous, [approvalId]: job }));
        if (TERMINAL_JOB_STATES.has(job.status)) {
          if (job.status === "waiting_approval") await refresh();
          return;
        }
      } catch (requestError) {
        if (signal.aborted) return;
        setError(requestError.message || "The approved task status couldn't be refreshed.");
        return;
      }
    }
  };

  const decide = async (approval, decision) => {
    setBusyId(approval.id);
    setError("");
    try {
      const rememberForWorkspace = decision === "approved" && rememberSelections[approval.id] === true;
      const result = await api.approvals.decide(approval.id, decision, rememberForWorkspace);
      setDecisions((previous) => ({ ...previous, [approval.id]: decision }));
      setRecent((previous) => [approval, ...previous.filter((item) => item.id !== approval.id)].slice(0, 10));
      if (result.job_id) {
        setJobs((previous) => ({
          ...previous,
          [approval.id]: { id: result.job_id, status: result.status, conversation_id: result.conversation_id },
        }));
        const controller = new AbortController();
        monitorControllers.current.set(approval.id, controller);
        void monitorJob(approval.id, result.job_id, controller.signal).finally(() => {
          if (monitorControllers.current.get(approval.id) === controller) {
            monitorControllers.current.delete(approval.id);
          }
        });
      }
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "The approval decision couldn't be saved.");
    } finally {
      setBusyId(null);
    }
  };

  const revokePermission = async (toolId) => {
    setRevokingToolId(toolId);
    setError("");
    try {
      await api.toolPermissions.revoke(toolId);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "The tool permission couldn't be revoked.");
    } finally {
      setRevokingToolId(null);
    }
  };

  const decideSkill = async (approval, decision) => {
    setBusySkillId(approval.id);
    setError("");
    try {
      await api.skills.decideApproval(approval.id, decision);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "The skill approval couldn't be saved.");
    } finally {
      setBusySkillId(null);
    }
  };

  const displayedItems = [
    ...items,
    ...recent.filter((recentItem) => !items.some((item) => item.id === recentItem.id)),
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="mb-7 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Review tool and skill requests before Biz uses or installs them.</p>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {permissions.length > 0 && (
        <section className="mb-6 rounded-2xl border border-border/70 bg-card/60 p-4">
          <h2 className="text-sm font-semibold">Allowed in this workspace</h2>
          <ul className="mt-3 space-y-2">
            {permissions.map((permission) => (
              <li key={`${permission.tool_id}:${permission.granted_at}`} className="flex items-center justify-between gap-3 text-sm">
                <span>{permission.tool_id === "file_write" ? "File writes" : permission.tool_id}</span>
                <button
                  type="button"
                  disabled={revokingToolId === permission.tool_id}
                  onClick={() => revokePermission(permission.tool_id)}
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                >
                  {revokingToolId === permission.tool_id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {skillApprovals.length > 0 && (
        <section className="mb-6 space-y-3">
          <h2 className="text-sm font-semibold">Skills awaiting approval</h2>
          {skillApprovals.map((approval) => (
            <article key={approval.id} className="rounded-2xl border border-amber-500/25 bg-card/70 p-4 sm:p-5">
              <p className="text-sm font-medium">
                {approval.action === "install" ? "Install" : "Enable"} skill: {approval.name}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Requested tools: {approval.tools?.join(", ")}. Tool permissions and per-action approvals still apply.
              </p>
              {approval.markdown && (
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-background/70 p-3 text-xs">
                  {approval.markdown}
                </pre>
              )}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busySkillId === approval.id}
                  onClick={() => decideSkill(approval, "approved")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busySkillId === approval.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Approve skill
                </button>
                <button
                  type="button"
                  disabled={busySkillId === approval.id}
                  onClick={() => decideSkill(approval, "denied")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Deny
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {displayedItems.length === 0 && skillApprovals.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card/60 px-5 py-8 text-sm text-muted-foreground">
          No pending approvals.
        </div>
      ) : displayedItems.length > 0 ? (
        <div className="space-y-3">
          {displayedItems.map((approval) => {
            const job = jobs[approval.id];
            const decision = decisions[approval.id];
            return (
              <article key={approval.id} className="rounded-2xl border border-border/70 bg-card/70 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{approval.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Tool: {approval.tool_name || approval.tool_id} · Expires {new Date(approval.expires_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
                    {job?.status || "Pending"}
                  </span>
                </div>

                {approval.tool_id === "file_write" && approval.input && (
                  <div className="mt-3 rounded-xl border border-border/70 bg-background/70 p-3">
                    <p className="text-xs text-muted-foreground">Proposed file: {approval.input.path}</p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {approval.input.content}
                    </pre>
                  </div>
                )}

                {job?.conversation_id && (
                  <Link className="mt-3 inline-block text-xs text-primary hover:underline" to={`/c/${job.conversation_id}`}>
                    Open conversation
                  </Link>
                )}

                {job?.status && !TERMINAL_JOB_STATES.has(job.status) && (
                  <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {job.progress?.message || "The worker is continuing this task."}
                  </p>
                )}
                {job?.status === "waiting_approval" && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Another tool request is waiting for approval. Refresh this page to review it.
                  </p>
                )}
                {job?.status === "failed" && (
                  <p role="alert" className="mt-3 text-xs text-destructive">
                    {job.error?.message || "The worker could not complete this task."}
                  </p>
                )}
                {decision && !job && <p className="mt-3 text-xs text-muted-foreground">Decision recorded: {decision}.</p>}

                {!decision && (
                  <div className="mt-4">
                    {approval.tool_id === "file_write" && (
                      <label className="mb-3 flex items-start gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={rememberSelections[approval.id] === true}
                          onChange={(event) => setRememberSelections((previous) => ({
                            ...previous,
                            [approval.id]: event.target.checked,
                          }))}
                          className="mt-0.5"
                        />
                        Always allow file writes in this workspace
                      </label>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyId === approval.id}
                        onClick={() => decide(approval, "approved")}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {busyId === approval.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busyId === approval.id}
                        onClick={() => decide(approval, "denied")}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        Deny
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
