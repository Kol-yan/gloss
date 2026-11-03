import { isSingleLexicalWord } from "@/lib/pronunciation";

type VoiceDetails = Pick<SpeechSynthesisVoice, "lang" | "localService" | "default">;
type PronunciationState = {
  availability: "loading" | "ready" | "unavailable";
  voiceLanguage: string | null;
  microphoneActive: boolean;
  activeOwner: symbol | null;
  errorOwner: symbol | null;
};

const INITIAL: PronunciationState = {
  availability: "loading", voiceLanguage: null, microphoneActive: false, activeOwner: null, errorOwner: null,
};
let state = INITIAL;
let synth: SpeechSynthesis | null = null;
let voice: SpeechSynthesisVoice | null = null;
let connected = false;
let voiceTimer: ReturnType<typeof setTimeout> | null = null;
let loadingExpired = false;
let active: { owner: symbol; utterance: SpeechSynthesisUtterance } | null = null;
const listeners = new Set<() => void>();
const microphoneLocks = new Set<symbol>();

export function selectLocalEnglishVoice<T extends VoiceDetails>(voices: readonly T[]): T | null {
  const english = voices.filter((candidate) => candidate.localService === true && /^en(?:-|$)/i.test(candidate.lang));
  const american = english.filter((candidate) => /^en-US(?:-|$)/i.test(candidate.lang));
  return american.find((candidate) => candidate.default) ?? american[0]
    ?? english.find((candidate) => candidate.default)
    ?? english[0] ?? null;
}

function update(patch: Partial<PronunciationState>) {
  const next = { ...state, ...patch };
  if (next.availability === state.availability && next.microphoneActive === state.microphoneActive
      && next.voiceLanguage === state.voiceLanguage
      && next.activeOwner === state.activeOwner && next.errorOwner === state.errorOwner) return;
  state = next;
  for (const listener of listeners) listener();
}

function browserSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  const candidate = window.speechSynthesis;
  return candidate && typeof candidate.getVoices === "function" && typeof candidate.cancel === "function"
    && typeof candidate.speak === "function" ? candidate : null;
}

function refreshVoices() {
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    voice = null;
    update({ availability: "unavailable", voiceLanguage: null });
    return;
  }
  try {
    const available = synth.getVoices();
    voice = selectLocalEnglishVoice(available);
    if (voice) loadingExpired = false;
    update({ availability: voice ? "ready" : available.length === 0 && !loadingExpired ? "loading" : "unavailable", voiceLanguage: voice?.lang ?? null });
    if (state.availability === "loading" && voiceTimer === null) {
      voiceTimer = setTimeout(() => {
        voiceTimer = null;
        loadingExpired = true;
        refreshVoices();
      }, 2000);
    } else if (state.availability !== "loading" && voiceTimer !== null) {
      clearTimeout(voiceTimer);
      voiceTimer = null;
    }
  } catch {
    voice = null;
    update({ availability: "unavailable", voiceLanguage: null });
  }
}

function connect() {
  if (connected) return;
  synth = browserSynth();
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    update({ availability: "unavailable", voiceLanguage: null });
    return;
  }
  connected = true;
  loadingExpired = false;
  try {
    synth.addEventListener("voiceschanged", refreshVoices);
  } catch {
    connected = false;
    voice = null;
    update({ availability: "unavailable", voiceLanguage: null });
    return;
  }
  refreshVoices();
}

export function subscribePronunciation(listener: () => void) {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      synth?.removeEventListener("voiceschanged", refreshVoices);
      if (voiceTimer !== null) clearTimeout(voiceTimer);
      voiceTimer = null;
      connected = false;
    }
  };
}

export function getPronunciationState() {
  return state;
}

export function getServerPronunciationState() {
  return INITIAL;
}

function cancelCurrent() {
  active = null;
  update({ activeOwner: null, errorOwner: null });
  synth?.cancel();
}

export function stopOwnedPronunciation(owner: symbol) {
  if (active?.owner !== owner) return;
  try {
    cancelCurrent();
  } catch {
    update({ errorOwner: owner });
  }
}

// Called only by an explicit button press. Never let the browser choose a default voice.
export function pronounceWord(text: string, owner: symbol): boolean {
  if (!isSingleLexicalWord(text) || microphoneLocks.size > 0) return false;
  connect();
  refreshVoices();
  if (!synth || !voice || typeof SpeechSynthesisUtterance === "undefined") return false;
  try {
    cancelCurrent();
    const utterance = new SpeechSynthesisUtterance(text.trim());
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const playback = { owner, utterance };
    active = playback;
    update({ activeOwner: owner, errorOwner: null });
    utterance.onend = () => {
      if (active !== playback) return;
      active = null;
      update({ activeOwner: null });
    };
    utterance.onerror = () => {
      if (active !== playback) return;
      active = null;
      update({ activeOwner: null, errorOwner: owner });
    };
    synth.speak(utterance);
    return true;
  } catch {
    active = null;
    update({ activeOwner: null, errorOwner: owner });
    return false;
  }
}

// The recorder owns this lock from before getUserMedia until tracks are released.
export function blockPronunciationForMicrophone(): () => void {
  const lock = Symbol("microphone");
  microphoneLocks.add(lock);
  active = null;
  update({ microphoneActive: true, activeOwner: null, errorOwner: null });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    microphoneLocks.delete(lock);
    update({ microphoneActive: microphoneLocks.size > 0 });
  };
  try {
    // Cancel the whole queue before requesting the microphone, including pending speech.
    browserSynth()?.cancel();
  } catch {
    release();
    throw new Error("Device speech could not be stopped before recording.");
  }
  return release;
}
