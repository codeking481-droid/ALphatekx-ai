interface AlphaTekxSpeechRecognitionAlternative {
  readonly transcript: string;
}

interface AlphaTekxSpeechRecognitionResult {
  readonly [index: number]: AlphaTekxSpeechRecognitionAlternative;
  readonly isFinal: boolean;
}

interface AlphaTekxSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<AlphaTekxSpeechRecognitionResult>;
}

interface AlphaTekxSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface AlphaTekxSpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: AlphaTekxSpeechRecognitionEvent) => void) | null;
  onerror: ((event: AlphaTekxSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface Window {
  SpeechRecognition?: new () => AlphaTekxSpeechRecognition;
  webkitSpeechRecognition?: new () => AlphaTekxSpeechRecognition;
}
