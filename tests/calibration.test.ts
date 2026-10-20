import { describe, expect, test } from "vitest";
import { pickTierFromResponses } from "../src/audio/calibration";

describe("band selection", () => {
  const TIERS = [18500, 14500, 2000];

  test("strong 18.5 kHz response picks ultrasonic tier", () => {
    expect(pickTierFromResponses(TIERS, { 18500: 0.8, 14500: 0.3, 2000: 0.9 })).toBe(18500);
  });

  test("weak ultrasonic but strong near-audible picks 14500", () => {
    expect(pickTierFromResponses(TIERS, { 18500: 0.05, 14500: 0.5, 2000: 0.9 })).toBe(14500);
  });

  test("all weak falls back to audible 2000", () => {
    expect(pickTierFromResponses(TIERS, { 18500: 0.02, 14500: 0.03, 2000: 0.09 })).toBe(2000);
  });

  test("all-zero response never throws and returns 2000", () => {
    expect(() => pickTierFromResponses(TIERS, { 18500: 0, 14500: 0, 2000: 0 })).not.toThrow();
    expect(pickTierFromResponses(TIERS, { 18500: 0, 14500: 0, 2000: 0 })).toBe(2000);
  });
});
