/**
 * The rhythm engine's scheduled jobs as the scenario sees them (02 §4.1 rule 2, §4.2 rule 2,
 * §4.7, §7.2 rule 1; 08 §8 item 3).
 *
 * The core runs the jobs on its own scheduler (`@cc/core` rhythm-jobs.ts), on the scenario's
 * fake clock:
 *
 * | Job | When | Spec |
 * |---|---|---|
 * | horizon extension | daily at 00:05 in the workspace zone | 02 §4.1 rule 2 |
 * | escalation run (`system:escalation`) | nightly, 00:05 in the workspace zone | 02 §7.2 rule 1 |
 * | pre-read | each instance's start − `prereadLeadMinutes` | 02 §4.7, §6.2 |
 * | missed check (`system:scheduler`) | each instance's end + `graceMinutes` | 02 §4.2 rule 2 |
 *
 * `advanceTo` only moves the clock; the core's timers fire on the way, each at its own instant.
 * The core reports each job that changed something (`CoreOptions.onRhythmRun`), and `log` keeps
 * those reports, so a test sees what ran, when, and what it did.
 */
import {
  runHorizonExtension,
  type CoreService,
  type RhythmJobName,
  type RhythmRun,
} from '@cc/core';
import { compareInstants } from '@cc/rhythm';

import type { FakeTimerClock } from '../fake-timer-clock.js';

export { NIGHTLY_AT } from '@cc/core';

export type JobName = RhythmJobName;

/** One job that did something, with when and what. */
export type JobRun = RhythmRun;

export class RhythmJobs {
  readonly #core: CoreService;
  readonly #clock: FakeTimerClock;
  /** Every job that did something, oldest first, as the core reported it. */
  readonly log: JobRun[];

  /** `log` is the array the core's `onRhythmRun` listener fills. */
  constructor(core: CoreService, clock: FakeTimerClock, log: JobRun[]) {
    this.#core = core;
    this.#clock = clock;
    this.log = log;
  }

  /**
   * Moves the clock to `instant`; the core's scheduler runs every job that falls due on the way
   * at its own time. Returns the runs that did something.
   */
  async advanceTo(instant: string): Promise<JobRun[]> {
    const from = this.log.length;
    if (compareInstants(this.#clock.now().toISOString(), new Date(instant).toISOString()) < 0) {
      await this.#clock.advanceTo(instant);
    }
    return this.log.slice(from);
  }

  /**
   * The horizon extension on demand, as the nightly job runs it (02 §4.1 rule 2). Idempotent
   * (C-02-02): returns the instances it added.
   */
  extendHorizon(): readonly string[] {
    return runHorizonExtension(this.#core.records, this.#clock);
  }
}
