// Validation of the WAV files accepted for speech-to-text. The header is
// parsed here so a bad file is rejected before any budget is reserved.
export const MAX_WAV_BYTES = 3 * 1024 * 1024;
export const MIN_AUDIO_SECONDS = 0.5;
export const MAX_AUDIO_SECONDS = 60;
export const ALLOWED_SAMPLE_RATES = [16_000, 24_000];

export interface WavInfo {
  sampleRate: number;
  seconds: number;
  bytes: number;
}

export class InvalidWavError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid WAV: ${reason}`);
    this.name = "InvalidWavError";
  }
}

// Accepts RIFF/WAVE, PCM (format 1), mono, 16-bit, 16 or 24 kHz, 0.5 to 60
// seconds, at most 3 MB. Throws InvalidWavError otherwise.
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new InvalidWavError("too_large");
  if (bytes.byteLength < 44) throw new InvalidWavError("too_short");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new InvalidWavError("not_wav");

  let format: { sampleRate: number } | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  // A real header has two or three chunks; bound the walk anyway.
  for (let chunks = 0; chunks < 16 && offset + 8 <= bytes.byteLength; chunks++) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new InvalidWavError("bad_fmt");
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1) throw new InvalidWavError("not_pcm");
      if (channels !== 1) throw new InvalidWavError("not_mono");
      if (bitsPerSample !== 16) throw new InvalidWavError("not_16_bit");
      if (!ALLOWED_SAMPLE_RATES.includes(sampleRate)) throw new InvalidWavError("bad_sample_rate");
      format = { sampleRate };
    } else if (id === "data") {
      // Streaming encoders may leave a placeholder size; trust the bytes that are there.
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!format) throw new InvalidWavError("no_fmt");
  if (dataBytes === null) throw new InvalidWavError("no_data");

  const seconds = Math.floor(dataBytes / 2) / format.sampleRate;
  if (seconds < MIN_AUDIO_SECONDS) throw new InvalidWavError("too_short");
  if (seconds > MAX_AUDIO_SECONDS) throw new InvalidWavError("too_long");
  return { sampleRate: format.sampleRate, seconds, bytes: bytes.byteLength };
}
