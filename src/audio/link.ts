import { Protocol, setBaseHz } from "../dsp/protocol";
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
  private sink?: AudioSink;
  private txMuteUntil = 0;
  private txUntil = 0;

  constructor(
    baseHz: number,
    sink?: AudioSink,
  ) {
    this.baseHz = baseHz;
    this.sink = sink;
    this.protocol = new Protocol(
      (samples) => {
        this.playAudio(samples, true);
      },
      (payload, seq) => this.onReceive?.(payload, seq),
      undefined,
      (seq) => this.onAck?.(seq),
      false, // Direct transmit without waiting for receiver ACK
      false, // Allow loopback for single-device testing
      (msg) => this.onDebug?.(msg),
    );
  }

  onReceive?: (payload: Uint8Array, seq: number) => void;
  onAck?: (seq: number) => void;
  onTxStart?: (durationMs: number) => void;
  onTxEnd?: () => void;
  onBandChange?: (hz: number) => void;
  onDebug?: (msg: string) => void;

  get busy(): boolean {
    return this.protocol.busy;
  }

  /** Browser audio plumbing (created in start()). */
  private ctx?: AudioContext;
  private stream?: MediaStream;

  async start(onReceive: (payload: Uint8Array, seq: number) => void): Promise<void> {
    this.onReceive = onReceive;
    this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    await this.ctx.resume(); // may still be suspended until first gesture
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_CONSTRAINTS, sampleRate: this.sampleRate },
    });
    // Mic tap: pump live mic samples into the protocol decoder.
    // ScriptProcessorNode is deprecated but the only tap that works without a
    // separate worklet file; 4096-sample chunks are fine at 10 sym/s.
    const source = this.ctx.createMediaStreamSource(this.stream);
    // Live spectrum for the UI waterfall: shows at a glance whether the peer's
    // tones are arriving and in which band — the field-debug eye.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    source.connect(this.analyser);
    this.tap = this.ctx.createScriptProcessor(4096, 1, 1);
    this.tap.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const actualRate = this.ctx?.sampleRate ?? this.sampleRate;
      const samples48k = resampleTo48k(new Float32Array(input), actualRate);
      this.onMicSamples(samples48k);
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
  analyser?: AnalyserNode;

  send(payload: Uint8Array): void {
    // Chrome suspends AudioContext until a user gesture; send IS the gesture.
    void this.ctx?.resume();
    this.protocol.send(payload);
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  get state(): AudioContextState | "closed" {
    return this.ctx?.state ?? "closed";
  }

  setBaseHz(hz: number): void {
    this.baseHz = hz;
    setBaseHz(hz);
    this.onBandChange?.(hz);
  }

  getBaseHz(): number {
    return this.baseHz;
  }

  beep(freq = 1000, durationMs = 200): void {
    if (!this.ctx) return;
    void this.ctx.resume();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.3;
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + durationMs / 1000);
  }

  /** Feed mic samples into the protocol (called from capture tap). */
  onMicSamples(samples: Float32Array): void {
    this.protocol.onAudio(samples);
  }

  /** Sender retry driver: call every ~300 ms from the host app.
   * Suppressed while a frame is actively playing or waiting for an ACK. */
  tick(): void {
    if (Date.now() < this.txUntil) return;
    this.protocol.tick();
  }

  stop(): void {
    this.tap?.disconnect();
    this.mute?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
  }

  private playAudio(samples: Float32Array, isData: boolean): void {
    const durationMs = (samples.length / this.sampleRate) * 1000;
    if (isData) {
      this.txUntil = Date.now() + durationMs;
      this.onTxStart?.(durationMs);
      setTimeout(() => {
        this.onTxEnd?.();
      }, durationMs);
    }
    if (this.sink) {
      this.sink.play(samples);
    } else {
      this.playOnContext(samples);
    }
  }

  private playOnContext(samples: Float32Array): void {
    if (!this.ctx) return;
    void this.ctx.resume();
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start();
  }
}

function resampleTo48k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 48000 || samples.length === 0) return samples;
  const ratio = fromRate / 48000;
  const outLength = Math.round(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[idx] ?? 0;
    const s1 = samples[idx + 1] ?? s0;
    out[i] = s0 + frac * (s1 - s0);
  }
  return out;
}
