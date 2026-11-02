import { describe, expect, it } from "vitest";
import { encodeWavPcm16 } from "@/features/speech/wav";

function text(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
}

describe("encodeWavPcm16", () => {
  it("writes a mono 16-bit PCM RIFF header at 16 kHz", () => {
    const wav = encodeWavPcm16(new Float32Array(1600), 16_000);
    const view = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 1600 * 2);
    expect(text(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 3200);
    expect(text(view, 8, 4)).toBe("WAVE");
    expect(text(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(3200);
  });

  it("scales and clamps samples", () => {
    const view = new DataView(encodeWavPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2])));
    const sample = (i: number) => view.getInt16(44 + i * 2, true);
    expect(sample(0)).toBe(0);
    expect(sample(1)).toBe(32767);
    expect(sample(2)).toBe(-32768);
    expect(sample(3)).toBe(16384);
    expect(sample(4)).toBe(32767);
    expect(sample(5)).toBe(-32768);
  });

  it("handles an empty recording", () => {
    const wav = encodeWavPcm16(new Float32Array(0));
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav).getUint32(40, true)).toBe(0);
  });
});
