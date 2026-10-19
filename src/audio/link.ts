import { Protocol } from "../dsp/protocol";
import { modulateFrame, SAMPLE_RATE } from "../dsp/modem";

export const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

export interface AudioSink {
  play: (buffer: Float32Array) => void;
}

/** Real-audio wrapper around Protocol. Browser-only; tests stub the sink. */
export class AudioLink {
  readonly sampleRate = SAMPLE_RATE;
  private protocol: Protocol;
  private baseHz: number;

  constructor(
    baseHz: number,
    sink?: AudioSink,
  ) {
    this.baseHz = baseHz;
    this.protocol = new Protocol(
      (samples) => {
        if (sink) {
          sink.play(samples);
        } else {
          this.playOnContext(samples);
        }
      },
      (payload, seq) => this.onReceive?.(payload, seq),
      (samples) => {
        if (sink) sink.play(samples);
        else this.playOnContext(samples);
      },
    );
  }

  onReceive?: (payload: Uint8Array, seq: number) => void;

  /** Browser audio plumbing (created in start()). */
  private ctx?: AudioContext;
  private stream?: MediaStream;

  async start(onReceive: (payload: Uint8Array, seq: number) => void): Promise<void> {
    this.onReceive = onReceive;
    this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_CONSTRAINTS, sampleRate: this.sampleRate },
    });
  }

  send(payload: Uint8Array): void {
    this.protocol.send(payload);
  }

  /** Feed mic samples into the protocol (called from capture tap). */
  onMicSamples(samples: Float32Array): void {
    this.protocol.onAudio(samples);
  }

  /** Sender retry driver: call every ~300 ms from the host app. */
  tick(): void {
    this.protocol.tick();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
  }

  private playOnContext(samples: Float32Array): void {
    if (!this.ctx) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start();
  }
}
