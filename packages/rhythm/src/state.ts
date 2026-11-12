/**
 * The instance state machine (02 §4.2). The table is the diagram, plus two edges the engine
 * needs and the diagram left out (02 §4.2 is updated to show them):
 *
 * - `planned → absorbed`: an instance materialised on a date an absorbing instance already holds,
 *   or absorbed before it reached the calendar (02 §4.3).
 * - `planned → missed`: an instance never prepared (no calendar binding and the app closed over
 *   its pre-read time) is still missed at `scheduledEnd + graceMinutes`.
 *
 * Commands take the instance (and its series where a rule needs it), a caller and the domain
 * context, and return the next record with one event (INV-03-09), as @cc/domain commands do.
 */
import {
  change,
  forbidden,
  invariantError,
  isSystem,
  isUser,
  touched,
  type Caller,
  type Change,
  type DomainContext,
  type Outcome,
} from '@cc/domain';
import type { InstanceState, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { addMinutes, compareInstants } from './time.js';

export const TRANSITIONS: Readonly<Record<InstanceState, readonly InstanceState[]>> = {
  planned: ['scheduled', 'prepared', 'skipped', 'absorbed', 'cancelled', 'missed'],
  scheduled: ['prepared', 'in_progress', 'missed', 'skipped', 'absorbed', 'cancelled'],
  prepared: ['in_progress', 'missed', 'skipped', 'absorbed'],
  in_progress: ['completed'],
  completed: [],
  missed: [],
  skipped: [],
  absorbed: [],
  cancelled: [],
};

/** States a series change may still rewrite (02 §4.1 rule 3). */
export const REWRITABLE: readonly InstanceState[] = ['planned', 'scheduled', 'prepared'];

/** The states of 02 §4.2 that end an instance. */
export const TERMINAL: readonly InstanceState[] = [
  'completed',
  'missed',
  'skipped',
  'absorbed',
  'cancelled',
];

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return TRANSITIONS[from].includes(to);
}

function requireTransition(instance: MeetingInstance, to: InstanceState): void {
  if (!canTransition(instance.state, to)) {
    throw invariantError({
      rule: '02 §4.2',
      message: `${instance.ref} is ${instance.state} and cannot become ${to}`,
    });
  }
}

/** One instance write and its event. */
export function instanceChange(
  ctx: DomainContext,
  caller: Caller,
  before: MeetingInstance | undefined,
  after: MeetingInstance,
  verb: string,
  extra?: Record<string, unknown>,
): Change<MeetingInstance> {
  return change(ctx, {
    kind: 'meeting_instance',
    verb,
    entity: { id: after.id, ref: after.ref },
    before,
    after,
    actor: caller.actor,
    ...(extra === undefined ? {} : { extra }),
  });
}

function transition(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
  to: InstanceState,
  verb: string,
  fields: Partial<MeetingInstance> = {},
): Outcome<MeetingInstance> {
  requireTransition(instance, to);
  const next: MeetingInstance = { ...touched(ctx, instance, caller.actor), ...fields, state: to };
  const write = instanceChange(ctx, caller, instance, next, verb);
  return { status: 'ok', record: next, changes: [write] };
}

function requireSystem(caller: Caller, what: string): void {
  if (!isSystem(caller)) throw forbidden('02 §4.2', `${what} is set by the rhythm engine`);
}

/** `planned → scheduled`: the calendar event was written, or the instance exported to .ics. */
export function markScheduled(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
): Outcome<MeetingInstance> {
  requireSystem(caller, 'scheduled');
  if (instance.state === 'scheduled') return { status: 'no-op', record: instance, changes: [] };
  return transition(ctx, caller, instance, 'scheduled', 'scheduled');
}

/**
 * `→ prepared`: the pre-read is built (preread.ts `applyPreread` records it). From `planned` only when the series has
 * no calendar binding (02 §4.2).
 */
export function markPrepared(
  ctx: DomainContext,
  caller: Caller,
  series: MeetingSeries,
  instance: MeetingInstance,
): Outcome<MeetingInstance> {
  requireSystem(caller, 'prepared');
  if (instance.state === 'prepared') return { status: 'no-op', record: instance, changes: [] };
  if (instance.state === 'planned' && series.calendars.length > 0) {
    throw invariantError({
      rule: '02 §4.2',
      message: `${instance.ref} is not on its calendar yet; only a series with no calendar binding goes from planned to prepared`,
    });
  }
  return transition(ctx, caller, instance, 'prepared', 'prepared');
}

/** Only the user starts a meeting (02 §4.2 rule 1). */
export function startMeeting(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
): Outcome<MeetingInstance> {
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user starts a meeting');
  if (instance.state === 'in_progress') return { status: 'no-op', record: instance, changes: [] };
  return transition(ctx, caller, instance, 'in_progress', 'started', {
    actualStart: ctx.clock.now(),
  });
}

/**
 * `in_progress → completed`, by the user only (02 §4.2 rule 1). The close around it (read-back
 * and C-02-04) is conclude.ts `closeMeeting`; carry counts and escalation join it there (P1-09).
 */
export function completeMeeting(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
): Outcome<MeetingInstance> {
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user concludes a meeting');
  return transition(ctx, caller, instance, 'completed', 'completed', {
    actualEnd: ctx.clock.now(),
  });
}

/** The user skips an instance in advance, with a reason (02 §4.2 rule 4). */
export function skipInstance(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
  reason: string,
): Outcome<MeetingInstance> {
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user skips a meeting');
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw invariantError({ rule: '02 §4.2', message: 'skipping a meeting needs a reason' });
  }
  if (instance.state === 'skipped' && instance.skipReason === trimmed) {
    return { status: 'no-op', record: instance, changes: [] };
  }
  return transition(ctx, caller, instance, 'skipped', 'skipped', { skipReason: trimmed });
}

/** `→ cancelled`: the series ended or changed (02 §4.2), by the rhythm engine. */
export function cancelInstance(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
): Outcome<MeetingInstance> {
  requireSystem(caller, 'cancelled');
  if (instance.state === 'cancelled') return { status: 'no-op', record: instance, changes: [] };
  return transition(ctx, caller, instance, 'cancelled', 'cancelled');
}

/** When an instance not started becomes missed: `scheduledEnd + graceMinutes` (02 §4.2 rule 2). */
export function missedAt(series: Pick<MeetingSeries, 'graceMinutes'>, instance: MeetingInstance) {
  return addMinutes(instance.scheduledEnd, series.graceMinutes);
}

/** Whether the scheduler should mark the instance missed at `now`. */
export function isDueMissed(
  series: Pick<MeetingSeries, 'graceMinutes'>,
  instance: MeetingInstance,
  now: string,
): boolean {
  return (
    instance.actualStart === undefined &&
    canTransition(instance.state, 'missed') &&
    compareInstants(now, missedAt(series, instance)) >= 0
  );
}
