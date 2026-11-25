import React, { useEffect } from "react";
import { AudioLines, Loader2, Mic, Volume2, VolumeX, X } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import useVoiceSession from "@/hooks/useVoiceSession";
import { cn } from "@/lib/utils";

const LABELS = {
  idle: "Tap to speak",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Tap to try again",
  unsupported: "Voice isn't supported here",
};

export default function VoiceMode({ onAsk, onClose }) {
  const { status, transcript, reply, muted, error, start, stop, toggleMute, resume } =
    useVoiceSession({ ask: onAsk });

  useEffect(() => {
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    stop();
    onClose();
  };

  const active = status === "listening" || status === "speaking";
  const canRetry = status === "idle" || status === "error";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between px-5 py-4 sm:px-8">
        <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <BrandMark className="h-3.5 w-3.5" />
          Voice
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="End voice conversation"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {active && (
            <>
              <span className="absolute inset-0 rounded-full border border-primary/15 animate-ping [animation-duration:3.5s]" />
              <span className="absolute inset-6 rounded-full border border-primary/20" />
            </>
          )}
          <div
            className={cn(
              "relative flex h-24 w-24 items-center justify-center rounded-full transition-colors duration-500",
              status === "speaking" ? "bg-primary/12" : "bg-secondary",
              active && "ring-1 ring-inset ring-primary/25"
            )}
          >
            <BrandMark className={cn("h-8 w-8 transition-opacity", status === "idle" && "opacity-70")} />
          </div>
        </div>

        <p className="mt-9 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {status === "thinking" && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />}
          {status === "speaking" && <AudioLines className="h-3.5 w-3.5" strokeWidth={1.8} />}
          {LABELS[status]}
        </p>

        <div className="mt-6 min-h-[4.5rem] w-full max-w-xl">
          {transcript ? (
            <p className="font-display text-[26px] leading-[1.3] text-foreground sm:text-[30px]">
              {transcript}
            </p>
          ) : (
            <p className="text-[14px] leading-relaxed text-muted-foreground">
              {status === "unsupported"
                ? "Your browser can't run conversations by voice. Typing and dictation still work."
                : "Speak naturally. Biz listens, answers out loud, then listens again."}
            </p>
          )}
        </div>

        {reply && status !== "listening" && (
          <p className="mt-6 line-clamp-3 max-w-lg text-[13.5px] leading-relaxed text-muted-foreground">
            {reply}
          </p>
        )}

        {error && <p className="mt-5 max-w-sm text-[12.5px] text-destructive">{error}</p>}
      </div>

      <div className="flex items-center justify-center gap-3 pb-12 pt-4">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute voice replies" : "Mute voice replies"}
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full border transition-colors",
            muted
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border/80 text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {muted ? (
            <VolumeX className="h-4 w-4" strokeWidth={1.8} />
          ) : (
            <Volume2 className="h-4 w-4" strokeWidth={1.8} />
          )}
        </button>

        <button
          type="button"
          onClick={canRetry ? resume : undefined}
          disabled={!canRetry}
          aria-label="Speak"
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full transition-all",
            canRetry
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "bg-primary/15 text-primary"
          )}
        >
          {status === "thinking" ? (
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
          ) : status === "speaking" ? (
            <AudioLines className="h-5 w-5" strokeWidth={2} />
          ) : (
            <Mic className="h-5 w-5" strokeWidth={2} />
          )}
        </button>

        <button
          type="button"
          onClick={close}
          className="flex h-11 items-center justify-center rounded-full border border-border/80 px-4 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          End
        </button>
      </div>
    </div>
  );
}