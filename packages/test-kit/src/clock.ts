/**
 * The fake clock (08 §8): tests drive time by hand. Pure packages take a clock argument
 * (D4, 08 §4.2); tests pass this one.
 */
export interface FakeClock {
  /** The current instant, RFC 3339 in UTC without fractional seconds. */
  now(): string;
  /** Moves the clock to an instant. */
  set(instant: string): void;
  /** Moves the clock forward and returns the new instant. */
  advance(by: { days?: number; hours?: number; minutes?: number; seconds?: number }): string;
}

function format(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parse(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`not an instant: ${instant}`);
  return ms;
}

export function createFakeClock(start: string): FakeClock {
  let current = parse(start);
  return {
    now: () => format(current),
    set(instant) {
      current = parse(instant);
    },
    advance({ days = 0, hours = 0, minutes = 0, seconds = 0 }) {
      current += (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
      return format(current);
    },
  };
}
