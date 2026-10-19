import { describe, expect, test } from "vitest";
import { crc16 } from "../src/dsp/crc";
import { decodeFrame, encodeFrame } from "../src/dsp/frame";

describe("crc16", () => {
  test("check value for 123456789", () => {
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });
});

describe("frame codec", () => {
  test("roundtrip preserves seq and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 42]);
    const bytes = encodeFrame(7, payload);
    expect(decodeFrame(bytes)).toEqual({ seq: 7, payload });
  });

  test("corrupted payload decodes to null", () => {
    const bytes = encodeFrame(1, new Uint8Array([10, 20, 30]));
    bytes[4] = bytes[4]! ^ 0xff; // first payload byte
    expect(decodeFrame(bytes)).toBeNull();
  });

  test("payload over 64 bytes throws", () => {
    expect(() => encodeFrame(1, new Uint8Array(65))).toThrow(RangeError);
  });

  test("zero-length payload roundtrips", () => {
    const bytes = encodeFrame(3, new Uint8Array(0));
    expect(decodeFrame(bytes)).toEqual({ seq: 3, payload: new Uint8Array(0) });
  });

  test("sync mismatch decodes to null", () => {
    const bytes = encodeFrame(1, new Uint8Array([5]));
    bytes[0] = 0x00;
    expect(decodeFrame(bytes)).toBeNull();
  });
});
