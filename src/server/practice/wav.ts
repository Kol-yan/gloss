// Validation of the WAV files accepted for speech-to-text. The header is
// parsed here so a bad file is rejected before any budget is reserved, and the
// bytes that are sent to the provider are rebuilt from what was validated: a
// fresh 44-byte header plus exactly the PCM samples that were measured. What
// the provider transcribes is therefore what was reserved and billed, however
// the upload was crafted (trailing chunks, a second data chunk, odd sizes).
export const MAX_WAV_BYTES = 3 * 1024 * 1024;
export const MIN_AUDIO_SECONDS = 0.5;
export const MAX_AUDIO_SECONDS = 60;
export const ALLOWED_SAMPLE_RATES = [16_000, 24_000];

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

export interface WavInfo {
  sampleRate: number;
  seconds: number;
  // Size of the upload, not of the canonical file.
  bytes: number;
  // RIFF/WAVE, mono, 16-bit PCM: only the validated samples. Send this, never the upload.
  canonical: Uint8Array;
}

export class InvalidWavError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid WAV: ${reason}`);
    this.name = "InvalidWavError";
  }
}

// Accepts RIFF/WAVE, PCM (format 1), mono, 16-bit, 16 or 24 kHz, 0.5 to 60
// seconds, at most 3 MB, with one fmt chunk and one data chunk that is the
// last thing in the file (one padding byte allowed). Throws InvalidWavError
// otherwise.
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new InvalidWavError("too_large");
  if (bytes.byteLength < HEADER_BYTES) throw new InvalidWavError("too_short");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new InvalidWavError("not_wav");

  let sampleRate: number | null = null;
  let dataStart: number | null = null;
  let dataBytes = 0;
  let offset = 12;
  // A real header has two or three chunks; bound the walk anyway.
  for (let chunks = 0; chunks < 16 && offset + 8 <= bytes.byteLength; chunks++) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      if (sampleRate !== null) throw new InvalidWavError("multiple_fmt");
      if (size < 16 || body + 16 > bytes.byteLength) throw new InvalidWavError("bad_fmt");
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1) throw new InvalidWavError("not_pcm");
      if (channels !== 1) throw new InvalidWavError("not_mono");
      if (bitsPerSample !== 16) throw new InvalidWavError("not_16_bit");
      if (!ALLOWED_SAMPLE_RATES.includes(rate)) throw new InvalidWavError("bad_sample_rate");
      sampleRate = rate;
    } else if (id === "data") {
      if (sampleRate === null) throw new InvalidWavError("no_fmt");
      // Streaming encoders may leave a placeholder size larger than the file;
      // the samples that are really there are what counts.
      dataStart = body;
      dataBytes = Math.min(size, bytes.byteLength - body);
      // Nothing may follow the samples except one padding byte. That rules out
      // a second data chunk and any trailing audio or metadata.
      const trailing = bytes.byteLength - (body + dataBytes);
      if (trailing > 1) {
        const second = trailing >= 8 && tag(body + dataBytes) === "data";
        throw new InvalidWavError(second ? "multiple_data" : "trailing_bytes");
      }
      break;
    }
    offset = body + size + (size % 2);
  }

  if (sampleRate === null) throw new InvalidWavError("no_fmt");
  if (dataStart === null) throw new InvalidWavError("no_data");

  const samples = Math.floor(dataBytes / BYTES_PER_SAMPLE);
  const seconds = samples / sampleRate;
  if (seconds < MIN_AUDIO_SECONDS) throw new InvalidWavError("too_short");
  if (seconds > MAX_AUDIO_SECONDS) throw new InvalidWavError("too_long");

  const pcm = bytes.subarray(dataStart, dataStart + samples * BYTES_PER_SAMPLE);
  return { sampleRate, seconds, bytes: bytes.byteLength, canonical: buildCanonicalWav(pcm, sampleRate) };
}

function buildCanonicalWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}
