/**
 * MFSK acoustic modem: chirp preamble sync + one-of-16 tone symbols.
 * Pure functions over Float32Array; sample rate fixed at 48000.
 */
export const SAMPLE_RATE = 48000;
export const SYMBOL_MS = 100;
export const TONE_COUNT = 16;
export const TONE_SPACING = 250;
export const PREAMBLE_MS = 200;
export const PREAMBLE_REPS = 2;

/** One period of the up-chirp baseband template, normalized amplitude. */
export function chirpTemplate(baseHz: number): Float32Array {
  const n = Math.round((SAMPLE_RATE * PREAMBLE_MS) / 1000);
  const out = new Float32Array(n);
  const span = 4000; // chirp sweeps base..base+4000, matches tone field
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = baseHz + (span * i) / n;
    out[i] = Math.sin(2 * Math.PI * f * t);
  }
  return out;
}

function preamble(baseHz: number): Float32Array {
  const chirp = chirpTemplate(baseHz);
  const out = new Float32Array(chirp.length * PREAMBLE_REPS);
  for (let r = 0; r < PREAMBLE_REPS; r++) out.set(chirp, r * chirp.length);
  return out;
}

function symbolSamples(nibble: number, baseHz: number): Float32Array {
  const n = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  const out = new Float32Array(n);
  const f = baseHz + nibble * TONE_SPACING;
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
  }
  return out;
}

/** Preamble(2 chirps) + each nibble repeated 3x (FEC), LSB nibble first per byte. */
export function modulateFrame(bytes: Uint8Array, baseHz: number): Float32Array {
  const pre = preamble(baseHz);
  const symN = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  const nibbles: number[] = [];
  for (const b of bytes) {
    for (const n of [b & 0x0f, (b >> 4) & 0x0f]) {
      nibbles.push(n, n, n);
    }
  }
  const out = new Float32Array(pre.length + nibbles.length * symN);
  out.set(pre);
  for (let i = 0; i < nibbles.length; i++) {
    out.set(symbolSamples(nibbles[i]!, baseHz), pre.length + i * symN);
  }
  return out;
}

function goertzel(window: Float32Array, freq: number): number {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  let coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < window.length; i++) {
    s0 = window[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Normalized cross-correlation of samples against template (sliding, stride 1ms). */
function findChirp(samples: Float32Array, template: Float32Array): number {
  const tEnergy = template.reduce((s, v) => s + v * v, 0);
  const stride = Math.round(SAMPLE_RATE / 1000);
  // first hit wins: cheap on incremental rescans where the sync sits at offset 0
  for (let off = 0; off + template.length <= samples.length; off += stride) {
    let dot = 0, sEnergy = 0;
    for (let i = 0; i < template.length; i++) {
      dot += samples[off + i]! * template[i];
      sEnergy += samples[off + i]! * samples[off + i]!;
    }
    const score = dot / Math.max(1e-9, Math.sqrt(tEnergy * sEnergy));
    if (score > 0.6) return off;
  }
  return -1;
}

/** Full-preamble template (both chirps) so the sync peak is unique. */
function preambleTemplate(baseHz: number): Float32Array {
  return preamble(baseHz);
}

/** Majority vote across each consecutive triple of repeated nibbles. */
function deRepeat(nibbles: number[]): Uint8Array {
  const nibCount = Math.floor(nibbles.length / 3);
  const out = new Uint8Array(nibCount);
  for (let i = 0; i < nibCount; i++) {
    const a = nibbles[3 * i]!, b = nibbles[3 * i + 1]!, c = nibbles[3 * i + 2]!;
    out[i] = a === b || a === c ? a : b;
  }
  return out;
}

export interface DemodResult {
  frames: Uint8Array[];
  /** Samples consumed up to and including the last decoded frame; safe trim point. */
  consumed: number;
  /** True when a preamble was seen and its frame is still arriving: keep buffering. */
  partialFrame: boolean;
}

/** Streaming decode: call repeatedly as samples arrive; trim input to `consumed`. */
export function demodulate(samples: Float32Array, baseHz: number): DemodResult {
  const symN = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  const preLen = preambleTemplate(baseHz).length;
  const out: Uint8Array[] = [];
  let pos = 0;
  let partialFrame = false;
  while (true) {
    const start = findChirp(samples.subarray(pos), preambleTemplate(baseHz));
    if (start < 0) {
      // No sync anywhere: everything except a possibly-growing partial preamble is dead.
      pos = Math.max(0, samples.length - (preLen - 1));
      break;
    }
    void 0;
    const frameStart = pos + start + preLen;
    // Header first: 4 bytes (sync x2, seq, len) = 24 repeated-nibble symbols.
    const headerSyms = 4 * 2 * 3;
    const headEnd = frameStart + headerSyms * symN;
    if (headEnd > samples.length) break;
    const headerNibbles: number[] = [];
    for (let w = frameStart; w < headEnd; w += symN) {
      let bestBin = -1, bestPower = -1;
      for (let k = 0; k < TONE_COUNT; k++) {
        const pw = goertzel(samples.subarray(w, w + symN), baseHz + k * TONE_SPACING);
        if (pw > bestPower) { bestPower = pw; bestBin = k; }
      }
      headerNibbles.push(bestBin);
    }
    const header = deRepeat(headerNibbles);
    if (header.length < 6) { pos = frameStart + symN; continue; }
    const syncCheck = header.length >= 8 && (header[0]! | (header[1]! << 4)) === 0xa5 && (header[2]! | (header[3]! << 4)) === 0x5a;
    if (!syncCheck) {
      pos = frameStart + symN;
      continue;
    }
    const headerBytes = new Uint8Array(header.length / 2);
    for (let i = 0; i < headerBytes.length; i++) {
      headerBytes[i] = header[2 * i]! | (header[2 * i + 1]! << 4);
    }
    const len = headerBytes[3]!;
    const totalSyms = (6 + len) * 2 * 3; // 4 header + len payload + 2 crc
    const frameEnd = frameStart + totalSyms * symN;
    if (frameEnd > samples.length) {
      partialFrame = true;
      pos = frameStart;
      break;
    }
    const nibbles: number[] = [];
    for (let w = frameStart; w < frameEnd; w += symN) {
      let bestBin = -1, bestPower = -1;
      for (let k = 0; k < TONE_COUNT; k++) {
        const pw = goertzel(samples.subarray(w, w + symN), baseHz + k * TONE_SPACING);
        if (pw > bestPower) { bestPower = pw; bestBin = k; }
      }
      nibbles.push(bestBin);
    }
    const clean = deRepeat(nibbles);
    if (clean.length % 2 === 0) {
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = clean[2 * i]! | (clean[2 * i + 1]! << 4);
      }
      out.push(bytes);
    }
    pos = frameEnd; // continue scanning past this frame
    if (pos >= samples.length) break;
  }
  // On a partial frame, report consumed=0 so the caller keeps the whole
  // buffer (rescan next call; cheap at our buffer sizes).
  return { frames: out, consumed: partialFrame ? 0 : pos, partialFrame };
}

/** Deterministic white Gaussian noise at given SNR vs signal RMS. */
export function addNoise(samples: Float32Array, snrDb: number, seed: number): Float32Array {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  let energy = 0;
  for (const v of samples) energy += v * v;
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  const noiseRms = rms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = samples[i]! + g * noiseRms;
  }
  return out;
}
