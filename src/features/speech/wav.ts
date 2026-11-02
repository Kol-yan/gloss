// Converts a browser recording (WebM, MP4 or Ogg, depending on the browser)
// into the format the transcription endpoint accepts: RIFF/WAVE, mono, 16-bit
// PCM at 16 kHz.

export const WAV_SAMPLE_RATE = 16_000;
export const WAV_MAX_SECONDS = 60;

// Writes samples in [-1, 1] as a 16-bit PCM WAV file. Out-of-range values are clamped.
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = WAV_SAMPLE_RATE): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling is the PCM convention: -1 maps to -32768, +1 to 32767.
    view.setInt16(44 + i * bytesPerSample, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  }
  return buffer;
}

type AudioContextConstructor = typeof AudioContext;
type OfflineAudioContextConstructor = typeof OfflineAudioContext;

// Decodes the recording in the browser, resamples it to 16 kHz mono and wraps
// it as a WAV blob. Anything past 60 seconds is cut off. Throws when the
// browser cannot decode the recording.
export async function recordingToWav(recording: Blob): Promise<Blob> {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
    OfflineAudioContext?: OfflineAudioContextConstructor;
    webkitOfflineAudioContext?: OfflineAudioContextConstructor;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Context || !Offline) throw new Error("Web Audio is not available");

  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.max(1, Math.min(Math.ceil(decoded.duration * WAV_SAMPLE_RATE), WAV_MAX_SECONDS * WAV_SAMPLE_RATE));
    // One channel at 16 kHz: connecting a stereo source down-mixes it.
    const offline = new Offline(1, frames, WAV_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWavPcm16(rendered.getChannelData(0), WAV_SAMPLE_RATE)], { type: "audio/wav" });
  } finally {
    void context.close();
  }
}
