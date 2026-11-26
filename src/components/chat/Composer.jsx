import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, AudioLines, FileText, Loader2, Linkedin, Mic, Paperclip, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { api } from "@/api/client";

/**
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   onSend: (value: string, attachments: Array<{ name: string, url: string, type: string }>) => Promise<boolean>,
 *   onVoice: () => void,
 *   sending: boolean
 * }} props
 */
export default function Composer({ value, onChange, onSend, onVoice, sending }) {
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const recognitionRef = useRef(null);
  const baseTextRef = useRef("");
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");
  const [linkedinConnected, setLinkedinConnected] = useState(false);
  const [linkedinPreview, setLinkedinPreview] = useState("");
  const [linkedinApprovalId, setLinkedinApprovalId] = useState("");
  const [linkedinBusy, setLinkedinBusy] = useState(false);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending && !uploading;

  useEffect(() => {
    let active = true;
    api.linkedin.status()
      .then((status) => {
        if (active) setLinkedinConnected(status.connected === true);
      })
      .catch((error) => {
        if (active) setNotice(error.message || "LinkedIn status couldn't be checked.");
      });
    return () => { active = false; };
  }, []);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const handleInput = (event) => {
    onChange(event.target.value);
    setLinkedinPreview("");
    setLinkedinApprovalId("");
    requestAnimationFrame(resize);
  };

  const previewLinkedInPost = async () => {
    const text = value.trim();
    if (!text || linkedinBusy) return;
    setNotice("");
    setLinkedinBusy(true);
    try {
      const preview = await api.linkedin.post({ text, approved: false });
      setLinkedinPreview(preview.text);
      setLinkedinApprovalId(preview.approvalId);
    } catch (error) {
      setNotice(error.message || "LinkedIn post preview couldn't be created.");
    } finally {
      setLinkedinBusy(false);
    }
  };

  const approveLinkedInPost = async () => {
    if (!linkedinPreview || linkedinBusy) return;
    setNotice("");
    setLinkedinBusy(true);
    try {
      await api.linkedin.post({
        text: linkedinPreview,
        approved: true,
        approvalId: linkedinApprovalId,
      });
      setLinkedinPreview("");
      setLinkedinApprovalId("");
      setNotice("Your post was published to LinkedIn.");
    } catch (error) {
      setNotice(error.message || "The LinkedIn post couldn't be published.");
    } finally {
      setLinkedinBusy(false);
    }
  };

  const handleFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;

    setNotice("");
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) {
          setNotice(`${file.name} is larger than 20 MB.`);
          continue;
        }
        const uploaded = await api.upload(file);
        setAttachments((prev) => [...prev, { name: uploaded.name, url: uploaded.url, type: uploaded.type }]);
      }
    } catch (error) {
      setNotice(error.message || "That file couldn't be attached. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const toggleDictation = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setNotice("Dictation isn't available in this browser.");
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    setNotice("");
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    baseTextRef.current = value ? `${value} ` : "";

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      onChange((baseTextRef.current + transcript).replace(/^\s+/, ""));
      setLinkedinPreview("");
      setLinkedinApprovalId("");
      requestAnimationFrame(resize);
    };
    recognition.onerror = () => {
      setListening(false);
      setNotice("Dictation didn't start. Check microphone access.");
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const submit = async () => {
    if (!canSend) return;
    const ok = await onSend(value.trim(), attachments);
    if (ok) {
      setAttachments([]);
      setNotice("");
      setLinkedinPreview("");
      setLinkedinApprovalId("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const iconButton =
    "flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div>
      <div
        className={cn(
          "rounded-[28px] border border-border bg-secondary px-3 pb-3 pt-3 shadow-[0_8px_32px_-18px_hsl(var(--foreground)/0.18)] backdrop-blur-xl transition-colors",
          "focus-within:border-primary/40 focus-within:bg-secondary",
          listening && "border-primary/40"
        )}
      >
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 px-1.5 pt-0.5">
            {attachments.map((file, index) => (
              <span
                key={`${file.url}-${index}`}
                className="flex max-w-[220px] items-center gap-2 rounded-lg border border-border/70 bg-background/50 py-1 pl-2 pr-1 text-[12px] text-foreground/85"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message Biz"
          className="max-h-[220px] min-h-12 w-full resize-none bg-transparent px-1 pb-3 pt-1 text-[16px] leading-[1.6] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        />

        <div className="flex items-center gap-0.5">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFiles} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            title="Attach a file"
            className={iconButton}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <Paperclip className="h-5 w-5" strokeWidth={1.7} />
            )}
          </button>

          <button
            type="button"
            onClick={toggleDictation}
            aria-label={listening ? "Stop dictation" : "Dictate a message"}
            title="Dictate a message"
            className={cn(
              iconButton,
              listening && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            )}
          >
            {listening ? (
              <Square className="h-3 w-3" strokeWidth={2} fill="currentColor" />
            ) : (
              <Mic className="h-5 w-5" strokeWidth={1.7} />
            )}
          </button>

          <button
            type="button"
            onClick={onVoice}
            aria-label="Start voice conversation"
            title="Voice conversation"
            className={iconButton}
          >
            <AudioLines className="h-5 w-5" strokeWidth={1.7} />
          </button>

          {linkedinConnected && (
            <button
              type="button"
              onClick={previewLinkedInPost}
              disabled={!value.trim() || sending || linkedinBusy}
              title="Preview a LinkedIn post"
              className="inline-flex h-10 items-center gap-1 rounded-full px-2 text-[11px] text-[#0A66C2] transition-colors hover:bg-accent disabled:opacity-40 sm:px-2.5"
            >
              {linkedinBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Linkedin className="h-3.5 w-3.5 text-[#0A66C2]" />}
              <span>Post to LinkedIn</span>
            </button>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className={cn(
              "ml-auto flex h-11 w-11 items-center justify-center rounded-full transition-all",
              canSend
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-muted text-muted-foreground/50"
            )}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <ArrowUp className="h-5 w-5" strokeWidth={2.1} />
            )}
          </button>
        </div>
      </div>

      {linkedinPreview && (
        <div className="mt-3 rounded-xl border border-border/70 bg-card/80 p-3">
          <p className="text-xs font-medium">LinkedIn post preview</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/90">{linkedinPreview}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={linkedinBusy || !linkedinApprovalId}
              onClick={approveLinkedInPost}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {linkedinBusy ? "Publishing…" : "Approve & post"}
            </button>
            <button
              type="button"
              disabled={linkedinBusy}
              onClick={() => {
                setLinkedinPreview("");
                setLinkedinApprovalId("");
              }}
              className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && <p className="mt-2 px-1 text-[12px] text-muted-foreground">{notice}</p>}
    </div>
  );
}