import { useCallback, useEffect, useRef, useState } from "react";

export default function useVoiceSession({ ask }) {
  const [status, setStatus] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);

  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const recognitionRef = useRef(null);
  const askRef = useRef(ask);
  askRef.current = ask;

  function speak(text) {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setStatus("idle");
      return;
    }

    const synthesis = window.speechSynthesis;
    synthesis.cancel();

    if (!text || mutedRef.current) {
      setStatus("idle");
      return;
    }

    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/[*_`#>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 900));
    const voices = typeof synthesis.getVoices === "function" ? synthesis.getVoices() : [];
    const language = (navigator.language || "en").slice(0, 2);
    const preferred =
      voices.find((voice) =>
        /Google US English|Google UK English|Samantha|Serena|Daniel|Ava|Allison/i.test(voice.name)
      ) ||
      voices.find((voice) => (voice.lang || "").toLowerCase().startsWith(language)) ||
      voices[0];

    if (preferred) {
      utterance.voice = preferred;
      utterance.lang = preferred.lang;
    }
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => {
      if (activeRef.current) beginListening();
    };
    utterance.onerror = () => {
      if (activeRef.current) beginListening();
    };

    setStatus("speaking");
    synthesis.speak(utterance);
  }

  async function submit(text) {
    setStatus("thinking");
    setTranscript(text);
    try {
      const answer = await askRef.current(text);
      setReply(answer || "");
      speak(answer || "");
    } catch {
      setError("AlphaTekx couldn't respond. Tap the microphone to try again.");
      setStatus("error");
    }
  }

  function beginListening() {
    if (!activeRef.current) return;

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setStatus("unsupported");
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // already finished
      }
    }

    setError("");
    setTranscript("");

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    let finalText = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      setTranscript(`${finalText}${interim}`.trim());
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      if (event.error === "no-speech") {
        setStatus("idle");
        return;
      }
      setError(
        event.error === "not-allowed"
          ? "Microphone access is blocked. Allow it in your browser to talk with AlphaTekx."
          : "The microphone couldn't be used. Check your device settings."
      );
      setStatus("error");
    };

    recognition.onend = () => {
      if (!activeRef.current) return;
      recognitionRef.current = null;
      const text = finalText.trim();
      if (!text) {
        setStatus("idle");
        return;
      }
      submit(text);
    };

    try {
      recognition.start();
      setStatus("listening");
    } catch {
      setStatus("idle");
    }
  }

  function start() {
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      setStatus("unsupported");
      return;
    }
    activeRef.current = true;
    setError("");
    setReply("");
    setTranscript("");
    beginListening();
  }

  const stop = useCallback(() => {
    activeRef.current = false;
    try {
      recognitionRef.current?.abort();
    } catch {
      // already finished
    }
    recognitionRef.current = null;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setStatus("idle");
  }, []);

  function toggleMute() {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    if (mutedRef.current && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      if (activeRef.current) setStatus("idle");
    }
  }

  const resume = () => {
    if (!activeRef.current) activeRef.current = true;
    beginListening();
  };

  useEffect(() => stop, [stop]);

  return { status, transcript, reply, muted, error, start, stop, toggleMute, resume };
}