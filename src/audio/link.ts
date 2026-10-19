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
    // Mic tap: pump live mic samples into the protocol decoder.
    // ScriptProcessorNode is deprecated but the only tap that works without a
    // separate worklet file; 4096-sample chunks are fine at 10 sym/s.
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.tap = this.ctx.createScriptProcessor(4096, 1, 1);
    this.tap.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.onMicSamples(new Float32Array(input));
    };
    source.connect(this.tap);
    // ScriptProcessor needs a connected destination to run; route through a
    // zero-gain node so mic is never audible on the speakers.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.tap.connect(this.mute).connect(this.ctx.destination);
  }

  private tap?: ScriptProcessorNode;
  private mute?: GainNode;

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
    this.tap?.disconnect();
    this.mute?.disconnect();
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
