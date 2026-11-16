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

/* --------------------------------------------------------------------------
   Polish language routing — Kokoro's voices are English-locked, so Polish
   text spoken through it reads like English gibberish. Detect Polish and
   let callers fall through to a browser voice (utterance.lang = pl-PL) so
   Windows picks a Polish voice when one is installed (e.g. Microsoft Paulina).
   -------------------------------------------------------------------------- */
const POLISH_LETTERS_RE = new RegExp("[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c]", "i");
// Words compared AFTER stripping non a-z characters (diacritics removed):
// się->"si", dzień->"dzen", cześć->"czesc", dziękuję->"dziekuj", etc.
const POLISH_COMMON_WORDS = new Set([
  "nie", "jest", "jestem", "jestes", "jestesmy", "si", "jak", "czy", "ale",
  "dla", "tak", "tylko", "bardzo", "dobrze", "dobry", "dzen", "czesc",
  "dziekuj", "prosze", "ktory", "ktora", "byc", "przez", "mnie", "ciebie",
  "tego", "tym", "wszystko", "tez", "mozna", "bedzie", "sie", "nazywam",
]);

export function looksPolish(text) {
  const s = String(text);
  if (POLISH_LETTERS_RE.test(s)) return true;
  const words = s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const w of words) {
    if (POLISH_COMMON_WORDS.has(w)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// Best available browser voice for Polish (or null to let the engine guess).
function pickPolishVoice() {
  const voices = synth.getVoices() || [];
  return voices.find((v) => (v.lang || "").toLowerCase().startsWith("pl")) || null;
}

// A browser voice can only pronounce one language well, so split the text
// into consecutive same-language runs (per sentence) and switch voices
// between them: Polish sentences go to the pl-PL voice, English sentences
// to the selected/default English voice. speechSynthesis queues utterances,
// so they play back seamlessly.
export function splitByLanguage(text) {
  const parts = text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const runs = [];
  for (const part of parts) {
    const polish = looksPolish(part);
    const last = runs[runs.length - 1];
    if (last && last.polish === polish) last.text += " " + part;
    else runs.push({ polish, text: part });
  }
  return runs.length ? runs : [{ polish: false, text }];
}

export function speak(text, { rate = 1, pitch = 1, voicePref = null } = {}) {
  stop();
  if (!isTtsSupported()) return null;
  synth = window.speechSynthesis;

  // Trigger voice list load on some browsers (voices may be empty at first).
  if (!synth.getVoices().length) {
    try { synth.onvoiceschanged = () => {}; } catch {}
  }

  const runs = splitByLanguage(String(text).trim());
  // Returned handle: callers attach handle.onend — it fires when the final
  // segment finishes. Keeps the old utterance.onend = fn call sites working.
  const handle = { onend: null, segments: [] };
  let done = false;
  const finishOnce = () => { if (!done) { done = true; if (typeof handle.onend === "function") handle.onend(); } };

  runs.forEach((run, i) => {
    const seg = new SpeechSynthesisUtterance(run.text);
    seg.rate = rate;
    seg.pitch = pitch;
    if (run.polish) {
      // Prefer an installed Polish voice and tag the language so diacritics
      // and consonant clusters are pronounced properly.
      const polishVoice = voicePref ? null : pickPolishVoice();
      if (polishVoice) seg.voice = polishVoice;
      seg.lang = polishVoice?.lang || "pl-PL";
    } else if (voicePref) {
      const v = synth.getVoices().find((x) => x.name === voicePref || x.lang === voicePref);
      if (v) seg.voice = v;
    }
    if (i === runs.length - 1) {
      seg.onend = finishOnce;
      seg.onerror = finishOnce;
    }
    synth.speak(seg);
    handle.segments.push(seg);
  });
  utterance = handle;
  return handle;
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
