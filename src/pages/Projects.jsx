import React, { useCallback, useEffect, useState } from "react";
import { Check, FolderKanban, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "@/api/client";
import PageContainer from "@/components/layout/PageContainer";

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [details, setDetails] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshProjects = useCallback(async (preferredId = selectedId) => {
    const result = await api.projects.list();
    const nextProjects = result.items || [];
    setProjects(nextProjects);
    if (!nextProjects.some((project) => project.id === preferredId)) {
      setSelectedId(nextProjects[0]?.id || "");
    }
    return nextProjects;
  }, [selectedId]);

  const refreshDetails = useCallback(async (projectId = selectedId) => {
    if (!projectId) {
      setDetails(null);
      return;
    }
    const result = await api.projects.get(projectId);
    setDetails(result);
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    api.projects.list()
      .then((result) => {
        if (!active) return;
        const items = result.items || [];
        setProjects(items);
        setSelectedId((current) => items.some((project) => project.id === current) ? current : items[0]?.id || "");
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "Projects couldn't be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setDetails(null);
    if (!selectedId) return () => { active = false; };
    api.projects.get(selectedId)
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "Project details couldn't be loaded.");
      });
    return () => { active = false; };
  }, [selectedId]);

  const createProject = async (event) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const project = await api.projects.create({
        name: projectName.trim(),
        description: projectDescription.trim(),
      });
      setProjectName("");
      setProjectDescription("");
      setNotice(`Project “${project.name}” created.`);
      await refreshProjects(project.id);
      setSelectedId(project.id);
    } catch (requestError) {
      setError(requestError.message || "Project couldn't be created.");
    } finally {
      setSaving(false);
    }
  };

  const addTask = async (event) => {
    event.preventDefault();
    if (!selectedId || !taskTitle.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.tasks.create({
        project_id: selectedId,
        title: taskTitle.trim(),
        description: taskDescription.trim(),
      });
      setTaskTitle("");
      setTaskDescription("");
      await Promise.all([refreshProjects(), refreshDetails()]);
    } catch (requestError) {
      setError(requestError.message || "Task couldn't be added.");
    } finally {
      setSaving(false);
    }
  };

  const setTaskStatus = async (task) => {
    setSaving(true);
    setError("");
    try {
      await api.tasks.setStatus(task.id, task.status === "completed" ? "pending" : "completed");
      await Promise.all([refreshProjects(), refreshDetails()]);
    } catch (requestError) {
      setError(requestError.message || "Task status couldn't be changed.");
    } finally {
      setSaving(false);
    }
  };

  const removeProject = async () => {
    if (!details || !window.confirm(`Delete “${details.name}”? Its tasks and project-specific memories will also be deleted. Conversation history and jobs will remain.`)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.projects.remove(details.id);
      const remaining = projects.filter((project) => project.id !== details.id);
      setProjects(remaining);
      setSelectedId(remaining[0]?.id || "");
      setDetails(null);
      setNotice(`Project “${details.name}” deleted.`);
    } catch (requestError) {
      setError(requestError.message || "Project couldn't be deleted.");
    } finally {
      setSaving(false);
    }
  };

  const progress = details?.tasks.length
    ? Math.round((details.tasks.filter((task) => task.status === "completed").length / details.tasks.length) * 100)
    : 0;

  return (
    <PageContainer title="Projects" description="Keep related tasks, jobs, memories, and skills together. Mention a project name in chat to link new work.">
      {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-sm">{notice}</p>}

      <form onSubmit={createProject} className="mb-6 rounded-2xl border border-border/70 bg-card/60 p-4">
        <h2 className="mb-3 text-sm font-semibold">Create a project</h2>
        <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Project name"
            maxLength={160}
            aria-label="Project name"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <input
            value={projectDescription}
            onChange={(event) => setProjectDescription(event.target.value)}
            placeholder="Description (optional)"
            maxLength={8000}
            aria-label="Project description"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <button type="submit" disabled={saving || !projectName.trim()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Create
          </button>
        </div>
      </form>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading projects…</div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(190px,0.7fr)_minmax(0,1.5fr)]">
          <section aria-label="Project list" className="space-y-2">
            {projects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No projects yet.</div>
            ) : projects.map((project) => {
              const count = Number(project.task_count || 0);
              const completed = Number(project.completed_task_count || 0);
              const percent = count ? Math.round((completed / count) * 100) : 0;
              return (
                <button
                  type="button"
                  key={project.id}
                  onClick={() => setSelectedId(project.id)}
                  aria-current={selectedId === project.id ? "page" : undefined}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedId === project.id ? "border-primary/40 bg-primary/[0.05]" : "border-border/70 bg-card/50 hover:bg-accent/50"}`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium"><FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />{project.name}</span>
                  <span className="mt-2 block text-[11px] text-muted-foreground">{completed}/{count} tasks · {project.job_count || 0} jobs</span>
                  <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </span>
                </button>
              );
            })}
          </section>

          <section className="min-w-0">
            {!details ? (
              <div className="rounded-xl border border-border/70 bg-card/50 px-4 py-8 text-sm text-muted-foreground">
                Create a project or select one to see its work.
              </div>
            ) : (
              <div className="space-y-5">
                <header className="rounded-2xl border border-border/70 bg-card/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">{details.name}</h2>
                      {details.description && <p className="mt-1 text-sm text-muted-foreground">{details.description}</p>}
                    </div>
                    <button type="button" onClick={removeProject} disabled={saving} aria-label={`Delete ${details.name}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div>
                    <span className="text-xs text-muted-foreground">{progress}% · {details.tasks.filter((task) => task.status === "completed").length}/{details.tasks.length} tasks</span>
                  </div>
                </header>

                <section className="rounded-2xl border border-border/70 bg-card/50 p-4">
                  <h3 className="mb-3 text-sm font-semibold">Tasks</h3>
                  <form onSubmit={addTask} className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <input
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="Add a task"
                      maxLength={240}
                      aria-label="New task title"
                      className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                    />
                    <button type="submit" disabled={saving || !taskTitle.trim()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">
                      <Plus className="h-3.5 w-3.5" /> Add task
                    </button>
                    <input
                      value={taskDescription}
                      onChange={(event) => setTaskDescription(event.target.value)}
                      placeholder="Task details (optional)"
                      maxLength={8000}
                      aria-label="Task details"
                      className="h-9 rounded-lg border border-border bg-background px-3 text-xs sm:col-span-2"
                    />
                  </form>
                  {details.tasks.length ? (
                    <ul className="space-y-2">
                      {details.tasks.map((task) => (
                        <li key={task.id} className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => setTaskStatus(task)}
                            disabled={saving}
                            aria-label={`${task.status === "completed" ? "Reopen" : "Mark complete"} task: ${task.title}`}
                            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${task.status === "completed" ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent hover:border-primary"} disabled:opacity-50`}
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm ${task.status === "completed" ? "text-muted-foreground line-through" : "text-foreground"}`}>{task.title}</p>
                            {task.description && task.description !== task.title && <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>}
                            <p className="mt-1 text-[10px] capitalize text-muted-foreground">{task.status.replaceAll("_", " ")}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-xs text-muted-foreground">No tasks yet.</p>}
                </section>

                <section className="rounded-2xl border border-border/70 bg-card/50 p-4">
                  <h3 className="mb-3 text-sm font-semibold">Related jobs</h3>
                  {details.jobs.length ? (
                    <ul className="space-y-2">
                      {details.jobs.map((job) => (
                        <li key={job.id} className="rounded-lg border border-border/60 px-3 py-2">
                          <div className="flex flex-wrap justify-between gap-2 text-xs">
                            <span className="font-medium capitalize">{job.status.replaceAll("_", " ")}</span>
                            <span className="text-muted-foreground">{new Date(job.created_at).toLocaleString()}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{job.progress?.message || job.progress?.stage || "Job submitted."}</p>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-xs text-muted-foreground">No chat jobs linked yet.</p>}
                </section>

                <section className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
                    <h3 className="mb-3 text-sm font-semibold">Related memories</h3>
                    {details.memories.length ? (
                      <ul className="space-y-2">
                        {details.memories.map((memory) => <li key={memory.id} className="text-xs leading-5 text-muted-foreground">{memory.content}</li>)}
                      </ul>
                    ) : <p className="text-xs text-muted-foreground">No project memories yet.</p>}
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
                    <h3 className="mb-3 text-sm font-semibold">Skills used</h3>
                    {details.skillsUsed.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {details.skillsUsed.map((skill) => <span key={skill} className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{skill}</span>)}
                      </div>
                    ) : <p className="text-xs text-muted-foreground">No optional skills used yet.</p>}
                  </div>
                </section>
              </div>
            )}
          </section>
        </div>
      )}
    </PageContainer>
  );
}
