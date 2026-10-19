import { decodeFrame, encodeFrame } from "./frame";
import { demodulate, modulateFrame, SAMPLE_RATE } from "./modem";

const MAX_TRIES = 5;

export class Protocol {
  private seq = 0;
  private lastReceivedSeq = -1;
  private pending: { bytes: Uint8Array; tries: number } | null = null;
  private ackPending = false; // sender heard ACK for pending frame

  constructor(
    /** Play samples on the air (modem output). */
    private sendAudio: (samples: Float32Array) => void,
    /** Called once per unique received frame. */
    private onReceive: (payload: Uint8Array, seq: number) => void,
    /** Play an ACK tone (short samples). */
    private emitAck: (samples: Float32Array) => void,
  ) {}

  /** Queue a payload for transmission. Stop-and-wait: one frame in flight. */
  send(payload: Uint8Array): void {
    if (this.pending) return; // busy: drop or wait; hackathon scope: drop
    this.pending = { bytes: encodeFrame(this.seq, payload), tries: 0 };
    this.transmit();
  }

  private transmit(): void {
    if (!this.pending) return;
    this.sendAudio(modulateFrame(this.pending.bytes, activeBaseHz));
  }

  /** Feed received audio into the receiver side. */
  onAudio(samples: Float32Array): void {
    for (const bytes of demodulate(samples, activeBaseHz)) {
      const frame = decodeFrame(bytes);
      if (!frame) continue;
      if (frame.seq !== this.lastReceivedSeq) {
        this.lastReceivedSeq = frame.seq;
        this.onReceive(frame.payload, frame.seq);
      }
      this.emitAck(ackTone()); // ACK even duplicates so sender stops retrying
    }
  }

  /** Sender calls this (e.g. on a timer) to retry unacknowledged frames. */
  tick(): void {
    if (!this.pending || this.ackPending) return;
    this.pending.tries++;
    if (this.pending.tries > MAX_TRIES) {
      this.pending = null; // give up
      return;
    }
    this.transmit();
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  /** Mark pending frame acknowledged (called by ACK detector). */
  onAck(): void {
    if (!this.pending) return;
    this.ackPending = true;
    this.pending = null;
    this.ackPending = false;
    this.seq = (this.seq + 1) & 0xff;
  }
}

// Band base chosen at startup; module-level for simplicity in this scope.
let activeBaseHz = 2000;
export function setBaseHz(hz: number): void {
  activeBaseHz = hz;
}

/** 100 ms ACK tone at base+4250. */
function ackTone(): Float32Array {
  const n = Math.round((SAMPLE_RATE * 100) / 1000);
  const out = new Float32Array(n);
  const f = activeBaseHz + 4250;
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
  return out;
}

export { MAX_TRIES, decodeFrame };
