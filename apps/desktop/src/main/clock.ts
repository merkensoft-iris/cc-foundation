/**
 * The clock main runs on: the same shape as `@cc/core`'s `Clock`, so tests drive the
 * notification gate and the core supervisor's backoff with a fake one.
 */
export type TimerHandle = unknown;

export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock. Timers are unref'd: a pending timer never keeps main alive. */
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
