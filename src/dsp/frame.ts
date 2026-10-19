import { crc16 } from "./crc";

export const MAX_PAYLOAD = 64;
const SYNC = [0xa5, 0x5a];

export function encodeFrame(seq: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`payload exceeds ${MAX_PAYLOAD} bytes`);
  }
  const bytes = new Uint8Array(SYNC.length + 2 + payload.length + 2);
  bytes.set(SYNC);
  bytes[2] = seq;
  bytes[3] = payload.length;
  bytes.set(payload, SYNC.length + 2);
  const crc = crc16(bytes.subarray(0, SYNC.length + 2 + payload.length));
  bytes[bytes.length - 2] = crc >> 8;
  bytes[bytes.length - 1] = crc & 0xff;
  return bytes;
}

export interface DecodedFrame {
  seq: number;
  payload: Uint8Array;
}

export function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  if (bytes.length < 6) return null;
  if (bytes[0] !== SYNC[0] || bytes[1] !== SYNC[1]) return null;
  const len = bytes[3]!;
  if (len > MAX_PAYLOAD || bytes.length !== SYNC.length + 2 + len + 2) return null;
  const body = bytes.subarray(0, SYNC.length + 2 + len);
  const stored = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
  if (crc16(body) !== stored) return null;
  return { seq: bytes[2]!, payload: bytes.slice(SYNC.length + 2, SYNC.length + 2 + len) };
}
