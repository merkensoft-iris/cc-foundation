/**
 * Missed instances and the rhythm escalation (02 §4.2 rules 2 and 3).
 *
 * The scheduler marks an instance `missed` at `scheduledEnd + graceMinutes` when it was never
 * started; that is final. Its agenda carries into the next instance of the same series
 * (`carriedFrom`, which also keeps what the missed instance had carried in). Two consecutive
 * missed instances of a weekly or slower series raise one rhythm escalation: an issue
 * (`raisedFrom.kind = 'rhythm'`, 03 §11 rule 1) that the daily start's attention list shows, with
 * three options. CC never changes the rhythm by itself.
 *
 * "Consecutive" counts the instances that were due to be held: skipped, absorbed and cancelled
 * instances are not held and do not break or make a run (02 §4.2 rule 4). One escalation is open
 * per series at a time: while it is open, further misses add none.
 */
import {
  forbidden,
  isSystem,
  raiseIssue,
  touched,
  type Caller,
  type Change,
  type DomainContext,
} from '@cc/domain';
import type { Issue, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { CADENCE_RANK } from './absorb.js';
import { instanceChange, isDueMissed, TERMINAL } from './state.js';

/** The three options of 02 §4.2 rule 3, in that order. */
export const RHYTHM_ESCALATION_OPTIONS = [
  'reschedule_series',
  'change_rhythm',
  'pause_workstream',
] as const;
export type RhythmEscalationOption = (typeof RHYTHM_ESCALATION_OPTIONS)[number];

export interface RhythmEscalation {
  readonly seriesId: string;
  /** The two consecutive missed instances, oldest first. */
  readonly missedInstanceIds: readonly [string, string];
  readonly options: readonly RhythmEscalationOption[];
  readonly issue: Issue;
}

export interface MissedResult {
  readonly status: 'ok' | 'no-op';
  readonly changes: readonly Change[];
  readonly instances: readonly MeetingInstance[];
  readonly escalations: readonly RhythmEscalation[];
}

const HELD_OR_DUE = (instance: MeetingInstance) =>
  !['skipped', 'absorbed', 'cancelled'].includes(instance.state);

export function rhythmEscalationTitle(series: Pick<MeetingSeries, 'name'>): string {
  return `${series.name}: two meetings in a row were missed. Reschedule the series, change the rhythm, or pause the workstream.`;
}

/**
 * Marks every instance due at `now` as missed, carries its agenda into the next instance, and
 * raises the rhythm escalations that the misses complete.
 */
export function markMissed(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly series: readonly MeetingSeries[];
    readonly instances: readonly MeetingInstance[];
    /** Open issues; an open rhythm issue for a series suppresses a second escalation. */
    readonly openIssues: readonly Issue[];
  },
): MissedResult {
  if (!isSystem(caller)) throw forbidden('02 §4.2', '`missed` is set by the scheduler');
  const now = ctx.clock.now();
  const current = new Map(input.instances.map((i) => [i.id, i]));
  const changes: Change[] = [];
  const escalations: RhythmEscalation[] = [];
  const write = (before: MeetingInstance, after: MeetingInstance, verb: string) => {
    const record = touched(ctx, after, caller.actor);
    changes.push(instanceChange(ctx, caller, before, record, verb));
    current.set(record.id, record);
  };

  for (const series of input.series) {
    const own = () =>
      [...current.values()]
        .filter((i) => i.seriesId === series.id)
        .sort((a, b) => a.occurrenceStart.localeCompare(b.occurrenceStart));
    const newlyMissed: string[] = [];
    for (const instance of own()) {
      const latest = current.get(instance.id) ?? instance;
      if (!isDueMissed(series, latest, now)) continue;
      write(latest, { ...latest, state: 'missed' }, 'missed');
      newlyMissed.push(latest.id);
      const next = own().find(
        (i) =>
          i.occurrenceStart > latest.occurrenceStart &&
          !TERMINAL.includes(i.state) &&
          i.state !== 'in_progress',
      );
      if (next !== undefined) {
        const carried = [...new Set([...next.carriedFrom, ...latest.carriedFrom, latest.id])];
        write(next, { ...next, carriedFrom: carried }, 'carried_in');
      }
    }
    if (newlyMissed.length === 0 || CADENCE_RANK[series.cadence] < CADENCE_RANK.weekly) continue;
    const held = own().filter(
      (i) => HELD_OR_DUE(i) && TERMINAL.concat(['in_progress']).includes(i.state),
    );
    const [previous, last] = held.slice(-2);
    if (previous?.state !== 'missed' || last?.state !== 'missed') continue;
    if (!newlyMissed.includes(last.id)) continue;
    const open = input.openIssues.some(
      (issue) =>
        issue.status === 'open' &&
        issue.raisedFrom.kind === 'rhythm' &&
        issue.raisedFrom.seriesId === series.id,
    );
    if (open || escalations.some((e) => e.seriesId === series.id)) continue;
    const [workstreamId] = series.workstreamIds;
    if (workstreamId === undefined) continue;
    const raised = raiseIssue(
      ctx,
      caller,
      {
        workstreamId,
        title: rhythmEscalationTitle(series),
        raisedFrom: { kind: 'rhythm', seriesId: series.id },
      },
      last.id,
    );
    changes.push(...raised.changes);
    escalations.push({
      seriesId: series.id,
      missedInstanceIds: [previous.id, last.id],
      options: RHYTHM_ESCALATION_OPTIONS,
      issue: raised.record,
    });
  }
  return {
    status: changes.length === 0 ? 'no-op' : 'ok',
    changes,
    instances: [...current.values()],
    escalations,
  };
}
