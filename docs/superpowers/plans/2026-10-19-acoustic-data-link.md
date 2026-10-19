# SW-41 Acoustic Data Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** A browser-based near-silent acoustic data link (SW-41): text/files travel speaker-to-mic between two devices over air, robust to hall noise, with live spectrogram dashboard.

**Architecture:** Static TypeScript web app (Vite). DSP core (modulator/demodulator/framing/FEC/ARQ) is pure functions over Float32Array - fully testable in simulation before any real audio. Real audio I/O via Web Audio API with processing disabled. A tiny static server hosts it on the hotspot.

**Tech Stack:** TypeScript, Vite, vitest, Web Audio API, no UI framework.

**Spec:** docs/superpowers/specs/2026-10-19-acoustic-data-link-design.md

## Global Constraints
- Sample rate 48000 Hz everywhere.
- Three band tiers (base carrier): ultrasonic 18500 Hz, near-audible 14500 Hz, audible 2000 Hz.
- 16 data tones, 250 Hz spacing (base+0 .. base+3750), one active tone per symbol (4 bits/symbol).
- Symbol duration 100 ms (10 sym/s, 40 bps raw).
- Preamble: 200 ms up-chirp spanning [base, base+4000], sent twice.
- Frame: 2-byte sync 0xA5 0x5A + 1-byte seq + 1-byte len + payload (max 64 B) + 2-byte CRC-16/CCITT.
- FEC: each nibble symbol repeated 3x, majority vote.
- ARQ: stop-and-wait, max 5 tries; ACK tone at base+4250 for 100 ms.
- Mic constraints: echoCancellation:false, noiseSuppression:false, autoGainControl:false.
- All DSP hand-rolled; tests run offline (no audio hardware).

## Review Focus
- Speaker cannot emit band (roll-off above 16 kHz): calibration must fail gracefully to next tier, never silent hang. Task 6.
- Mic processing not disabled: ultrasonic content destroyed. Task 5 assertion on MIC_CONSTRAINTS.
- Noise burst mid-frame: sync re-locks on next preamble, no infinite ARQ. Task 4 sim test.
- Payload edge cases: len 0 ok, len > 64 rejected. Task 2 tests.
- Duplicate frame delivery (lost ACK): dedupe by seq. Task 4 test.

---

### Task 1: Scaffold
Files: package.json, vite.config.ts, tsconfig.json, index.html, src/main.ts, tests/setup.test.ts
Produces: npm run dev, npm test (vitest, node env), TS strict.
- [ ] Step 1: Scaffold vite vanilla-ts + add vitest, script test = vitest run.
- [ ] Step 2: sanity test in tests/setup.test.ts (expect 1+1 toBe 2).
- [ ] Step 3: npm test -> PASS.
- [ ] Step 4: git init + commit "chore: scaffold".

### Task 2: CRC + frame codec
Files: src/dsp/crc.ts, src/dsp/frame.ts; Test: tests/frame.test.ts
Produces: crc16(data: Uint8Array): number (CRC-16/CCITT poly 0x1021 init 0xFFFF); encodeFrame(seq: number, payload: Uint8Array): Uint8Array (throws RangeError if len > 64); decodeFrame(bytes: Uint8Array): {seq, payload} | null (null on sync/CRC mismatch, accepts len 0).
- [ ] Step 1: failing tests: crc16("123456789") === 0x29B1; roundtrip; corrupt byte -> null; 65-byte payload throws; 0-byte roundtrip.
- [ ] Step 2: npm test -- frame -> FAIL.
- [ ] Step 3: implement both modules.
- [ ] Step 4: npm test -- frame -> PASS.
- [ ] Step 5: commit "feat: crc16 and frame codec".

### Task 3: Modulator + simulated channel
Files: src/dsp/modem.ts, src/dsp/channel.ts; Test: tests/modem.test.ts
Consumes: encodeFrame. Produces: modulateFrame(bytes: Uint8Array, baseHz: number): Float32Array; demodulate(samples: Float32Array, baseHz: number): Uint8Array[]; addNoise(samples: Float32Array, snrDb: number, seed: number): Float32Array.
- [ ] Step 1: failing tests: modulate->demodulate at SNR 20 returns frames; at SNR 5 still decodes; fixed seed deterministic.
- [ ] Step 2: npm test -- modem -> FAIL.
- [ ] Step 3: implement. Sync = cross-correlate vs chirp template, peak > 0.4; per 100 ms window argmax over 16 tone bins; majority-vote de-repeat.
- [ ] Step 4: npm test -- modem -> PASS.
- [ ] Step 5: commit "feat: modem + noisy channel sim".

### Task 4: FEC + ARQ protocol
Files: src/dsp/fec.ts, src/dsp/protocol.ts; Test: tests/protocol.test.ts
Consumes: frame + modem. Produces: class Protocol(sendAudio, onReceive, emitAck) with send(payload) and onAudio(samples); stop-and-wait, 5 retries, dedupe by seq.
- [ ] Step 1: failing tests over simulated wire with addNoise SNR 15: exactly-once delivery; survive 3 corrupted retransmissions; lost ACK -> duplicate suppressed (onReceive once).
- [ ] Step 2: npm test -- protocol -> FAIL.
- [ ] Step 3: implement repetition FEC (nibble x3) + state machines (WAIT_ACK/RETRY; LAST_SEQ).
- [ ] Step 4: npm test -- protocol -> PASS.
- [ ] Step 5: commit "feat: fec + stop-and-wait arq".

### Task 5: Real audio I/O
Files: src/audio/link.ts; Test: tests/link-audio.test.ts
Produces: class AudioLink(baseHz) with start(onReceive), send(payload), stop(); MIC_CONSTRAINTS export.
- [ ] Step 1: failing test: MIC_CONSTRAINTS deep-equals the three false flags; stubbed AudioContext sampleRate 48000.
- [ ] Step 2: npm test -- link-audio -> FAIL.
- [ ] Step 3: implement; AudioBufferSourceNode playback of modulateFrame output; getUserMedia tap -> protocol.onAudio.
- [ ] Step 4: npm test -- link-audio -> PASS.
- [ ] Step 5: commit "feat: web audio link".

### Task 6: Calibration + band selection
Files: src/audio/calibration.ts; Test: tests/calibration.test.ts
Produces: async calibrate(ctx, stream, tiers: number[]): Promise<number> - 500 ms sweep per tier, energy ratio > 0.1 required, else next tier, fallback 2000.
- [ ] Step 1: failing tests: strong 18.5k -> 18500; weak at first two -> 2000; all-zero response never throws.
- [ ] Step 2: npm test -- calibration -> FAIL.
- [ ] Step 3: implement sweep + AnalyserNode energy measurement.
- [ ] Step 4: npm test -- calibration -> PASS.
- [ ] Step 5: commit "feat: band calibration".

### Task 7: UI + dashboard
Files: src/app/ui.ts, src/app/dashboard.ts, index.html, src/main.ts; Test: tests/ui.test.ts (jsdom)
Produces: send box + file input, receive pane, live spectrogram canvas, band badge, retry log; optional WebSocket dashboard.
- [ ] Step 1: failing test: buildUi(root) renders controls; send click calls stubbed link.send with UTF-8 bytes.
- [ ] Step 2: npm test -- ui -> FAIL.
- [ ] Step 3: implement UI + spectrogram loop.
- [ ] Step 4: npm test -- ui -> PASS.
- [ ] Step 5: commit "feat: link ui".

### Task 8: Over-the-air integration + demo kit
Files: serve.mjs (static server + LAN URL), DEMO.md. Manual gate.
- [ ] Step 1: node serve.mjs prints LAN URL.
- [ ] Step 2: DEMO.md manual OTA script: audible tier laptop->tablet, then near-audible, then with music playing. Expected: delivered in all three.
- [ ] Step 3: pre-demo checklist (volume 80%, 20-40 cm apart, hotspot, calibration run).
- [ ] Step 4: commit "feat: demo runbook".

### Task 9 (stretch): ML denoiser garnish
Skippable; only if link stable. Pitch-slide fallback if unbuilt.
- [ ] Ship only if live link stable.
