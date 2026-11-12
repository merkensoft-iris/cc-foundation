import { randomBytes } from 'node:crypto';

/**
 * Prefix of every canary value (06 AC-06-02). Canaries are made at run time with
 * `makeCanary()`; a committed file that contains one fails the canary denylist scan
 * (`pnpm scan:canaries`, AC-08-07).
 */
export const CANARY_PREFIX = 'cc_canary_';

/** Returns a fresh canary such as `<prefix>person_1a2b3c4d5e6f`. */
export function makeCanary(label: string): string {
  if (!/^[a-z0-9]+$/.test(label)) {
    throw new Error(`Canary label must match [a-z0-9]+, got "${label}"`);
  }
  return `${CANARY_PREFIX}${label}_${randomBytes(6).toString('hex')}`;
}
