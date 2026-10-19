/**
 * Band selection: pick the highest tier whose measured response clears
 * the threshold; audible 2000 Hz is the unconditional fallback.
 * (Sweep playback + measurement live in the UI layer; this pure function
 * holds the decision logic so it stays testable.)
 */
export const RESPONSE_THRESHOLD = 0.1;

export function pickTierFromResponses(
  tiers: number[],
  responses: Record<number, number>,
): number {
  for (const tier of tiers) {
    const r = responses[tier] ?? 0;
    if (r > RESPONSE_THRESHOLD) return tier;
  }
  return 2000;
}

/**
 * Live calibration: play a 500 ms sweep per tier through the speakers,
 * measure mic energy inside [tier, tier+3000] via AnalyserNode FFT bins.
 * Returns the chosen base frequency.
 */
export async function calibrate(
  ctx: AudioContext,
  stream: MediaStream,
  tiers: number[] = [18500, 14500, 2000],
): Promise<number> {
  const responses: Record<number, number> = {};
  for (const tier of tiers) {
    responses[tier] = await measureTier(ctx, stream, tier);
  }
  return pickTierFromResponses(tiers, responses);
}

async function measureTier(ctx: AudioContext, stream: MediaStream, tier: number): Promise<number> {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  source.connect(analyser);

  // sweep: 500 ms chirp across [tier, tier+3000]
  const n = Math.round(ctx.sampleRate * 0.5);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const f = tier + (3000 * i) / n;
    data[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / ctx.sampleRate);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  src.connect(gain).connect(ctx.destination);
  src.start();

  // sample the spectrum while it plays
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  const iLow = Math.floor(tier / hzPerBin);
  const iHigh = Math.ceil((tier + 3000) / hzPerBin);
  const bandTotal = iHigh - iLow;
  const readings: number[] = [];
  const t0 = ctx.currentTime;
  while (ctx.currentTime - t0 < 0.5) {
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = iLow; i < iHigh && i < bins.length; i++) sum += bins[i]!;
    readings.push(sum / (bandTotal * 255));
    await new Promise((r) => setTimeout(r, 50));
  }
  src.stop();
  source.disconnect();
  analyser.disconnect();
  readings.sort((a, b) => b - a);
  return readings[0] ?? 0; // peak reading = best response during sweep
}
