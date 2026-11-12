/**
 * Record IDs: `<prefix>_<ULID>` (03 §3). The time part comes from the injected clock, so IDs
 * made under a fake clock sort in fake-clock order.
 */
import { randomBytes } from 'node:crypto';

import type { Clock } from './clock.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A 26-character ULID: 48 bits of milliseconds, then 80 random bits, Crockford base32. */
export function ulid(clock: Clock): string {
  let time = clock.now().getTime();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomPart = '';
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD.charAt((random[i] ?? 0) % 32);
  return timePart + randomPart;
}

export function newId<P extends string>(prefix: P, clock: Clock): `${P}_${string}` {
  return `${prefix}_${ulid(clock)}`;
}
