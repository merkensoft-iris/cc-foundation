/**
 * The rhythm engine's scheduled jobs on the scenario's fake clock (02 §4.1 rule 2, §4.2 rule 2,
 * §4.7, §7.2 rule 1; 08 §8 item 3).
 *
 * The core's scheduler runs only the endpoint watchdog today: the horizon extension, the pre-read
 * job, the missed check and the nightly escalation run exist as functions of @cc/rhythm and
 * `Meetings` of @cc/core, but nothing schedules them yet. Until the core does, the scenario
 * runs each one at the time its spec gives, over the core's own store and records, through the
 * same functions the core would call:
 *
 * | Job | When | Spec |
 * |---|---|---|
 * | horizon extension | daily at 00:05 in the workspace zone | 02 §4.1 rule 2 |
 * | escalation run (`system:escalation`) | nightly, 00:05 in the workspace zone | 02 §7.2 rule 1 |
 * | pre-read | each instance's start − `prereadLeadMinutes` | 02 §4.7, §6.2 |
 * | missed check (`system:scheduler`) | each instance's end + `graceMinutes` | 02 §4.2 rule 2 |
 *
 * `advanceTo` moves the fake clock from one due time to the next and runs what falls due at
 * each, so a test that moves the clock a month sees every job the month holds, in order. When
 * the core schedules these jobs itself, `advanceTo` reduces to moving the clock.
 */
import { domainContext, Meetings, storeRhythmStore, type CoreService } from '@cc/core';
import {
  addDays,
  addMinutes,
  compareInstants,
  isDuePreread,
  localDate,
  markMissed,
  materialise,
  missedAt,
  RHYTHM_CALLER,
  SCHEDULER_CALLER,
  TERMINAL,
  wallClockInstantCompatible,
  type EscalationResult,
} from '@cc/rhythm';
import type { MeetingInstance, MeetingSeries } from '@cc/schemas';

import type { FakeTimerClock } from '../fake-timer-clock.js';

/** 02 §4.1 rule 2: the nightly jobs run at 00:05 in the workspace zone. */
export const NIGHTLY_AT = '00:05';

export type JobName = 'horizon' | 'escalation' | 'preread' | 'missed';

/** One job that did something, with when and what. */
export interface JobRun {
  readonly at: string;
  readonly job: JobName;
  /** Instance refs prepared or marked missed, or items whose escalation level changed. */
  readonly refs: readonly string[];
  /** Issues the job raised (E2 escalations, rhythm escalations). */
  readonly issues: readonly string[];
}

/** An instant as the records write it: RFC 3339 in UTC, without fractional seconds. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class RhythmJobs {
  readonly #core: CoreService;
  readonly #clock: FakeTimerClock;
  readonly #meetings: Meetings;
  readonly #zone: () => string;
  /** Every job that did something, oldest first. */
  readonly log: JobRun[] = [];

  constructor(core: CoreService, clock: FakeTimerClock, timeZone: () => string) {
    this.#core = core;
    this.#clock = clock;
    this.#meetings = new Meetings(core.store, { clock });
    this.#zone = timeZone;
  }

  /**
   * Moves the clock to `instant`, running every job that falls due on the way at its own
   * time. Returns the runs that did something.
   */
  async advanceTo(instant: string): Promise<JobRun[]> {
    const target = new Date(instant).toISOString();
    const from = this.log.length;
    for (;;) {
      const now = this.#clock.now().toISOString();
      const next = this.#nextDue(now);
      if (next === undefined || compareInstants(next.at, target) > 0) break;
      await this.#clock.advanceTo(next.at);
      this.#runDue(next.nightly);
    }
    if (compareInstants(this.#clock.now().toISOString(), target) < 0) {
      await this.#clock.advanceTo(target);
    }
    return this.log.slice(from);
  }

  /** The next instant after `now` at which a job falls due, and whether it is the nightly one. */
  #nextDue(now: string): { at: string; nightly: boolean } | undefined {
    const zone = this.#zone();
    const today = localDate(now, zone);
    let nightly = wallClockInstantCompatible(`${today}T${NIGHTLY_AT}`, zone);
    if (compareInstants(nightly, now) <= 0) {
      nightly = wallClockInstantCompatible(`${addDays(today, 1)}T${NIGHTLY_AT}`, zone);
    }
    let next = nightly;
    for (const { series, instance } of this.#instances()) {
      if (TERMINAL.includes(instance.state) || instance.actualStart !== undefined) continue;
      for (const at of [
        addMinutes(instance.scheduledStart, -series.prereadLeadMinutes),
        missedAt(series, instance),
      ]) {
        if (compareInstants(at, now) > 0 && compareInstants(at, next) < 0) next = at;
      }
    }
    return { at: next, nightly: next === nightly };
  }

  #instances(): { series: MeetingSeries; instance: MeetingInstance }[] {
    const rhythm = storeRhythmStore(this.#core.store);
    const series = new Map(rhythm.listSeries().map((s) => [s.id as string, s]));
    return rhythm.listInstances([...series.keys()]).flatMap((instance) => {
      const owner = series.get(instance.seriesId);
      return owner === undefined ? [] : [{ series: owner, instance }];
    });
  }

  #runDue(nightly: boolean): void {
    if (nightly) this.extendHorizon();
    this.markMissed();
    this.runPrereads();
    if (nightly) this.escalate();
  }

  #record(job: JobName, refs: readonly string[], issues: readonly string[] = []): void {
    if (refs.length === 0 && issues.length === 0) return;
    this.log.push({ at: rfc3339(this.#clock.now()), job, refs, issues });
  }

  /** The horizon extension (02 §4.1 rule 2), actor `system:rhythm`. Idempotent (C-02-02). */
  extendHorizon(): readonly string[] {
    const added = this.#core.records.command(RHYTHM_CALLER.actor, (view) => {
      const result = materialise(domainContext(view, this.#clock), RHYTHM_CALLER, {
        series: view.tx.list('meeting_series'),
        instances: view.tx.list('meeting_instances'),
      });
      return { result: result.changes.map((c) => c.record.ref), changes: result.changes };
    });
    this.#record('horizon', added);
    return added;
  }

  /** The missed check (02 §4.2 rules 2 and 3), actor `system:scheduler`. */
  markMissed(): { missed: readonly string[]; issues: readonly string[] } {
    const outcome = this.#core.records.command(SCHEDULER_CALLER.actor, (view) => {
      const { tx } = view;
      const result = markMissed(domainContext(view, this.#clock), SCHEDULER_CALLER, {
        series: tx.list('meeting_series'),
        instances: tx.list('meeting_instances'),
        openIssues: tx
          .list('issues')
          .filter((issue) => issue.status === 'open' && issue.raisedFrom.kind === 'rhythm'),
      });
      return {
        result: {
          missed: result.changes
            .filter((change) => (change.record as MeetingInstance).state === 'missed')
            .map((change) => (change.record as MeetingInstance).ref),
          issues: result.changes
            .filter((change) => change.kind === 'issue')
            .map((change) => (change.record as { ref: string }).ref),
        },
        changes: result.changes,
      };
    });
    this.#record('missed', outcome.missed, outcome.issues);
    return outcome;
  }

  /** The pre-read job (02 §4.7): every instance whose pre-read time has come. */
  runPrereads(): readonly string[] {
    const { prepared } = this.#meetings.runPrereads();
    this.#record('preread', prepared);
    return prepared;
  }

  /** The nightly escalation run (02 §7.2 rule 1), actor `system:escalation`. */
  escalate(): EscalationResult {
    const result = this.#meetings.escalate();
    this.#record(
      'escalation',
      result.escalated.map((entry) => entry.ref),
      result.issues.map((issue) => issue.ref),
    );
    return result;
  }

  /** Whether an instance's pre-read is due now (for tests that check the job's timing). */
  isPrereadDue(ref: string): boolean {
    const now = this.#clock.now().toISOString();
    const found = this.#instances().find(({ instance }) => instance.ref === ref);
    return found !== undefined && isDuePreread(found.series, found.instance, now);
  }
}
