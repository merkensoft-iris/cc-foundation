import { describe, expect, it } from 'vitest';

import { createFakeClock } from '@cc/test-kit';

describe('fake clock (08 §8)', () => {
  it('starts where it is told and moves only when moved', () => {
    const clock = createFakeClock('2026-11-13T09:30:00Z');
    expect(clock.now()).toBe('2026-11-13T09:30:00Z');
    expect(clock.now()).toBe('2026-11-13T09:30:00Z');
    expect(clock.advance({ days: 1, hours: 2, minutes: 3, seconds: 4 })).toBe(
      '2026-11-14T11:33:04Z',
    );
    clock.set('2026-12-04T00:00:00.000Z');
    expect(clock.now()).toBe('2026-12-04T00:00:00Z');
  });

  it('refuses a value that is not an instant', () => {
    expect(() => createFakeClock('next Friday')).toThrow(/not an instant/);
  });
});
