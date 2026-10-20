import { describe, expect, test } from "vitest";
import { AudioLink, MIC_CONSTRAINTS } from "../src/audio/link";
import { Protocol } from "../src/dsp/protocol";
import { modulateFrame } from "../src/dsp/modem";

describe("AudioLink", () => {
  test("mic constraints disable all OS processing", () => {
    expect(MIC_CONSTRAINTS).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  test("constructs at 48 kHz context", () => {
    const link = new AudioLink(18500);
    expect(link.sampleRate).toBe(48000);
  });

  test("send schedules modulated buffer", () => {
    const played: Float32Array[] = [];
    const link = new AudioLink(2000, { play: (b) => played.push(b) });
    link.send(new TextEncoder().encode("hi"));
    expect(played.length).toBe(1);
    expect(played[0]!.length).toBeGreaterThan(0);
  });
});
