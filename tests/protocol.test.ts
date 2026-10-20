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
    undefined,
    true, // enable ARQ for wire tests
  );
  const protoB = new Protocol(
    (s) => airBtoA.push(s),
    (payload, seq) => receivedAtB.push({ payload, seq }),
    (s) => airBtoA.push(s),
    undefined,
    true, // enable ARQ for wire tests
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
    // Wire where B->A (ACKs) are destroyed: sender never hears ACK and retries.
    const airAtoB: Float32Array[] = [];
    const airBtoA: Float32Array[] = [];
    const receivedAtB: { payload: Uint8Array; seq: number }[] = [];
    const protoA = new Protocol((s) => airAtoB.push(s), () => {}, (s) => airAtoB.push(s), undefined, true);
    const protoB = new Protocol(
      (s) => airBtoA.push(s),
      (payload, seq) => receivedAtB.push({ payload, seq }),
      (s) => airBtoA.push(s),
      undefined,
      true,
    );
    const payload = new TextEncoder().encode("dup");
    protoA.send(payload);
    // round 1: frame delivered, ACK destroyed
    protoB.onAudio(addNoise(airAtoB.shift()!, 30, 11));
    protoA.onAudio(new Float32Array(4800)); // "ACK" lost
    // round 2: sender retries same frame (same seq)
    protoA.tick();
    protoB.onAudio(addNoise(airAtoB.shift()!, 30, 12));
    expect(receivedAtB.length).toBe(1); // deduped by seq
  });

  test("sender ignores its own transmitted frame (echo suppression)", () => {
    const air: Float32Array[] = [];
    const receivedSelf: { payload: Uint8Array; seq: number }[] = [];
    const acksEmitted: Float32Array[] = [];

    const proto = new Protocol(
      (s) => air.push(s),
      (payload, seq) => receivedSelf.push({ payload, seq }),
      (s) => acksEmitted.push(s),
      undefined,
      false, // waitForAck
      true,  // suppressEcho
    );

    const payload = new TextEncoder().encode("self test");
    proto.send(payload);
    expect(air.length).toBe(1);

    // Feed sender's own audio directly back into sender's onAudio (acoustic loopback)
    proto.onAudio(air[0]!);

    // Must NOT decode on self or emit ACK to self
    expect(receivedSelf.length).toBe(0);
    expect(acksEmitted.length).toBe(0);
  });

  test("direct transmit without ACK (simplex mode) sends immediately without waiting for ACK", () => {
    const air: Float32Array[] = [];
    const received: { payload: Uint8Array; seq: number }[] = [];

    const tx = new Protocol((s) => air.push(s), () => {});
    const rx = new Protocol(() => {}, (payload, seq) => received.push({ payload, seq }));

    // Send first message
    tx.send(new TextEncoder().encode("msg 1"));
    expect(air.length).toBe(1);
    expect(tx.busy).toBe(false); // sender is not blocked waiting for ACK

    // Send second message immediately
    tx.send(new TextEncoder().encode("msg 2"));
    expect(air.length).toBe(2);

    // Receiver decodes both messages
    rx.onAudio(air[0]!);
    rx.onAudio(air[1]!);

    expect(received.length).toBe(2);
    expect(new TextDecoder().decode(received[0]!.payload)).toBe("msg 1");
    expect(new TextDecoder().decode(received[1]!.payload)).toBe("msg 2");
  });

  test("survives 3+ consecutive streaming chunked transmissions without hanging", () => {
    const received: string[] = [];
    const air: Float32Array[] = [];
    const tx = new Protocol((s) => air.push(s), () => {});
    const rx = new Protocol(() => {}, (payload) => {
      received.push(new TextDecoder().decode(payload));
    });

    for (let m = 1; m <= 3; m++) {
      tx.send(new TextEncoder().encode(`test ${m}`));
      const frameAudio = air.shift()!;
      // Add trailing silence/ambient audio
      const fullAudio = new Float32Array(frameAudio.length + 8192);
      fullAudio.set(frameAudio);
      // Stream in 4096-sample chunks like ScriptProcessor
      for (let i = 0; i < fullAudio.length; i += 4096) {
        rx.onAudio(fullAudio.subarray(i, Math.min(i + 4096, fullAudio.length)));
      }
    }

    expect(received).toEqual(["test 1", "test 2", "test 3"]);
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
    undefined,
    true, // enable ARQ for burst wire test
  );
  const protoB = new Protocol(
    (s) => airBtoA.push(s),
    (payload, seq) => receivedAtB.push({ payload, seq }),
    (s) => airBtoA.push(s),
    undefined,
    true, // enable ARQ for burst wire test
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
