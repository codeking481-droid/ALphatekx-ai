import React, { useCallback, useEffect, useState } from "react";
import { Brain, Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { api } from "@/api/client";
import PageContainer from "@/components/layout/PageContainer";

const MEMORY_TYPES = [
  { value: "fact", label: "Fact" },
  { value: "preference", label: "Preference" },
  { value: "project", label: "Project" },
  { value: "lesson-learned", label: "Lesson learned" },
];

const LEGACY_TYPES = {
  conversation_context: "Fact",
  project_context: "Project",
  task_history: "Lesson learned",
  agent_history: "Lesson learned",
};

export default function Memory() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editKind, setEditKind] = useState("fact");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api.memories.list();
      setItems(result.items || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message || "Saved memories couldn't be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const beginEdit = (memory) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditKind(MEMORY_TYPES.some(({ value }) => value === memory.kind) ? memory.kind : "fact");
    setError("");
    setNotice("");
  };

  const saveEdit = async (memory) => {
    setBusy(memory.id);
    setError("");
    setNotice("");
    try {
      await api.memories.update(memory.id, { kind: editKind, content: editContent });
      setEditingId(null);
      setNotice("Memory updated.");
      await refresh();
    } catch (requestError) {
      setError(requestError.message || "Memory couldn't be updated.");
    } finally {
      setBusy("");
    }
  };

  const remove = async (memory) => {
    if (!window.confirm("Delete this saved memory?")) return;
    setBusy(memory.id);
    setError("");
    setNotice("");
    try {
      await api.memories.remove(memory.id);
      setItems((current) => current.filter((item) => item.id !== memory.id));
      setNotice("Memory deleted.");
    } catch (requestError) {
      setError(requestError.message || "Memory couldn't be deleted.");
    } finally {
      setBusy("");
    }
  };

  const removeAll = async () => {
    if (!window.confirm("Delete all saved memories? This cannot be undone.")) return;
    setBusy("all");
    setError("");
    setNotice("");
    try {
      await api.memories.removeAll();
      setItems([]);
      setEditingId(null);
      setNotice("All saved memories were deleted.");
    } catch (requestError) {
      setError(requestError.message || "Memories couldn't be deleted.");
    } finally {
      setBusy("");
    }
  };

  return (
    <PageContainer title="Memory" description="Private facts and preferences AlphaTekx can use to personalize future chats.">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          AlphaTekx saves selected durable facts automatically. Passwords, credentials, API keys, and sensitive personal data are blocked.
        </p>
        <button
          type="button"
          onClick={removeAll}
          disabled={!items.length || Boolean(busy)}
          className="inline-flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete all
        </button>
      </div>

      {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-sm">{notice}</p>}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading memories…</div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card/60 px-5 py-8 text-sm text-muted-foreground">
          <Brain className="mb-3 h-5 w-5" />
          No memories saved yet. Share a lasting preference or useful project fact in chat.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((memory) => {
            const editing = editingId === memory.id;
            return (
              <article key={memory.id} className="rounded-2xl border border-border/70 bg-card/70 p-4 sm:p-5">
                {editing ? (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-muted-foreground">
                      Type
                      <select
                        value={editKind}
                        onChange={(event) => setEditKind(event.target.value)}
                        className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs"
                      >
                        {MEMORY_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Memory
                      <textarea
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                        maxLength={12000}
                        rows={3}
                        className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => saveEdit(memory)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
                        {busy === memory.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {LEGACY_TYPES[memory.kind] || MEMORY_TYPES.find(({ value }) => value === memory.kind)?.label || memory.kind}
                        </span>
                        {memory.source === "chat:auto" && <span className="text-[10px] text-muted-foreground">Auto-saved from chat</span>}
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{memory.content}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => beginEdit(memory)} aria-label={`Edit memory: ${memory.content.slice(0, 40)}`} disabled={Boolean(busy)} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => remove(memory)} aria-label="Delete memory" disabled={Boolean(busy)} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                        {busy === memory.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
