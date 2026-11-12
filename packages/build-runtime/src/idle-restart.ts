/**
 * The idle restart after Rebuild now (04 §10 rule 2): main restarts core and the renderer
 * on the new build when the app is idle, meaning no meeting `in_progress` and no run in
 * flight. The shell supplies the idle test (from core) and the restart (relaunching on the
 * new build); this waits for the first idle moment and restarts once.
 *
 * TODO(P1-10): wire `isIdle` to core and `restart` to `app.relaunch` on the new build.
 */
export interface IdleRestartOptions {
  /** True when no meeting is in progress and no run is in flight. */
  readonly isIdle: () => boolean | Promise<boolean>;
  readonly restart: () => void | Promise<void>;
  /** How long to wait between idle checks; default 30 s. */
  readonly intervalMs?: number;
  /** The wait between checks; default a timer. Tests pass a fake. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Aborting gives up the pending restart (the user chose Later, or the app is quitting). */
  readonly signal?: AbortSignal;
}

export const IDLE_POLL_MS = 30_000;

const timerWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function restartWhenIdle(
  options: IdleRestartOptions,
): Promise<'restarted' | 'aborted'> {
  const wait = options.wait ?? timerWait;
  const interval = options.intervalMs ?? IDLE_POLL_MS;
  const aborted = (): boolean => options.signal?.aborted === true;
  for (;;) {
    if (aborted()) return 'aborted';
    if (await options.isIdle()) {
      if (aborted()) return 'aborted';
      await options.restart();
      return 'restarted';
    }
    await wait(interval);
  }
}
