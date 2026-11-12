/**
 * The clock the core runs on. Schedulers and timeouts take it as a parameter, so tests drive
 * them with a fake clock (09 P1-04: schedulers on an injected clock; `FakeTimerClock` in
 * @cc/test-kit has the same shape).
 */

/** An opaque timer handle returned by `Clock.setTimeout`. */
export type TimerHandle = unknown;

export interface Clock {
  /** The current instant. */
  now(): Date;
  /** Calls `callback` once, `ms` milliseconds from now. */
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock. Its timers are unref'd, so a pending job never keeps the process alive. */
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
