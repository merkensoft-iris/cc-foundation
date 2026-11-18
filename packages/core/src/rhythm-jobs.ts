/**
 * The rhythm engine's jobs on the core's scheduler (04 §3; 02 §4.1 rule 2, §4.2 rule 2, §4.7,
 * §7.2 rule 1). The jobs are the existing functions: `extendHorizon` and `runMissedCheck` of
 * @cc/rhythm (engine.ts), and `runPrereads` and `escalate` of `Meetings`. This module only
 * decides when they run.
 *
 * | Job | Scheduler job | When | Spec |
 * |---|---|---|---|
 * | horizon extension (`system:rhythm`) | `rhythm-nightly` | daily at 00:05 in the workspace zone | 02 §4.1 rule 2 |
 * | escalation run (`system:escalation`) | `rhythm-nightly`, after the extension | nightly, 00:05 | 02 §7.2 rule 1 |
 * | missed check (`system:scheduler`) | `rhythm-meetings` | each instance's end + `graceMinutes` | 02 §4.2 rule 2 |
 * | pre-read | `rhythm-meetings`, after the missed check | each instance's start − `prereadLeadMinutes` | 02 §4.7, §6.2 |
 *
 * Rules:
 * 1. Both are planned jobs (scheduler.ts rule 4): each asks the records for its next due time
 *    after every run, so a fake clock that moves a month runs every job the month holds, each
 *    at its own instant, and nothing polls in between.
 * 2. The nightly job runs at 00:05 only, as 02 §4.1 rule 2 says: a night the app was closed
 *    over is not run at start. A laptop asleep at 00:05 runs it once on waking (scheduler.ts
 *    rule 3). Both jobs are idempotent: a second run the same night changes nothing.
 * 3. The meetings job is due at the earliest pre-read or missed time of an instance that is
 *    still waiting for one, and not yet seen by a run. A time that passed while the app was
 *    closed is due at start. A run that fails leaves its due times behind it, so a failing
 *    instance is retried at the next due time or replan, never in a loop.
 * 4. Nothing else writes series or adds instances in P1 except the onboarding commit and the
 *    horizon extension; both replan the meetings job (`replan`), and the commit, which sets
 *    the workspace time zone, replans the nightly job too. A later write that removes a
 *    due time (a start, a skip) leaves a run that finds nothing to do.
 * 5. Each extension and missed check is one store command (03 §12 point 4): the engine
 *    function runs over the command's own snapshot, and its writes commit with it.
 */
import type { Change } from '@cc/domain';
import {
  addDays,
  addMinutes,
  canBuildPreread,
  compareInstants,
  extendHorizon,
  localDate,
  missedAt,
  RHYTHM_CALLER,
  runMissedCheck,
  SCHEDULER_CALLER,
  TERMINAL,
  canTransition,
  wallClockInstantCompatible,
  type RhythmStore,
} from '@cc/rhythm';
import type { MeetingInstance } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { Clock } from './clock.js';
import { domainContext } from './domain.js';
import type { Logger } from './logger.js';
import type { Meetings } from './meetings.js';
import type { RecordView } from './records.js';
import type { Scheduler } from './scheduler.js';
import type { StoreRecordStore } from './store-records.js';

export const RHYTHM_NIGHTLY_JOB = 'rhythm-nightly';
export const RHYTHM_MEETINGS_JOB = 'rhythm-meetings';
/** 02 §4.1 rule 2: the nightly jobs run at 00:05 in the workspace time zone. */
export const NIGHTLY_AT = '00:05';

export type RhythmJobName = 'horizon' | 'escalation' | 'preread' | 'missed';

/** One rhythm job that did something: when, what it changed, and the issues it raised. */
export interface RhythmRun {
  /** RFC 3339 in UTC, without fractional seconds. */
  readonly at: string;
  readonly job: RhythmJobName;
  /** Instances added, prepared or missed; or items whose escalation level changed. */
  readonly refs: readonly string[];
  /** Issues raised: rhythm escalations (missed) or E2 escalations. */
  readonly issues: readonly string[];
  /** Instances or items to notify the user about (02 §4.7, §7.2 rule 3; delivery is the desktop's). */
  readonly notify: readonly string[];
}

export type RhythmListener = (run: RhythmRun) => void;

export interface RhythmJobsOptions {
  readonly store: Store;
  readonly records: StoreRecordStore;
  readonly meetings: Meetings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly onRun?: RhythmListener;
}

/** The core's handle on its rhythm jobs. */
export interface RhythmJobs {
  /**
   * Asks both jobs for their next due times again, after a write that added instances or set
   * the workspace time zone (the onboarding commit).
   */
  replan(): void;
}

/** An instant as the records write it: RFC 3339 in UTC, without fractional seconds. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function workspaceTimeZone(store: Store): string {
  return store.read((tx) => tx.list('workspace', { limit: 1 })[0]?.timeZone) ?? 'UTC';
}

/** The first 00:05 in the workspace zone strictly after `now`. */
export function nextNightly(now: Date, timeZone: string): Date {
  const at = now.toISOString();
  const today = localDate(at, timeZone);
  let next = wallClockInstantCompatible(`${today}T${NIGHTLY_AT}`, timeZone);
  if (compareInstants(next, at) <= 0) {
    next = wallClockInstantCompatible(`${addDays(today, 1)}T${NIGHTLY_AT}`, timeZone);
  }
  return new Date(next);
}

/** `RhythmStore` over one command's snapshot: its writes go back to the command (rule 5). */
function viewRhythmStore(view: RecordView, changes: Change[]): RhythmStore {
  return {
    listSeries: () => view.tx.list('meeting_series'),
    listInstances(seriesIds) {
      const wanted = new Set<string>(seriesIds);
      return view.tx.list('meeting_instances').filter((i) => wanted.has(i.seriesId));
    },
    openRhythmIssues: () =>
      view.tx
        .list('issues')
        .filter((issue) => issue.status === 'open' && issue.raisedFrom.kind === 'rhythm'),
    commit: (written) => void changes.push(...written),
  };
}

/** The horizon extension (02 §4.1 rule 2), in one command. Returns the instances added. */
export function runHorizonExtension(records: StoreRecordStore, clock: Clock): string[] {
  return records.command(RHYTHM_CALLER.actor, (view) => {
    const changes: Change[] = [];
    extendHorizon(viewRhythmStore(view, changes), domainContext(view, clock));
    return {
      result: changes
        .filter((change) => change.kind === 'meeting_instance')
        .map((change) => (change.record as MeetingInstance).ref),
      changes,
    };
  });
}

/** The missed check (02 §4.2 rules 2 and 3), in one command. */
export function runMissedJob(
  records: StoreRecordStore,
  clock: Clock,
): { missed: string[]; issues: string[] } {
  return records.command(SCHEDULER_CALLER.actor, (view) => {
    const changes: Change[] = [];
    const result = runMissedCheck(viewRhythmStore(view, changes), domainContext(view, clock));
    return {
      result: {
        missed: changes
          .filter((c) => c.kind === 'meeting_instance')
          .map((c) => c.record as MeetingInstance)
          .filter((instance) => instance.state === 'missed')
          .map((instance) => instance.ref),
        issues: result.escalations.map((escalation) => escalation.issue.ref),
      },
      changes,
    };
  });
}

/**
 * The due times of the meetings job (rule 3): each instance's pre-read time while it can still
 * get one, and its missed time while it can still be missed.
 */
function meetingDueTimes(store: Store): string[] {
  return store.read((tx) => {
    const series = new Map(tx.list('meeting_series').map((s) => [s.id as string, s]));
    return tx.list('meeting_instances').flatMap((instance) => {
      const owner = series.get(instance.seriesId);
      if (owner === undefined || instance.actualStart !== undefined) return [];
      if (TERMINAL.includes(instance.state)) return [];
      const due: string[] = [];
      if (
        owner.status === 'active' &&
        instance.preread === undefined &&
        canBuildPreread(owner, instance)
      ) {
        due.push(addMinutes(instance.scheduledStart, -owner.prereadLeadMinutes));
      }
      if (canTransition(instance.state, 'missed')) due.push(missedAt(owner, instance));
      return due;
    });
  });
}

/** Schedules the rhythm jobs on the core's scheduler. */
export function scheduleRhythmJobs(scheduler: Scheduler, options: RhythmJobsOptions): RhythmJobs {
  const { store, records, meetings, clock, logger } = options;
  const emit = (job: RhythmJobName, refs: readonly string[], more: Partial<RhythmRun> = {}) => {
    const run: RhythmRun = {
      at: rfc3339(clock.now()),
      job,
      refs,
      issues: more.issues ?? [],
      notify: more.notify ?? [],
    };
    if (run.refs.length === 0 && run.issues.length === 0 && run.notify.length === 0) return;
    logger.info('rhythm.ran', { job, refs: run.refs.length, issues: run.issues.length });
    options.onRun?.(run);
  };

  // Rule 2: at 00:05 in the workspace zone, which the onboarding commit sets (UTC before it).
  scheduler.plan(
    RHYTHM_NIGHTLY_JOB,
    (now) => nextNightly(now, workspaceTimeZone(store)),
    () => {
      emit('horizon', runHorizonExtension(records, clock));
      const escalation = meetings.escalate();
      emit(
        'escalation',
        escalation.escalated.map((entry) => entry.ref),
        { issues: escalation.issues.map((issue) => issue.ref), notify: escalation.notify },
      );
      scheduler.replan(RHYTHM_MEETINGS_JOB);
    },
  );

  // Rule 3: due times after the last run; one that passed before it is the run's.
  let lastRun: string | undefined;
  scheduler.plan(
    RHYTHM_MEETINGS_JOB,
    (now) => {
      const pending = meetingDueTimes(store).filter(
        (at) => lastRun === undefined || compareInstants(at, lastRun) > 0,
      );
      if (pending.length === 0) return undefined;
      const earliest = pending.reduce((a, b) => (compareInstants(a, b) <= 0 ? a : b));
      return compareInstants(earliest, now.toISOString()) <= 0 ? now : new Date(earliest);
    },
    () => {
      lastRun = clock.now().toISOString();
      const missed = runMissedJob(records, clock);
      emit('missed', missed.missed, { issues: missed.issues });
      const prereads = meetings.runPrereads();
      emit('preread', prereads.prepared, { notify: prereads.notify });
    },
  );

  return {
    replan: () => {
      scheduler.replan(RHYTHM_NIGHTLY_JOB);
      scheduler.replan(RHYTHM_MEETINGS_JOB);
    },
  };
}
