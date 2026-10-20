import { MAX_PAYLOAD } from "./frame";

/**
 * MFSK acoustic modem: chirp preamble sync + one-of-16 tone symbols.
 * Pure functions over Float32Array; sample rate fixed at 48000.
 */
export const SAMPLE_RATE = 48000;
export const SYMBOL_MS = 50;
export const TONE_COUNT = 16;
export const TONE_SPACING = 250;
export const PREAMBLE_MS = 200;
export const PREAMBLE_REPS = 1;

const chirpCache = new Map<number, { sin: Float32Array; cos: Float32Array }>();

export function complexChirpTemplate(baseHz: number): { sin: Float32Array; cos: Float32Array } {
  let hit = chirpCache.get(baseHz);
  if (!hit) {
    const n = Math.round((SAMPLE_RATE * PREAMBLE_MS) / 1000);
    const sin = new Float32Array(n);
    const cos = new Float32Array(n);
    const span = 4000;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = baseHz + (span * i) / n;
      sin[i] = Math.sin(phase);
      cos[i] = Math.cos(phase);
      phase += (2 * Math.PI * f) / SAMPLE_RATE;
    }
    hit = { sin, cos };
    chirpCache.set(baseHz, hit);
  }
  return hit;
}

/** One period of the up-chirp baseband template, normalized amplitude.
 * Phase is accumulated (integral of instantaneous frequency) — a proper
 * linear chirp, whose autocorrelation is broad instead of razor-thin. */
export function chirpTemplate(baseHz: number): Float32Array {
  return complexChirpTemplate(baseHz).sin;
}

function preamble(baseHz: number): Float32Array {
  const chirp = chirpTemplate(baseHz);
  const out = new Float32Array(chirp.length * PREAMBLE_REPS);
  for (let r = 0; r < PREAMBLE_REPS; r++) out.set(chirp, r * chirp.length);
  // fade only the very edges; the two chirps must stay phase-continuous for sync
  const fade = Math.round(SAMPLE_RATE * 0.004);
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i] = out[i]! * g;
    out[out.length - 1 - i] = out[out.length - 1 - i]! * g;
  }
  return out;
}

function symbolSamples(nibble: number, baseHz: number): Float32Array {
  const n = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  const out = new Float32Array(n);
  const f = baseHz + nibble * TONE_SPACING;
  // 4 ms raised-cosine edges (like chirp's tone fades): raw on/off tones click and
  // splatter, and speaker/mic ringing then corrupts the following symbol.
  const fade = Math.min(Math.round(SAMPLE_RATE * 0.004), Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= n - fade) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / fade);
    out[i] = 0.9 * env * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
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

const twiddleCache = new Map<number, { re: Float64Array; im: Float64Array }>();
function getTwiddles(len: number): { re: Float64Array; im: Float64Array } {
  let tw = twiddleCache.get(len);
  if (!tw) {
    const half = len >> 1;
    const re = new Float64Array(half);
    const im = new Float64Array(half);
    const ang = (-2 * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      re[k] = Math.cos(ang * k);
      im[k] = Math.sin(ang * k);
    }
    tw = { re, im };
    twiddleCache.set(len, tw);
  }
  return tw;
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
    const { re: twRe, im: twIm } = getTwiddles(len);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      const iHalf = i + half;
      for (let k = 0; k < half; k++) {
        const curRe = twRe[k]!, curIm = twIm[k]!;
        const ik = i + k;
        const ik2 = iHalf + k;
        const uRe = re[ik]!, uIm = im[ik]!;
        const vRe = re[ik2]! * curRe - im[ik2]! * curIm;
        const vIm = re[ik2]! * curIm + im[ik2]! * curRe;
        re[ik] = uRe + vRe;
        im[ik] = uIm + vIm;
        re[ik2] = uRe - vRe;
        im[ik2] = uIm - vIm;
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

const SYNC_THRESHOLD = 0.20; // 0.20 reliably detects chirps over real laptop speakers/mics with room reverberation

/**
 * FFT-based normalized cross-correlation sync (exact offsets, O(N log N)).
 * Single-chirp template; true chirp mainlobe is ~12 samples wide, so only
 * full-resolution correlation finds it — stride sampling provably misses.
 */
/** Absolute-index search over samples[from..]; findChirp works on the subarray and shifts back. */
function findChirpFrom(samples: Float32Array, template: Float32Array, baseHz: number, from: number): number {
  const hit = findChirp(samples.subarray(from), baseHz);
  return hit < 0 ? -1 : from + hit;
}

interface TemplateFft {
  reT: Float64Array;
  imT: Float64Array;
  tEnergy: number;
}
const templateFftCache = new Map<string, TemplateFft>();

function getTemplateFft(baseHz: number, size: number, m: number, tmpl: { sin: Float32Array; cos: Float32Array }): TemplateFft {
  const key = `${baseHz}_${size}`;
  let hit = templateFftCache.get(key);
  if (!hit) {
    const reT = new Float64Array(size), imT = new Float64Array(size);
    for (let i = 0; i < m; i++) {
      reT[i] = tmpl.sin[m - 1 - i]!;
      imT[i] = -tmpl.cos[m - 1 - i]!;
    }
    fftMag(reT, imT);
    let tEnergy = 0;
    for (let i = 0; i < m; i++) tEnergy += tmpl.sin[i]! * tmpl.sin[i]!;
    hit = { reT, imT, tEnergy };
    templateFftCache.set(key, hit);
  }
  return hit;
}

function findChirp(samples: Float32Array, baseHz: number): number {
  const tmpl = complexChirpTemplate(baseHz);
  const n = samples.length, m = tmpl.sin.length;
  if (n < m) return -1;
  const size = 1 << Math.ceil(Math.log2(n + m));
  const { reT, imT, tEnergy } = getTemplateFft(baseHz, size, m, tmpl);
  const reS = new Float64Array(size), imS = new Float64Array(size);
  reS.set(samples);
  fftMag(reS, imS);
  const reC = new Float64Array(size), imC = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    reC[i] = reS[i]! * reT[i]! - imS[i]! * imT[i]!;
    imC[i] = reS[i]! * imT[i]! + imS[i]! * reT[i]!;
  }
  // inverse FFT via conjugation trick
  for (let i = 0; i < size; i++) imC[i] = -imC[i]!;
  fftMag(reC, imC);
  const invN = 1 / size;
  for (let i = 0; i < size; i++) {
    reC[i] = reC[i]! * invN;
    imC[i] = imC[i]! * invN;
  }
  let sEnergy = 0;
  const pre = new Float64Array(n); // running window energy via prefix sums
  for (let i = 0; i < n; i++) {
    pre[i] = sEnergy + samples[i]! * samples[i]!;
    sEnergy = pre[i]!;
  }
  // Search for the correlation peak: quadrature envelope is phase-invariant across 0..360 deg
  for (let off = m - 1; off < n; off++) {
    const start = off - (m - 1);
    const env = Math.sqrt(reC[off]! * reC[off]! + imC[off]! * imC[off]!);
    const wEnd = start + m - 1;
    const wEnergy = pre[wEnd]! - (start > 0 ? pre[start - 1]! : 0);
    const score = env / Math.max(1e-9, Math.sqrt(tEnergy * Math.max(1e-9, wEnergy)));
    if (score > SYNC_THRESHOLD) {
      // Find local peak around this detection (mainlobe width ~64 samples)
      let bestScore = score;
      let bestStart = start;
      const searchEnd = Math.min(n - 1, off + 64);
      for (let pOff = off + 1; pOff <= searchEnd; pOff++) {
        const pStart = pOff - (m - 1);
        const pEnv = Math.sqrt(reC[pOff]! * reC[pOff]! + imC[pOff]! * imC[pOff]!);
        const pwEnd = pStart + m - 1;
        const pwEnergy = pre[pwEnd]! - (pStart > 0 ? pre[pStart - 1]! : 0);
        const pScore = pEnv / Math.max(1e-9, Math.sqrt(tEnergy * Math.max(1e-9, pwEnergy)));
        if (pScore > bestScore) {
          bestScore = pScore;
          bestStart = pStart;
        } else if (pScore < bestScore * 0.7) {
          break;
        }
      }
      return bestStart;
    }
  }
  return -1;
}

function preambleLen(baseHz: number): number {
  return preamble(baseHz).length;
}

/** Symbol decode: strongest bin, but only if it dominates the runner-up.
 * The window is fine-tuned ±SEARCH samples for maximum tone power first —
 * sender/receiver clocks differ by tens of ppm, which slips a frame by tens
 * of samples (chirp's trick of slow symbols plus per-character re-sync, here
 * as per-symbol re-sync). Returns -1 (erasure) on a near-tie (noise). */
const DOMINANCE = 1.04; // 4% dominance with 3x repetition FEC handles multipath reverberation
function bestBinDominant(samples: Float32Array, w: number, symN: number, baseHz: number): number {
  // Center-window guard interval: skip 15% edges (7.5ms guard against reverberation & transition clicks)
  const guard = Math.round(symN * 0.15);
  const win = samples.subarray(w + guard, w + symN - guard);
  if (win.length < Math.round(symN * 0.7)) return -1;
  let best = -1, second = -1, bestP = 0, secondP = 0;
  for (let k = 0; k < TONE_COUNT; k++) {
    const pw = goertzel(win, baseHz + k * TONE_SPACING);
    if (pw > bestP) { secondP = bestP; second = best; bestP = pw; best = k; }
    else if (pw > secondP) { secondP = pw; second = k; }
  }
  return bestP > secondP * DOMINANCE ? best : -1;
}

/** Majority vote across each consecutive triple of repeated nibbles; erasures (-1)
 * don't vote, so two clean copies decide. All-erasure triples yield 0xff (invalid). */
function deRepeat(nibbles: number[]): Uint8Array {
  const nibCount = Math.floor(nibbles.length / 3);
  const out = new Uint8Array(nibCount);
  for (let i = 0; i < nibCount; i++) {
    const votes = [nibbles[3 * i]!, nibbles[3 * i + 1]!, nibbles[3 * i + 2]!];
    const valid = votes.filter((v) => v >= 0);
    if (valid.length === 0) { out[i] = 0xff; continue; }
    // most common valid vote (3 values: first-seen majority wins ties)
    const counts = new Map<number, number>();
    for (const v of valid) counts.set(v, (counts.get(v) ?? 0) + 1);
    let bestV = valid[0]!, bestC = 0;
    for (const [v, c] of counts) if (c > bestC) { bestC = c; bestV = v; }
    out[i] = bestV;
  }
  return out;
}

export interface DemodResult {
  frames: Uint8Array[];
  /** Samples consumed up to and including the last decoded frame; safe trim point. */
  consumed: number;
  /** True when a preamble was seen and its frame is still arriving: keep buffering. */
  partialFrame: boolean;
  /** Diagnostic events during demodulation. */
  events?: string[];
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
  const events: string[] = [];
  const stateful = state !== undefined;
  let currentLock = state ? state.lock : -1;
  let pos = state ? state.scanned : 0;
  let partialFrame = false;
  let consumed = 0;
  while (true) {
    let start: number;
    if (currentLock >= 0) {
      // Frame in flight: its preamble was already found; decode once its samples
      // arrive (start relative to the buffer, may be negative while preamble ends).
      start = currentLock - preLen;
    } else {
      start = findChirpFrom(samples, chirpTemplate(baseHz), baseHz, pos);
      if (start >= 0) {
        events.push(`chirp preamble detected (offset: ${start})`);
      }
    }
    if (start < 0) {
      // No sync anywhere: everything except a possibly-growing partial preamble
      // is dead. With a frame in flight (lock active) consume nothing — the
      // preamble itself may still be coming in.
      if (stateful) state.scanned = currentLock >= 0 ? 0 : Math.max(0, samples.length - (preLen - 1));
      break;
    }
    const frameStart = currentLock >= 0 ? currentLock : start + preLen;
    // Header first: 4 bytes (sync x2, seq, len) = 24 repeated-nibble symbols.
    const headerSyms = 4 * 2 * 3;
    const headEnd = frameStart + headerSyms * symN;
    if (headEnd > samples.length) {
      partialFrame = true;
      pos = Math.min(frameStart, start + tmplLen);
      currentLock = frameStart;
      if (stateful) { state.scanned = pos; state.lock = frameStart; }
      break;
    }
    const headerNibbles: number[] = [];
    for (let w = frameStart; w < headEnd; w += symN) {
      headerNibbles.push(bestBinDominant(samples, w, symN, baseHz));
    }
    const header = deRepeat(headerNibbles);
    if (header.length < 6) {
      pos = frameStart + symN;
      currentLock = -1;
      if (stateful) state.lock = -1;
      continue;
    }
    const syncCheck = header.length >= 8 && (header[0]! | (header[1]! << 4)) === 0xa5 && (header[2]! | (header[3]! << 4)) === 0x5a;
    if (!syncCheck) {
      events.push("sync check failed (header corrupted)");
      pos = frameStart + symN;
      currentLock = -1;
      if (stateful) state.lock = -1;
      continue;
    }
    events.push("header locked (sync 0xa55a ok)");
    const headerBytes = new Uint8Array(header.length / 2);
    for (let i = 0; i < headerBytes.length; i++) {
      headerBytes[i] = header[2 * i]! | (header[2 * i + 1]! << 4);
    }
    const len = headerBytes[3]!;
    if (len > MAX_PAYLOAD) {
      events.push(`invalid payload length ${len} > ${MAX_PAYLOAD}`);
      pos = frameStart + symN;
      currentLock = -1;
      if (stateful) state.lock = -1;
      continue;
    }
    const totalSyms = (6 + len) * 2 * 3; // 4 header + len payload + 2 crc
    const frameEnd = frameStart + totalSyms * symN;
    if (frameEnd > samples.length + symN) {
      partialFrame = true;
      currentLock = frameStart;
      if (stateful) { state.scanned = frameStart; state.lock = frameStart; }
      pos = Math.min(frameStart, start + tmplLen);
      break;
    }
    const nibbles: number[] = [];
    for (let w = frameStart; w < frameEnd; w += symN) {
      nibbles.push(bestBinDominant(samples, w, symN, baseHz));
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
    currentLock = -1;
    if (stateful) state.lock = -1;
    if (pos >= samples.length) break;
  }
  // On a partial frame, report consumed=0 so the caller keeps the whole
  // buffer (rescan next call; state.scanned keeps that rescan incremental).
  consumed = partialFrame ? 0 : pos;
  return { frames: out, consumed, partialFrame, events };
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
