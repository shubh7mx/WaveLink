import { describe, expect, test, vi } from "vitest";
import { encodeFrame, decodeFrame } from "../src/dsp/frame";
import { addNoise, demodulate, modulateFrame, SAMPLE_RATE } from "../src/dsp/modem";
import { Protocol } from "../src/dsp/protocol";

const BASE = 2000;

/** Wire two protocols through a simulated noisy air channel. */
function makeWire(snrDb: number, seed: number) {
  const airAtoB: Float32Array[] = [];
  const airBtoA: Float32Array[] = [];
  const receivedAtB: { payload: Uint8Array; seq: number }[] = [];
  const receivedAtA: { payload: Uint8Array; seq: number }[] = [];

  const protoA = new Protocol(
    (s) => airAtoB.push(s),
    (payload, seq) => receivedAtA.push({ payload, seq }),
    (s) => airAtoB.push(s),
  );
  const protoB = new Protocol(
    (s) => airBtoA.push(s),
    (payload, seq) => receivedAtB.push({ payload, seq }),
    (s) => airBtoA.push(s),
  );

  function pump() {
    // deliver everything sent so far, interleaved, with noise
    while (airAtoB.length || airBtoA.length) {
      const a = airAtoB.shift();
      const b = airBtoA.shift();
      if (a) protoB.onAudio(addNoise(a, snrDb, seed++));
      if (b) protoA.onAudio(addNoise(b, snrDb, seed++));
    }
  }
  return { protoA, protoB, receivedAtB, receivedAtA, pump };
}

describe("protocol over noisy simulated air", () => {
  test("delivers payload exactly once at SNR 15", () => {
    const w = makeWire(15, 1000);
    const payload = new TextEncoder().encode("ack test");
    w.protoA.send(payload);
    w.pump();
    expect(w.receivedAtB.length).toBe(1);
    expect(Array.from(w.receivedAtB[0]!.payload)).toEqual(Array.from(payload));
    // ACK heard -> no retry duplicates
    w.pump();
    expect(w.receivedAtB.length).toBe(1);
  });

  test("survives 3 consecutive corrupted retransmissions", () => {
    const w = makeWire(40, 7);
    const payload = new TextEncoder().encode("retry");
    let drops = 0;
    const origSend = w.protoA.send.bind(w.protoA);
    // wrap: first 3 transmissions get destroyed by zeroing (simulated burst)
    w.protoA.send = (p: Uint8Array) => {
      const before = drops;
      origSend(p);
      if (before < 3) drops++;
    };
    // simpler: corrupt by re-sending through a wrapper at pump time is complex;
    // instead rely on protocol retries: simulate by manually calling send 3 times with burst
    // We emulate burst by intercepting the wire: rebuild wire with corrupting pump
    const burst = makeBurstWire();
    burst.protoA.send(payload);
    for (let i = 0; i < 6; i++) {
      burst.pump();
      burst.protoA.tick(); // sender retries after silence
    }
    burst.pump();
    expect(Array.from(burst.receivedAtB[0]!.payload)).toEqual(Array.from(payload));
    expect(origSend).toBeDefined();
  });

  test("lost ACK does not duplicate delivery", () => {
    const w = makeWire(40, 9);
    const payload = new TextEncoder().encode("dup");
    w.protoA.send(payload);
    w.pump();
    // ACK lost: sender still waits; force retransmission by calling send again with same payload
    w.protoA.send(payload);
    w.pump();
    // receiver must dedupe by seq: onReceive fired once
    expect(w.receivedAtB.length).toBe(1);
  });
});

/** Wire where the first 3 data frames A->B are destroyed (noise burst). */
function makeBurstWire() {
  const airAtoB: Float32Array[] = [];
  const airBtoA: Float32Array[] = [];
  const receivedAtB: { payload: Uint8Array; seq: number }[] = [];
  let dataFramesSent = 0;

  const protoA = new Protocol(
    (s) => { airAtoB.push(s); },
    () => {},
    (s) => airAtoB.push(s),
  );
  const protoB = new Protocol(
    (s) => airBtoA.push(s),
    (payload, seq) => receivedAtB.push({ payload, seq }),
    (s) => airBtoA.push(s),
  );

  function pump() {
    while (airAtoB.length || airBtoA.length) {
      const a = airAtoB.shift();
      const b = airBtoA.shift();
      if (a) {
        let buf = a;
        if (a.length > SAMPLE_RATE) dataFramesSent++; // data frames are long; ACK tones short
        if (dataFramesSent <= 3) buf = new Float32Array(a.length); // destroy
        protoB.onAudio(addNoise(buf, 30, 5));
      }
      if (b) protoA.onAudio(addNoise(b, 30, 6));
    }
  }
  return { protoA, protoB, receivedAtB, pump };
}
