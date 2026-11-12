/**
 * ULIDs for the event log: 03 §5.10 requires event order to equal ID order, so the id of an
 * `events` row is `evt_<ULID>` - 48 bits of millisecond timestamp followed by 80 random
 * bits, in Crockford base32, monotonic inside one millisecond.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

/** Source of the 80 random bits; tests pass a deterministic one. */
export type RandomBytes = (size: number) => Uint8Array;

function encodeTime(ms: number): string {
  let rest = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i++) {
    out = `${ALPHABET[rest % 32] ?? '0'}${out}`;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes -> 80 bits -> 16 base32 characters, read 5 bits at a time.
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = `${ALPHABET[Number(bits & 31n)] ?? '0'}${out}`;
    bits >>= 5n;
  }
  return out;
}

/** Increments a Crockford base32 string by one, carrying left; wraps to all zeros. */
function increment(text: string): string {
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = ALPHABET.indexOf(chars[i] ?? '0') + 1;
    if (next < 32) {
      chars[i] = ALPHABET[next] ?? '0';
      return chars.join('');
    }
    chars[i] = '0';
  }
  return chars.join('');
}

export interface UlidFactory {
  (atMs: number): string;
}

/**
 * A monotonic ULID generator: two ULIDs made in the same millisecond still sort in the order
 * they were made, so `events.id` orders the log even under a burst of writes.
 */
export function createUlidFactory(random: RandomBytes = randomBytes): UlidFactory {
  let lastTime = -1;
  let lastRandom = '';
  return (atMs: number): string => {
    const time = Math.max(atMs, lastTime);
    if (time === lastTime) {
      lastRandom = increment(lastRandom);
    } else {
      lastTime = time;
      lastRandom = encodeRandom(random(RANDOM_BYTES));
    }
    return `${encodeTime(time)}${lastRandom}`;
  };
}

/** The `evt_<ULID>` ID of an event row (03 §3). */
export function eventId(ulid: string): `evt_${string}` {
  return `evt_${ulid}`;
}
