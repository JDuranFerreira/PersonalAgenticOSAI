/* ==========================================================================
   Agentic OS — Text to Speech (Milestone 1: agent reads replies aloud)
   Uses the Web Speech API (window.speechSynthesis). Falls back gracefully
   when synthesis is not available.
 ========================================================================== */

let synth = null;
let utterance = null;

export function isTtsSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text, { rate = 1, pitch = 1, voicePref = null } = {}) {
  stop();
  if (!isTtsSupported()) return null;
  synth = window.speechSynthesis;
  utterance = new SpeechSynthesisUtterance(String(text));
  utterance.rate = rate;
  utterance.pitch = pitch;
  if (voicePref) {
    const voices = synth.getVoices();
    const v = voices.find((x) => x.name === voicePref || x.lang === voicePref);
    if (v) utterance.voice = v;
  }
  synth.speak(utterance);
  return utterance;
}

export function stopTts() {
  if (synth) {
    try { synth.cancel(); } catch {}
  }
  utterance = null;
  // Also stop any Kokoro playback
  if (kokoroAudio) {
    try { kokoroAudio.pause(); } catch {}
    kokoroAudio = null;
  }
  if (kokoroUrl) {
    URL.revokeObjectURL(kokoroUrl);
    kokoroUrl = null;
  }
}

export function isSpeaking() {
  return synth ? synth.speaking : false;
}

export function getVoices() {
  if (!isTtsSupported()) return [];
  return window.speechSynthesis.getVoices();
}

/* --------------------------------------------------------------------------
   Kokoro — Zazu's local voice (bm_george, brisk 1.15 speed, unlimited).
   Runs on the local voice service (port 8765) proxied through the model
   proxy server (/api/voice/*) since the browser can't call it cross-origin.
   Falls back gracefully — callers should use browser TTS when these fail.
   -------------------------------------------------------------------------- */
const PROXY_TTS = "http://127.0.0.1:5175";

let kokoroOk = null; // tri-state cache: null = unknown

export async function kokoroHealth() {
  try {
    const res = await fetch(`${PROXY_TTS}/api/voice/health`);
    const data = await res.json();
    kokoroOk = Boolean(data.ok);
    return data;
  } catch {
    kokoroOk = false;
    return { ok: false };
  }
}

export function kokoroStatusKnown() {
  return kokoroOk !== null;
}

let kokoroAudio = null;
let kokoroUrl = null;

// Speaks via Kokoro and resolves to a stop() handle, or rejects if the
// service is unavailable. playbackRate nudges delivery closer to the
// reference config's 1.15 speed without re-synthesizing.
export async function speakKokoro(text, { onend } = {}) {
  const res = await fetch(`${PROXY_TTS}/api/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    kokoroOk = false;
    throw new Error(`Kokoro unavailable (${res.status})`);
  }
  kokoroOk = true;
  const blob = await res.blob();
  if (kokoroUrl) URL.revokeObjectURL(kokoroUrl);
  kokoroUrl = URL.createObjectURL(blob);
  if (kokoroAudio) {
    try { kokoroAudio.pause(); } catch { /* already stopped */ }
  }
  kokoroAudio = new Audio(kokoroUrl);
  kokoroAudio.playbackRate = 1.15; // voice.yaml: speed 1.15 — clipped, brisk
  kokoroAudio.onended = () => { if (onend) onend(); };
  await kokoroAudio.play();
  return {
    stop() {
      if (kokoroAudio) {
        try { kokoroAudio.pause(); } catch { /* already stopped */ }
        kokoroAudio = null;
      }
      if (kokoroUrl) {
        URL.revokeObjectURL(kokoroUrl);
        kokoroUrl = null;
      }
    },
  };
}
