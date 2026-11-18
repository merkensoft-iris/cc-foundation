/**
 * The core's job scheduler (04 §3: rhythm, backups, the ticket run and the endpoint watchdog
 * run here). It reads time only from the injected clock, so tests advance a fake clock
 * instead of waiting (09 P1-04).
 *
 * Rules:
 * 1. Runs of one job never overlap. A tick that falls due while the previous run is still
 *    going is skipped and counted, never queued.
 * 2. A failing run is logged and recorded; the job keeps its schedule.
 * 3. Repeating jobs keep a fixed rate: the next run is due one interval after the previous
 *    due time, not after the previous run ended. Ticks missed while the process was
 *    suspended collapse into one run.
 * 4. A planned job (`plan`) is due when its `next` function says: asked when it is added,
 *    after each run ends, and on `replan`. The rhythm jobs (rhythm-jobs.ts) are planned jobs:
 *    their due times come from the records.
 * 5. A due time beyond the longest timer a platform keeps (about 24.8 days) is reached in
 *    steps; a timer that fires before its due time only re-arms.
 */
import type { Clock, TimerHandle } from './clock.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

/** A job receives the instant it was due. */
export type Job = (dueAt: Date) => Promise<void> | void;

/** A planned job's next due time after `now`, or undefined when nothing is due until a replan. */
export type NextDue = (now: Date) => Date | undefined;

/** Node keeps a timer for at most 2^31 - 1 ms; a longer delay would fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface JobStatus {
  readonly name: string;
  readonly runs: number;
  readonly failures: number;
  /** Ticks skipped because the previous run had not finished (rule 1). */
  readonly skipped: number;
  readonly running: boolean;
  readonly lastRunAt?: Date;
  readonly lastError?: string;
  /** Absent once a one-off job has run or a job is cancelled. */
  readonly nextDueAt?: Date;
}

interface Entry {
  readonly name: string;
  readonly job: Job;
  readonly intervalMs: number | undefined;
  readonly next: NextDue | undefined;
  nextDueAt: Date | undefined;
  timer: TimerHandle | undefined;
  running: Promise<void> | undefined;
  runs: number;
  failures: number;
  skipped: number;
  lastRunAt: Date | undefined;
  lastError: string | undefined;
}

export interface SchedulerOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #entries = new Map<string, Entry>();
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Runs `job` every `intervalMs`, first after one interval, or at once with
   * `{ immediate: true }`.
   */
  every(name: string, intervalMs: number, job: Job, options: { immediate?: boolean } = {}): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`Job ${name}: the interval must be a positive number of milliseconds`);
    }
    const now = this.#clock.now().getTime();
    this.#add(name, job, { intervalMs }, new Date(options.immediate ? now : now + intervalMs));
  }

  /** Runs `job` once at `when` (at once if `when` has passed). */
  at(name: string, when: Date, job: Job): void {
    this.#add(name, job, {}, when);
  }

  /**
   * Runs `job` at the instants `next` gives (rule 4): `next(now)` is asked now, after each run
   * ends and on `replan`. An instant that has passed runs at once.
   */
  plan(name: string, next: NextDue, job: Job): void {
    this.#add(name, job, { next }, undefined);
    this.replan(name);
  }

  /**
   * Asks a planned job for its next due time again, after a change that may bring it closer.
   * A job that is running plans its next run when the run ends.
   */
  replan(name: string): void {
    const entry = this.#entries.get(name);
    if (entry?.next === undefined || entry.running !== undefined || this.#stopped) return;
    if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.nextDueAt = this.#nextOf(entry, entry.next);
    this.#arm(entry);
  }

  /** A planned job's next due time; a failing `next` is logged and plans nothing (rule 2). */
  #nextOf(entry: Entry, next: NextDue): Date | undefined {
    try {
      return next(this.#clock.now());
    } catch (error) {
      entry.failures += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.#logger.error('scheduler.plan_failed', { job: entry.name, error: entry.lastError });
      return undefined;
    }
  }

  /** Stops a job's future runs; a run in progress finishes. */
  cancel(name: string): void {
    const entry = this.#entries.get(name);
    if (entry === undefined) return;
    if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.nextDueAt = undefined;
    this.#entries.delete(name);
  }

  status(name: string): JobStatus | undefined {
    const entry = this.#entries.get(name);
    if (entry === undefined) return undefined;
    return {
      name: entry.name,
      runs: entry.runs,
      failures: entry.failures,
      skipped: entry.skipped,
      running: entry.running !== undefined,
      ...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
      ...(entry.nextDueAt === undefined ? {} : { nextDueAt: entry.nextDueAt }),
    };
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  /** Cancels every timer and waits for the runs in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const running: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.nextDueAt = undefined;
      if (entry.running !== undefined) running.push(entry.running);
    }
    await Promise.all(running);
  }

  #add(
    name: string,
    job: Job,
    kind: { intervalMs?: number; next?: NextDue },
    dueAt: Date | undefined,
  ): void {
    if (this.#stopped) throw new Error(`Scheduler stopped; cannot add job ${name}`);
    if (this.#entries.has(name)) throw new Error(`Job ${name} is already scheduled`);
    const entry: Entry = {
      name,
      job,
      intervalMs: kind.intervalMs,
      next: kind.next,
      nextDueAt: dueAt,
      timer: undefined,
      running: undefined,
      runs: 0,
      failures: 0,
      skipped: 0,
      lastRunAt: undefined,
      lastError: undefined,
    };
    this.#entries.set(name, entry);
    this.#arm(entry);
  }

  #arm(entry: Entry): void {
    if (entry.nextDueAt === undefined || this.#stopped) return;
    const delay = Math.max(0, entry.nextDueAt.getTime() - this.#clock.now().getTime());
    entry.timer = this.#clock.setTimeout(() => this.#fire(entry), Math.min(delay, MAX_TIMER_MS));
  }

  #fire(entry: Entry): void {
    entry.timer = undefined;
    const dueAt = entry.nextDueAt;
    if (dueAt === undefined || this.#entries.get(entry.name) !== entry) return;
    // Rule 5: a capped timer fired before the due time; wait the rest.
    if (this.#clock.now().getTime() < dueAt.getTime()) {
      this.#arm(entry);
      return;
    }

    if (entry.next !== undefined) {
      // Rule 4: the next due time is asked for when this run ends.
      entry.nextDueAt = undefined;
    } else if (entry.intervalMs === undefined) {
      entry.nextDueAt = undefined;
    } else {
      // Fixed rate (rule 3): skip whole intervals that already passed.
      const now = this.#clock.now().getTime();
      let next = dueAt.getTime() + entry.intervalMs;
      if (next <= now) next += Math.ceil((now - next + 1) / entry.intervalMs) * entry.intervalMs;
      entry.nextDueAt = new Date(next);
    }

    if (entry.running !== undefined) {
      entry.skipped += 1;
      this.#logger.warn('scheduler.skipped', { job: entry.name, dueAt: dueAt.toISOString() });
    } else {
      const run: Promise<void> = this.#run(entry, dueAt).finally(() => {
        if (entry.running === run) entry.running = undefined;
        if (this.#entries.get(entry.name) !== entry) return;
        if (entry.next !== undefined) {
          this.replan(entry.name);
        } else if (entry.intervalMs === undefined) {
          this.#entries.delete(entry.name);
        }
      });
      entry.running = run;
    }
    this.#arm(entry);
  }

  async #run(entry: Entry, dueAt: Date): Promise<void> {
    entry.lastRunAt = this.#clock.now();
    try {
      await entry.job(dueAt);
      entry.lastError = undefined;
    } catch (error) {
      entry.failures += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.#logger.error('scheduler.failed', { job: entry.name, error: entry.lastError });
    } finally {
      entry.runs += 1;
    }
  }
}
