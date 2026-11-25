import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.skills.list();
      setSkills(data.items || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message || "Skills couldn't be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const install = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusyName("upload");
    setError("");
    setNotice("");
    try {
      const result = await api.skills.install(file);
      setNotice(result.status === "pending_approval"
        ? `“${result.approval.name}” needs approval before it can be installed.`
        : `“${result.skill.name}” is installed and enabled.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "Skill couldn't be installed.");
    } finally {
      setBusyName("");
    }
  };

  const setEnabled = async (skill) => {
    setBusyName(skill.name);
    setError("");
    setNotice("");
    try {
      const result = await api.skills.setEnabled(skill.name, !skill.enabled);
      setNotice(result.status === "pending_approval"
        ? `“${skill.name}” needs approval before it can be enabled.`
        : `“${skill.name}” is ${result.status}.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "Skill setting couldn't be changed.");
    } finally {
      setBusyName("");
    }
  };

  const remove = async (skill) => {
    setBusyName(skill.name);
    setError("");
    setNotice("");
    try {
      await api.skills.remove(skill.name);
      setNotice(`“${skill.name}” was removed from your skills.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "Skill couldn't be removed.");
    } finally {
      setBusyName("");
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
            <p className="mt-1 text-sm text-muted-foreground">Optional Markdown guidance. Built-in tools work with no skills enabled.</p>
          </div>
        </div>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.zip,text/markdown,application/zip"
            onChange={install}
            className="sr-only"
            aria-label="Upload a SKILL.md file or ZIP"
          />
          <button
            type="button"
            disabled={busyName === "upload"}
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busyName === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Install skill
          </button>
        </div>
      </header>

      <p className="mb-6 rounded-xl border border-border/70 bg-card/60 px-4 py-3 text-xs leading-5 text-muted-foreground">
        Upload one <code>SKILL.md</code> or a ZIP containing only that file. Skills are plain Markdown, isolated per account, and cannot execute code. A skill's tool list limits planning; existing permissions and approvals still apply.
      </p>

      {error && <div role="alert" className="mb-4 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.05] px-4 py-3 text-sm text-foreground">{notice} {notice.includes("needs approval") && <Link className="ml-1 underline" to="/approvals">Review it</Link>}</div>}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading skills…</div>
      ) : skills.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card/60 px-5 py-8 text-sm text-muted-foreground">
          No skills are installed. AlphaTekx can still reason and use its built-in tools.
        </div>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <article key={skill.name} className="rounded-2xl border border-border/70 bg-card/70 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{skill.name}</h2>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">v{skill.version}</span>
                    {skill.bundled && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">Example</span>}
                    {skill.builtin && <span className="rounded-full border border-primary/20 bg-primary/[0.05] px-2 py-0.5 text-[10px] text-primary">Built-in</span>}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{skill.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {skill.tools.map((tool) => <span key={tool} className="rounded-md bg-muted/70 px-2 py-1 font-mono text-[10px] text-muted-foreground">{tool}</span>)}
                  </div>
                  {skill.dangerous && (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <ShieldCheck className="h-3.5 w-3.5" /> Skills requesting protected tools require approval to install or enable.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                    disabled={Boolean(busyName) || skill.builtin}
                    onClick={() => setEnabled(skill)}
                    className={`relative h-6 w-11 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${skill.enabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${skill.enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
                  </button>
                  {!skill.bundled && !skill.builtin && (
                    <button
                      type="button"
                      aria-label={`Delete ${skill.name}`}
                      title="Delete skill"
                      disabled={Boolean(busyName)}
                      onClick={() => remove(skill)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      {busyName === skill.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
