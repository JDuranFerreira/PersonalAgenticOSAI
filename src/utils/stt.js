/* ==========================================================================
   Agentic OS — Speech to Text (Milestone 1: microphone dictation)
   Uses the Web Speech API (window.webkitSpeechRecognition / SpeechRecognition).
   Falls back gracefully when unsupported.
 ========================================================================== */

const SpeechRecognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function isSttSupported() {
  return Boolean(SpeechRecognition);
}

export function startListening({ onResult, onEnd, onError, lang = "en-US" } = {}) {
  if (!isSttSupported()) {
    if (onError) onError(new Error("Speech recognition not supported"));
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = lang;

  let finalText = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    if (onResult) onResult(finalText + interim, event.results[event.results.length - 1].isFinal);
  };

  recognition.onend = () => {
    if (onEnd) onEnd(finalText);
  };

  recognition.onerror = (event) => {
    if (onError) onError(event.error);
  };

  recognition.start();
  return recognition;
}

export function stopListening(recognition) {
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
}

/* --------------------------------------------------------------------------
   Wake-word listener ("Zazu, …")
   Continuous, self-restarting recognition. When a final transcript contains
   the wake word, the rest of the sentence is delivered as the command. If the
   wake word is spoken alone, the NEXT final utterance is taken as the command.
   Returns a handle with stop(); the caller owns the lifecycle.
   -------------------------------------------------------------------------- */
export function createWakeListener({ wakeWord = "zazu", onHeard, onInterim, onError } = {}) {
  if (!isSttSupported()) return null;

  let stopped = false;
  let rec = null;
  let awaitingCommand = false;

  function start() {
    if (stopped) return;
    rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (interimText && onInterim) onInterim(interimText);
      if (!finalText.trim()) return;

      const lower = finalText.toLowerCase();
      const idx = lower.indexOf(wakeWord.toLowerCase());

      if (idx === -1) {
        // No wake word — but if Zazu was addressed alone last time, this is the command
        if (awaitingCommand) {
          awaitingCommand = false;
          if (onInterim) onInterim("");
          if (onHeard) onHeard(finalText.trim());
        }
        return;
      }

      const after = finalText.slice(idx + wakeWord.length).replace(/^[\s,:.;—–-]+/, "");
      if (after.trim()) {
        if (onInterim) onInterim("");
        if (onHeard) onHeard(after.trim());
      } else {
        awaitingCommand = true;
        if (onInterim) onInterim("Zazu… waiting for your command");
      }
    };

    rec.onerror = (event) => {
      // "no-speech" and "aborted" are normal for a persistent listener
      if (event.error !== "no-speech" && event.error !== "aborted" && onError) {
        onError(event.error);
      }
    };

    rec.onend = () => {
      if (!stopped) setTimeout(start, 250); // keep listening
    };

    try {
      rec.start();
    } catch {
      // start() throws if already started — harmless
    }
  }

  start();

  return {
    stop() {
      stopped = true;
      if (rec) {
        try { rec.stop(); } catch { /* already stopped */ }
      }
    },
  };
}
