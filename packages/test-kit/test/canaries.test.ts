import { describe, expect, it } from 'vitest';

import { CANARY_PREFIX, makeCanary } from '@cc/test-kit';

describe('makeCanary', () => {
  it('makes a fresh canary with the shared prefix on every call', () => {
    const first = makeCanary('person');
    const second = makeCanary('person');
    expect(first.startsWith(`${CANARY_PREFIX}person_`)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('rejects a label outside [a-z0-9]+', () => {
    expect(() => makeCanary('Not OK')).toThrow(/label/);
  });
});
