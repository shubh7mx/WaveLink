import { describe, expect, test } from "vitest";
import { encodeFrame } from "../src/dsp/frame";
import { addNoise, demodulate, modulateFrame } from "../src/dsp/modem";

const BASE = 2000;
const frame = encodeFrame(1, new TextEncoder().encode("hello wavellink"));

describe("modem", () => {
  test("modulate-demodulate roundtrip at SNR 20 dB", () => {
    const samples = modulateFrame(frame, BASE);
    const { frames } = demodulate(addNoise(samples, 20, 42), BASE);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!)).toEqual(Array.from(frame));
  });

  test("still decodes at SNR 5 dB", () => {
    const samples = modulateFrame(frame, BASE);
    const { frames } = demodulate(addNoise(samples, 5, 7), BASE);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!)).toEqual(Array.from(frame));
  });

  test("deterministic with fixed seed", () => {
    const samples = modulateFrame(frame, BASE);
    const a = demodulate(addNoise(samples, 10, 123), BASE);
    const b = demodulate(addNoise(samples, 10, 123), BASE);
    expect(Array.from(a.frames[0]!)).toEqual(Array.from(b.frames[0]!));
  });

  test("streams across chunk boundaries", () => {
    const samples = modulateFrame(frame, BASE);
    const noisy = addNoise(samples, 20, 42);
    // feed in odd 4096-sample chunks like ScriptProcessor does
    const got: Uint8Array[] = [];
    let rest = new Float32Array(0);
    const state = { scanned: 0, lock: -1 };
    for (let off = 0; off < noisy.length; off += 4096) {
      const chunk = noisy.subarray(off, Math.min(off + 4096, noisy.length));
      const merged = new Float32Array(rest.length + chunk.length);
      merged.set(rest);
      merged.set(chunk, rest.length);
      const { frames, consumed } = demodulate(merged, BASE, state);
      got.push(...frames);
      rest = merged.subarray(consumed);
      state.scanned = Math.max(0, state.scanned - consumed);
      state.lock = state.lock < 0 ? -1 : Math.max(0, state.lock - consumed);
    }
    expect(got.length).toBe(1);
    expect(Array.from(got[0]!)).toEqual(Array.from(frame));
  });
});
