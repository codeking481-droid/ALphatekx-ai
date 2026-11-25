import React, { useRef, useState } from "react";
import { ArrowUp, AudioLines, FileText, Loader2, Mic, Paperclip, Square, X } from "lucide-react";

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

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending && !uploading;

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const handleInput = (event) => {
    onChange(event.target.value);
    requestAnimationFrame(resize);
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
    "flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9";

  return (
    <div>
      <div
        className={cn(
          "rounded-[24px] border border-border/80 bg-card/80 px-2.5 pb-2 pt-2.5 shadow-[0_8px_32px_-18px_hsl(var(--foreground)/0.18)] backdrop-blur-xl transition-colors sm:rounded-[26px] sm:px-2 sm:pb-1.5 sm:pt-2",
          "focus-within:border-primary/25 focus-within:bg-card",
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
          placeholder="How can I help you today?"
          className="max-h-[220px] min-h-12 w-full resize-none bg-transparent px-2.5 pb-2 pt-1 text-[16px] leading-[1.6] text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-0 sm:text-[15px]"
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
              <Paperclip className="h-[17px] w-[17px]" strokeWidth={1.7} />
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
              <Mic className="h-[17px] w-[17px]" strokeWidth={1.7} />
            )}
          </button>

          <button
            type="button"
            onClick={onVoice}
            aria-label="Start voice conversation"
            title="Voice conversation"
            className={iconButton}
          >
            <AudioLines className="h-[17px] w-[17px]" strokeWidth={1.7} />
          </button>

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className={cn(
              "ml-auto flex h-10 w-10 items-center justify-center rounded-full transition-all sm:h-9 sm:w-9",
              canSend
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-muted text-muted-foreground/50"
            )}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.1} />
            )}
          </button>
        </div>
      </div>

      {notice && <p className="mt-2 px-1 text-[12px] text-muted-foreground">{notice}</p>}
    </div>
  );
}