/**
 * A fake clock with timers, for code that takes its clock as a parameter (D4; the core's
 * schedulers, 09 P1-04). Time moves only when a test calls `advance` or `advanceTo`; due timers fire in
 * time order, each at its own instant, and pending promise work settles between them.
 *
 * Structurally the same as `Clock` in @cc/core, so test-kit needs no import from it.
 */

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

/** Lets promise chains and I/O callbacks that are already due run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeTimerClock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, Timer>();

  constructor(start: Date | string) {
    this.#now = new Date(start).getTime();
    if (Number.isNaN(this.#now)) throw new RangeError(`Invalid start time: ${String(start)}`);
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { id, at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle);
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(new Date(this.#now + ms));
  }

  /** Moves time forward to `when`, firing every timer that falls due on the way. */
  async advanceTo(when: Date | string): Promise<void> {
    const target = new Date(when).getTime();
    if (target < this.#now) throw new RangeError('A fake clock never moves backwards');
    for (;;) {
      await settle();
      const next = [...this.#timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) break;
      this.#timers.delete(next.id);
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
    await settle();
  }
}
