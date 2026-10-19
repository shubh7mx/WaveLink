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

/** One period of the up-chirp baseband template, normalized amplitude.
 * Phase is accumulated (integral of instantaneous frequency) — a proper
 * linear chirp, whose autocorrelation is broad instead of razor-thin. */
export function chirpTemplate(baseHz: number): Float32Array {
  const n = Math.round((SAMPLE_RATE * PREAMBLE_MS) / 1000);
  const out = new Float32Array(n);
  const span = 4000; // chirp sweeps base..base+4000, matches tone field
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = baseHz + (span * i) / n;
    out[i] = Math.sin(phase);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
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
/** Radix-2 in-place FFT (real input treated as complex with zero imag). */
function fftMag(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!, ti = im[i]!;
      re[i] = re[j]!; im[i] = im[j]!;
      re[j] = tr; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const curRe = Math.cos(ang * k), curIm = Math.sin(ang * k); // exact, no drift
        const uRe = re[i + k]!, uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const vIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
      }
    }
  }
}

/** Cheap gate: does this buffer hold meaningful energy in the chirp band? */
function bandEnergy(samples: Float32Array, baseHz: number): number {
  let sum = 0;
  const step = Math.max(1, Math.floor(samples.length / 64));
  for (let i = 0; i + 512 <= samples.length; i += step) {
    sum += goertzel(samples.subarray(i, i + 512), baseHz + 2000);
  }
  return sum;
}

const SYNC_THRESHOLD = 0.5;

/**
 * FFT-based normalized cross-correlation sync (exact offsets, O(N log N)).
 * Single-chirp template; true chirp mainlobe is ~12 samples wide, so only
 * full-resolution correlation finds it — stride sampling provably misses.
 */
/** Absolute-index search over samples[from..]; findChirp works on the subarray and shifts back. */
function findChirpFrom(samples: Float32Array, template: Float32Array, baseHz: number, from: number): number {
  const hit = findChirp(samples.subarray(from), template, baseHz);
  return hit < 0 ? -1 : from + hit;
}

function findChirp(samples: Float32Array, template: Float32Array, baseHz: number): number {
  const n = samples.length, m = template.length;
  if (n < m) return -1;
  const size = 1 << Math.ceil(Math.log2(n + m));
  const reS = new Float64Array(size), imS = new Float64Array(size);
  const reT = new Float64Array(size), imT = new Float64Array(size);
  reS.set(samples);
  // template reversed => correlation becomes convolution => single forward FFT pair
  for (let i = 0; i < m; i++) reT[i] = template[m - 1 - i]!;
  fftMag(reS, imS);
  fftMag(reT, imT);
  const reC = new Float64Array(size), imC = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    reC[i] = reS[i]! * reT[i]! - imS[i]! * imT[i]!;
    imC[i] = reS[i]! * imT[i]! + imS[i]! * reT[i]!;
  }
  // inverse FFT via conjugation trick (conj trick omits the 1/N — apply it here)
  for (let i = 0; i < size; i++) imC[i] = -imC[i]!;
  fftMag(reC, imC);
  const invN = 1 / size;
  for (let i = 0; i < size; i++) reC[i] = reC[i]! * invN;
  const tEnergy = template.reduce((s, v) => s + v * v, 0);
  let sEnergy = 0;
  const pre = new Float64Array(n); // running window energy via prefix sums
  for (let i = 0; i < n; i++) {
    pre[i] = sEnergy + samples[i]! * samples[i]!;
    sEnergy = pre[i]!;
  }
  // First offset past threshold wins: the preamble is two identical chirps, and
  // picking the global max lets noise make the second chirp win the tie, locking
  // one chirp late. Earliest true peak is also the correct preamble alignment.
  for (let off = m - 1; off < n; off++) {
    // correlation index: conv result at off corresponds to alignment start = off-(m-1)
    const start = off - (m - 1);
    const dot = reC[off]!;
    const wEnd = start + m - 1;
    const wEnergy = pre[wEnd]! - (start > 0 ? pre[start - 1]! : 0);
    const score = dot / Math.max(1e-9, Math.sqrt(tEnergy * Math.max(1e-9, wEnergy)));
    if (score > SYNC_THRESHOLD) return start;
  }
  return -1;
}

function preambleLen(baseHz: number): number {
  return preamble(baseHz).length;
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

/** Decode state carried across streaming calls; keeps rescans incremental. */
export interface DemodState {
  /** Number of leading samples already fully scanned (never a sync start). */
  scanned: number;
  /**
   * Buffer offset where the preamble of the frame currently in flight starts.
   * The caller must NOT trim the buffer below this point until the frame
   * completes (a no-sync rescan must not retreat past it either).
   */
  lock: number;
}

/** Streaming decode: call repeatedly as samples arrive; trim input to `consumed`.
 * Pass the same state object each call to avoid rescanning earlier samples. */
export function demodulate(samples: Float32Array, baseHz: number, state?: DemodState): DemodResult {
  const symN = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  const tmplLen = chirpTemplate(baseHz).length;
  const preLen = preambleLen(baseHz);
  const out: Uint8Array[] = [];
  const stateful = state !== undefined;
  const lock = state ? state.lock : -1;
  let pos = state ? state.scanned : 0;
  let partialFrame = false;
  let consumed = 0;
  while (true) {
    let start: number;
    if (lock >= 0) {
      // Frame in flight: its preamble was already found; decode once its samples
      // arrive (start relative to the buffer, may be negative while preamble ends).
      start = lock - preLen;
    } else {
      start = findChirpFrom(samples, chirpTemplate(baseHz), baseHz, pos);
    }
    if (start < 0) {
      // No sync anywhere: everything except a possibly-growing partial preamble
      // is dead. With a frame in flight (lock active) consume nothing — the
      // preamble itself may still be coming in.
      if (stateful) state.scanned = lock >= 0 ? 0 : Math.max(0, samples.length - (preLen - 1));
      break;
    }
    const frameStart = lock >= 0 ? lock : start + preLen; // preLen = full preamble (2 chirps)
    // Header first: 4 bytes (sync x2, seq, len) = 24 repeated-nibble symbols.
    const headerSyms = 4 * 2 * 3;
    const headEnd = frameStart + headerSyms * symN;
    if (headEnd > samples.length) {
      // Preamble seen, header incomplete: keep the whole buffer (consumed=0) and
      // mark only up to one chirp past the locked sync — the second preamble chirp
      // may still be arriving, so frameStart itself can be beyond the buffer.
      partialFrame = true;
      pos = Math.min(frameStart, start + tmplLen);
      if (stateful) { state.scanned = pos; state.lock = frameStart; }
      break;
    }
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
      if (stateful) state.lock = -1;
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
      if (stateful) { state.scanned = frameStart; state.lock = frameStart; }
      pos = Math.min(frameStart, start + tmplLen);
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
    if (stateful) state.lock = -1;
    if (pos >= samples.length) break;
  }
  // On a partial frame, report consumed=0 so the caller keeps the whole
  // buffer (rescan next call; state.scanned keeps that rescan incremental).
  consumed = partialFrame ? 0 : pos;
  return { frames: out, consumed, partialFrame };
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
