import { describe, expect, test } from "vitest";
import { encodeFrame } from "../src/dsp/frame";
import { addNoise, demodulate, modulateFrame } from "../src/dsp/modem";

const BASE = 2000; // audible tier: fast tests, no ultrasonic edge
const frame = encodeFrame(1, new TextEncoder().encode("hello wavellink"));

describe("modem", () => {
  test("modulate-demodulate roundtrip at SNR 20 dB", () => {
    const samples = modulateFrame(frame, BASE);
    const noisy = addNoise(samples, 20, 42);
    const out = demodulate(noisy, BASE);
    expect(out.length).toBe(1);
    expect(Array.from(out[0]!)).toEqual(Array.from(frame));
  });

  test("still decodes at SNR 5 dB", () => {
    const samples = modulateFrame(frame, BASE);
    const out = demodulate(addNoise(samples, 5, 7), BASE);
    expect(out.length).toBe(1);
    expect(Array.from(out[0]!)).toEqual(Array.from(frame));
  });

  test("deterministic with fixed seed", () => {
    const samples = modulateFrame(frame, BASE);
    const a = demodulate(addNoise(samples, 10, 123), BASE);
    const b = demodulate(addNoise(samples, 10, 123), BASE);
    expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!));
  });
});
