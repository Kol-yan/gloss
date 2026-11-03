import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function voice(lang: string, localService: boolean, isDefault = false): SpeechSynthesisVoice {
  return { lang, localService, default: isDefault, name: lang, voiceURI: lang } as SpeechSynthesisVoice;
}

class TestUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

class TestSynth extends EventTarget {
  voices = [voice("en-US", true)];
  current: TestUtterance | null = null;
  getVoices = vi.fn(() => this.voices);
  speak = vi.fn((utterance: TestUtterance) => { this.current = utterance; });
  cancel = vi.fn(() => {
    const previous = this.current;
    this.current = null;
    previous?.onerror?.();
  });
}

class TestRecorder {
  static latest: TestRecorder | null;
  static failStart = false;
  static isTypeSupported = vi.fn(() => true);
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { TestRecorder.latest = this; }
  start() {
    if (TestRecorder.failStart) throw new Error("Device unavailable");
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded audio"]) });
    this.onstop?.();
  }
}

let synth: TestSynth;
let track: { stop: ReturnType<typeof vi.fn> };
let stream: MediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  synth = new TestSynth();
  track = { stop: vi.fn() };
  stream = { getTracks: () => [track] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
  vi.stubGlobal("MediaRecorder", TestRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  TestRecorder.latest = null;
  TestRecorder.failStart = false;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local pronunciation playback", () => {
  it("selects English local voices and rejects remote/default or non-English voices", async () => {
    const { selectLocalEnglishVoice } = await import("@/features/speech/pronunciation");
    const local = voice("en-US", true);
    expect(selectLocalEnglishVoice([voice("en-US", false, true), voice("fr-FR", true, true), local])).toBe(local);
    expect(selectLocalEnglishVoice([voice("enochian", true), voice("en-GB", false)])).toBeNull();
    expect(selectLocalEnglishVoice([voice("en-GB", true, true), local])?.lang).toBe("en-US");
    expect(selectLocalEnglishVoice([voice("en-AU", true), voice("en-GB", true, true)])?.lang).toBe("en-GB");
  });

  it("assigns the chosen local voice and language before speaking and never reads a network voice", async () => {
    synth.voices = [voice("en-US", false, true), voice("en-GB", true)];
    const playback = await import("@/features/speech/pronunciation");
    expect(playback.pronounceWord("resilient", Symbol("word"))).toBe(true);
    const utterance = synth.speak.mock.calls[0][0];
    expect(utterance).toMatchObject({ text: "resilient", lang: "en-GB", voice: synth.voices[1] });
    expect(playback.getPronunciationState().voiceLanguage).toBe("en-GB");
    expect(playback.pronounceWord("push back", Symbol("phrase"))).toBe(false);
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable instead of falling back to a remote or foreign voice", async () => {
    synth.voices = [voice("en-US", false), voice("de-DE", true)];
    const playback = await import("@/features/speech/pronunciation");
    const unsubscribe = playback.subscribePronunciation(() => undefined);
    expect(playback.getPronunciationState().availability).toBe("unavailable");
    expect(playback.pronounceWord("resilient", Symbol("word"))).toBe(false);
    expect(synth.speak).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("bounds the empty voice-loading state and responds when local voices arrive", async () => {
    synth.voices = [];
    const playback = await import("@/features/speech/pronunciation");
    const unsubscribe = playback.subscribePronunciation(() => undefined);
    expect(playback.getPronunciationState().availability).toBe("loading");
    vi.advanceTimersByTime(2000);
    expect(playback.getPronunciationState().availability).toBe("unavailable");
    synth.voices = [voice("en-US", true)];
    synth.dispatchEvent(new Event("voiceschanged"));
    expect(playback.getPronunciationState().availability).toBe("ready");
    unsubscribe();
  });

  it("does not let an older component cleanup or callback stop a newer pronunciation", async () => {
    const playback = await import("@/features/speech/pronunciation");
    const first = Symbol("first");
    const second = Symbol("second");
    playback.pronounceWord("resilient", first);
    const oldUtterance = synth.current;
    playback.pronounceWord("patient", second);
    const cancels = synth.cancel.mock.calls.length;
    playback.stopOwnedPronunciation(first);
    oldUtterance?.onend?.();
    expect(synth.cancel).toHaveBeenCalledTimes(cancels);
    expect(playback.getPronunciationState().activeOwner).toBe(second);
    playback.stopOwnedPronunciation(second);
    expect(synth.cancel).toHaveBeenCalledTimes(cancels + 1);
    expect(playback.getPronunciationState().activeOwner).toBeNull();
  });

  it("reports a playback error and allows an explicit retry", async () => {
    const playback = await import("@/features/speech/pronunciation");
    const owner = Symbol("word");
    playback.pronounceWord("resilient", owner);
    synth.current?.onerror?.();
    expect(playback.getPronunciationState()).toMatchObject({ activeOwner: null, errorOwner: owner });
    expect(playback.pronounceWord("resilient", owner)).toBe(true);
    expect(playback.getPronunciationState()).toMatchObject({ activeOwner: owner, errorOwner: null });
  });
});

describe("pronunciation and microphone boundary", () => {
  it("cancels speech before requesting the microphone and blocks playback until tracks are released", async () => {
    const events: string[] = [];
    synth.cancel.mockImplementation(() => { events.push("cancel speech"); });
    getUserMedia.mockImplementation(async () => { events.push("request microphone"); return stream; });
    const playback = await import("@/features/speech/pronunciation");
    const { startRecording } = await import("@/features/speech/recorder");
    const result = await startRecording();
    expect(events).toEqual(["cancel speech", "request microphone"]);
    expect(playback.getPronunciationState().microphoneActive).toBe(true);
    expect(playback.pronounceWord("resilient", Symbol("word"))).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect((await result.session.stop()).blob.size).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalled();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    expect(playback.pronounceWord("resilient", Symbol("word"))).toBe(true);
  });

  it("unblocks on cancelled permission requests and releases a stream that arrives later", async () => {
    let resolveMedia: (stream: MediaStream) => void = () => undefined;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => { resolveMedia = resolve; }));
    const playback = await import("@/features/speech/pronunciation");
    const { startRecording } = await import("@/features/speech/recorder");
    const controller = new AbortController();
    const pending = startRecording(controller.signal);
    expect(playback.getPronunciationState().microphoneActive).toBe(true);
    controller.abort();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    resolveMedia(stream);
    expect((await pending).ok).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    expect(TestRecorder.latest).toBeNull();
  });

  it("unblocks on permission denial, recorder startup failure, cancellation and runtime error", async () => {
    const playback = await import("@/features/speech/pronunciation");
    const { startRecording } = await import("@/features/speech/recorder");
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    expect((await startRecording()).ok).toBe(false);
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    TestRecorder.failStart = true;
    expect((await startRecording()).ok).toBe(false);
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    TestRecorder.failStart = false;
    const cancelled = await startRecording();
    if (cancelled.ok) cancelled.session.cancel();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    const failed = await startRecording();
    TestRecorder.latest?.onerror?.();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
    if (failed.ok) expect((await failed.session.stop()).blob.size).toBe(0);
  });

  it("keeps playback blocked until every microphone owner has released its lock", async () => {
    const playback = await import("@/features/speech/pronunciation");
    const first = playback.blockPronunciationForMicrophone();
    const second = playback.blockPronunciationForMicrophone();
    first();
    first();
    expect(playback.getPronunciationState().microphoneActive).toBe(true);
    second();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
  });

  it("does not request a microphone when device speech cannot be cancelled", async () => {
    synth.cancel.mockImplementation(() => { throw new Error("Device failure"); });
    const playback = await import("@/features/speech/pronunciation");
    const { startRecording } = await import("@/features/speech/recorder");
    expect((await startRecording()).ok).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(playback.getPronunciationState().microphoneActive).toBe(false);
  });
});
