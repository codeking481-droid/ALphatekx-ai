import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2, X } from "lucide-react";

import ChatWelcome from "@/components/chat/ChatWelcome";
import MessageList from "@/components/chat/MessageList";
import Composer from "@/components/chat/Composer";
import QuestionCard, { getClarificationQuestions } from "@/components/chat/QuestionCard";
import VoiceMode from "@/components/voice/VoiceMode";
import { api } from "@/api/client";
import { isUiPreview } from "@/lib/ui-preview";

function userTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export default function Chat() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const scrollRef = useRef(null);
  const loadedIdRef = useRef(null);
  const activePollRef = useRef(null);

  const [messages, setMessages] = useState([]);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobProgress, setJobProgress] = useState("");
  const [pendingApproval, setPendingApproval] = useState(false);
  const [showAds, setShowAds] = useState(false);

  useEffect(() => () => activePollRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    api.settings.plan()
      .then((currentPlan) => {
        if (active) setShowAds(currentPlan.plan === "free");
      })
      .catch((requestError) => {
        if (active) setError(requestError.message || "Your plan settings couldn't be loaded.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!conversationId) {
      loadedIdRef.current = null;
      setMessages([]);
      setLoading(false);
      setError("");
      return;
    }

    if (loadedIdRef.current === conversationId) return;

    let alive = true;
    setLoading(true);
    setError("");

    api.conversations.messages(conversationId)
      .then((page) => {
        if (!alive) return;
        loadedIdRef.current = conversationId;
        setMessages(page.items || []);
      })
      .catch(() => {
        if (!alive) return;
        setError("This conversation couldn't be loaded.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: messages.length > 1 ? "smooth" : "auto" });
  }, [messages, sending, loading]);

  const trackConversation = useCallback((id) => {
    if (!conversationId && id) {
      loadedIdRef.current = id;
      navigate(`/c/${id}`, { replace: true });
    }
  }, [conversationId, navigate]);

  const applyJobResult = useCallback((messageId, job) => {
    let response = job.result?.reply || "";
    setPendingApproval(job.status === "waiting_approval");
    if (job.status === "waiting_approval") {
      response = `${response}${response ? "\n\n" : ""}This task is paused for your approval. Open Approvals in the sidebar to continue.`;
    } else if (job.status === "failed") {
      response = `The task failed: ${job.error?.message || "The worker could not complete it."}`;
    } else if (job.status === "cancelled") {
      response = "Task cancelled.";
    }
    setMessages((previous) => previous.map((message) =>
      message.id === messageId
        ? {
            ...message,
            content: response,
            skill: job.result?.skill || null,
            memoriesUsed: job.result?.memoriesUsed || [],
          }
        : message
    ));
    trackConversation(job.result?.conversation_id || job.conversation_id);
  }, [trackConversation]);

  const cancelActiveJob = async () => {
    if (!activeJobId) return;
    try {
      const job = await api.jobs.cancel(activeJobId);
      setJobProgress(job.progress?.message || "Cancellation requested.");
    } catch (requestError) {
      setError(requestError.message || "The task couldn't be cancelled.");
    }
  };

  const handleSend = useCallback(
    async (text, attachments) => {
      if (sending) return false;
      if (isUiPreview()) {
        setError("This UI preview is offline. Connect the local API to send messages.");
        return false;
      }

      const tempId = `pending-${Date.now()}`;
      const assistantId = `assistant-pending-${Date.now()}`;
      let submittedJobId = null;
      setMessages((prev) => [...prev, { id: tempId, role: "user", content: text, attachments }]);
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "Queued for the worker…" }]);
      setSending(true);
      setError("");
      setPendingApproval(false);

      try {
        const data = await api.chat({
          conversation_id: conversationId || null,
          message: text,
          timezone: userTimezone(),
          attachments: attachments.map((file) => ({ name: file.name, url: file.url })),
        });
        submittedJobId = data.job_id;
        setActiveJobId(submittedJobId);
        const controller = new AbortController();
        activePollRef.current = controller;
        const job = await pollJob(submittedJobId, controller.signal, (update) => {
          const progress = update.progress?.message || "Working on your task…";
          setJobProgress(progress);
          setMessages((previous) => previous.map((message) =>
            message.id === assistantId ? { ...message, content: progress } : message
          ));
        });
        applyJobResult(assistantId, job);
        setActiveJobId(null);
        setJobProgress("");
        activePollRef.current = null;
        setSending(false);
        return true;
      } catch (requestError) {
        if (!submittedJobId) {
          setMessages((prev) => prev.filter((message) => message.id !== tempId && message.id !== assistantId));
          setError(requestError.message || "That message didn't go through. Please try again.");
          setSending(false);
          return false;
        }
        if (requestError.name !== "AbortError") {
          setMessages((previous) => previous.map((message) =>
            message.id === assistantId
              ? { ...message, content: `Task submitted, but its status couldn't be refreshed: ${requestError.message || "try again shortly."}` }
              : message
          ));
          setError(requestError.message || "The task was submitted, but its status couldn't be refreshed.");
        }
        setActiveJobId(null);
        setJobProgress("");
        setSending(false);
        return true;
      }
    },
    [applyJobResult, conversationId, navigate, sending]
  );

  const handleVoiceAsk = useCallback(
    async (text) => {
      setMessages((prev) => [
        ...prev,
        { id: `voice-${Date.now()}`, role: "user", content: text, attachments: [] },
      ]);

      const data = await api.chat({
        conversation_id: conversationId || null,
        message: text,
        timezone: userTimezone(),
        attachments: [],
      });
      const assistantId = `voice-reply-${Date.now()}`;
      setMessages((previous) => [...previous, { id: assistantId, role: "assistant", content: "Queued for the worker…" }]);
      const controller = new AbortController();
      activePollRef.current = controller;
      const job = await pollJob(data.job_id, controller.signal, (update) => {
        const progress = update.progress?.message || "Working on your task…";
        setMessages((previous) => previous.map((message) =>
          message.id === assistantId ? { ...message, content: progress } : message
        ));
      });
      applyJobResult(assistantId, job);
      activePollRef.current = null;
      return job.result?.reply || "";
    },
    [applyJobResult, conversationId, navigate]
  );

  const isEmpty = !loading && messages.length === 0;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const clarificationQuestions = latestAssistant ? getClarificationQuestions(latestAssistant.content) : [];

  const composer = (
    <Composer
      value={value}
      onChange={setValue}
      onSend={async (text, attachments) => {
        const ok = await handleSend(text, attachments);
        if (ok) setValue("");
        return ok;
      }}
      onVoice={() => {
        if (isUiPreview()) {
          setError("Voice chat is unavailable in the UI-only preview.");
          return;
        }
        setVoiceOpen(true);
      }}
      sending={sending}
    />
  );

  const footnote = (
    <p className="mt-3 text-center text-[11px] text-muted-foreground/60">
      Biz can make mistakes. Check important information.
    </p>
  );

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pt-4 sm:px-8 sm:pt-10">
              <div className="flex flex-1 flex-col justify-center py-4">
                <ChatWelcome onPick={setValue} />
              </div>
            </div>
          </div>

          <div className="shrink-0 bg-gradient-to-t from-background via-background to-background/0">
            <div className="mx-auto w-full max-w-2xl px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-5">
              {error && (
                <div className="mb-2.5 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive">
                  {error}
                </div>
              )}
              {composer}
              {footnote}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-2xl px-4 pb-8 pt-6 sm:px-8 sm:pb-10 sm:pt-10">
              {loading ? (
                <div className="flex items-center justify-center py-24 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.8} />
                </div>
              ) : (
                <MessageList
                  messages={messages}
                  thinking={sending}
                  showAds={showAds}
                  hiddenMessageId={clarificationQuestions.length ? latestAssistant.id : null}
                />
              )}
            </div>
          </div>

          <div className="shrink-0 bg-gradient-to-t from-background via-background to-background/0">
            <div className="mx-auto w-full max-w-2xl px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-8 sm:pb-5">
              {activeJobId && (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <span className="truncate">{jobProgress || "Working on your task…"}</span>
                  </span>
                  <button type="button" onClick={cancelActiveJob} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-accent hover:text-foreground">
                    <X className="h-3 w-3" /> Cancel
                  </button>
                </div>
              )}
              {pendingApproval && (
                <div className="mb-2 rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-2 text-xs text-muted-foreground">
                  This task needs your approval. <Link className="font-medium text-primary hover:underline" to="/approvals">Review approvals</Link>
                </div>
              )}
              {clarificationQuestions.length > 0 && !sending && (
                <QuestionCard key={latestAssistant.id} questions={clarificationQuestions} onAnswer={(answer) => handleSend(answer, [])} />
              )}
              {error && (
                <div className="mb-2.5 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive">
                  {error}
                </div>
              )}
              {composer}
              {footnote}
            </div>
          </div>
        </>
      )}

      {voiceOpen && (
        <VoiceMode onAsk={handleVoiceAsk} onClose={() => setVoiceOpen(false)} />
      )}
    </div>
  );
}

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "waiting_approval"]);

async function pollJob(jobId, signal, onUpdate) {
  let retryDelay = 1000;
  while (true) {
    if (signal.aborted) throw signal.reason || new DOMException("Polling was cancelled.", "AbortError");
    try {
      const job = await api.jobs.get(jobId, signal);
      onUpdate(job);
      if (TERMINAL_JOB_STATES.has(job.status)) return job;
      retryDelay = 1000;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") throw error;
      if (error.status && error.status < 500) throw error;
      onUpdate({ progress: { message: "Waiting for job status; retrying…" } });
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(5000, retryDelay * 2);
    }
  }
}