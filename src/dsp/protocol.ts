import { decodeFrame, encodeFrame } from "./frame";
import { demodulate, modulateFrame, SAMPLE_RATE } from "./modem";

const MAX_TRIES = 5;

export class Protocol {
  private rxBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private demodState: { scanned: number; lock: number } | null = null;
  private seq = 0;
  private lastReceivedSeq = -1;
  private pending: { bytes: Uint8Array; tries: number } | null = null;
  private lastSentBytes: Uint8Array | null = null;
  private ackPending = false; // sender heard ACK for pending frame

  constructor(
    /** Play samples on the air (modem output). */
    private sendAudio: (samples: Float32Array) => void,
    /** Called once per unique received frame. */
    private onReceive: (payload: Uint8Array, seq: number) => void,
    /** Play an ACK tone (short samples). */
    private emitAck?: (samples: Float32Array) => void,
    /** Optional callback when pending send is acknowledged. */
    private onAckReceived?: (seq: number) => void,
    /** When false (default), transmit directly without stop-and-wait ACK gating. */
    private waitForAck = false,
    /** When true, ignore frames matching our own last transmission. Default false: allows loopback testing. */
    private suppressEcho = false,
    /** Diagnostic callback for DSP events (preamble, sync, CRC). */
    private onDebug?: (msg: string) => void,
  ) {}

  /** Queue a payload for transmission. In direct mode, transmits immediately without waiting for ACK. */
  send(payload: Uint8Array): void {
    if (this.waitForAck && this.pending) return; // busy in ARQ mode
    this.rxBuffer = new Float32Array(0);
    if (this.demodState) {
      this.demodState.scanned = 0;
      this.demodState.lock = -1;
    }
    const frameBytes = encodeFrame(this.seq, payload);
    this.lastSentBytes = frameBytes;
    if (this.waitForAck) {
      this.pending = { bytes: frameBytes, tries: 0 };
    } else {
      this.seq = (this.seq + 1) & 0xff;
    }
    this.sendAudio(modulateFrame(frameBytes, activeBaseHz));
  }

  private transmit(): void {
    if (!this.pending) return;
    this.sendAudio(modulateFrame(this.pending.bytes, activeBaseHz));
  }

  /** Feed received audio into the receiver side. Buffers chunks until frames decode. */
  onAudio(samples: Float32Array): void {
    // ACK detection only if waiting for ACK: energy at base+4250 releases a pending send.
    if (this.waitForAck && this.pending && ackEnergy(samples) > ACK_THRESHOLD) {
      this.onAck();
      return;
    }
    this.rxBuffer = concatFloat32(this.rxBuffer, samples);
    if (!this.demodState) this.demodState = { scanned: 0, lock: -1 };
    const { frames, consumed, events } = demodulate(this.rxBuffer, activeBaseHz, this.demodState);
    if (events && this.onDebug) {
      for (const ev of events) this.onDebug(ev);
    }
    if (consumed > 0) {
      this.rxBuffer = this.rxBuffer.subarray(consumed);
      this.demodState.scanned = Math.max(0, this.demodState.scanned - consumed);
      this.demodState.lock = this.demodState.lock < 0 ? -1 : Math.max(0, this.demodState.lock - consumed);
    }
    if (this.demodState.lock < 0 && this.demodState.scanned > 0) {
      const drop = this.demodState.scanned;
      this.rxBuffer = this.rxBuffer.subarray(drop);
      this.demodState.scanned = 0;
    }
    // Bound the buffer: bound at 15s so real multi-second transmissions are never clipped.
    if (this.rxBuffer.length > SAMPLE_RATE * 15) {
      this.rxBuffer = new Float32Array(0);
      this.demodState = { scanned: 0, lock: -1 };
    }
    for (const bytes of frames) {
      const frame = decodeFrame(bytes);
      if (!frame) {
        this.onDebug?.("frame CRC mismatch or corrupt bytes");
        continue;
      }
      // Echo suppression: do not decode our own in-flight or transmitted frame if enabled
      if (this.suppressEcho && ((this.pending && arraysEqual(bytes, this.pending.bytes)) ||
          (this.lastSentBytes && arraysEqual(bytes, this.lastSentBytes)))) {
        this.onDebug?.("echo suppressed (our own transmission)");
        continue;
      }
      if (frame.seq !== this.lastReceivedSeq) {
        this.lastReceivedSeq = frame.seq;
        this.onReceive(frame.payload, frame.seq);
      }
      if (this.waitForAck && this.emitAck) {
        this.emitAck(ackTone()); // ACK even duplicates so sender stops retrying
      }
    }
  }

  /** Sender calls this (e.g. on a timer) to retry unacknowledged frames (ARQ mode only). */
  tick(): void {
    if (!this.waitForAck || !this.pending || this.ackPending) return;
    this.pending.tries++;
    if (this.pending.tries > MAX_TRIES) {
      this.pending = null; // give up
      return;
    }
    this.transmit();
  }

  get busy(): boolean {
    return this.waitForAck ? this.pending !== null : false;
  }

  /** Mark pending frame acknowledged (called by ACK detector). */
  onAck(): void {
    if (!this.pending) return;
    const ackSeq = this.seq;
    this.ackPending = true;
    this.pending = null;
    this.ackPending = false;
    this.seq = (this.seq + 1) & 0xff;
    this.onAckReceived?.(ackSeq);
  }
}

// Band base chosen at startup; module-level for simplicity in this scope.
let activeBaseHz = 2000;
export function getBaseHz(): number {
  return activeBaseHz;
}
export function setBaseHz(hz: number): void {
  activeBaseHz = hz;
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Goertzel energy of the ACK tone bin over the buffer, normalized by buffer energy. */
function ackEnergy(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  const w = (2 * Math.PI * (activeBaseHz + 4250)) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  let totalEnergy = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    totalEnergy += s * s;
    s0 = s + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  if (totalEnergy < 1e-6) return 0; // silence
  const toneP = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  // Normalized ratio: fraction of buffer energy concentrated at ACK frequency
  return toneP / (totalEnergy * samples.length * 0.5);
}

const ACK_THRESHOLD = 0.15; // 15% ratio reliably detects ACK tones across distance

/** 100 ms ACK tone at base+4250. */
function ackTone(): Float32Array {
  const n = Math.round((SAMPLE_RATE * 100) / 1000);
  const out = new Float32Array(n);
  const f = activeBaseHz + 4250;
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
  return out;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { MAX_TRIES, decodeFrame };
