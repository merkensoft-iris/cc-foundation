/**
 * Horizon and materialisation (02 §4.1), with absorption (02 §4.3) and CC-to-CC placement
 * (02 §4.6 rule 3) applied to what it materialises.
 *
 * `materialise` takes every series and their current instances and returns the writes that bring
 * the instances in line, one event per changed instance (INV-03-09). Running it again on its own
 * result writes nothing (C-02-02). It is what the daily 00:05 extension and every series change
 * run (02 §4.1 rule 2); the core schedules it.
 *
 * - An instance is matched to its RRULE occurrence by `occurrenceStart`, so a one-off reschedule
 *   never makes a duplicate.
 * - A series change rewrites only future instances in `planned`, `scheduled` or `prepared`
 *   (02 §4.1 rule 3). An instance whose occurrence the new rule no longer produces is rewritten in
 *   place to the new occurrence in the same period (the day for daily series, the ISO week for
 *   weekly and biweekly, the month, quarter or year otherwise), keeping its ID, so calendar events
 *   and .ics UIDs follow it; one with no new occurrence in its period is cancelled (from `planned`
 *   or `scheduled`, 02 §4.2), and a new occurrence with no instance in its period is materialised.
 * - An ended series cancels its future `planned` and `scheduled` instances; a paused series
 *   materialises nothing new and keeps what it has.
 */
import {
  created,
  isSystem,
  forbidden,
  touched,
  type Caller,
  type Change,
  type DomainContext,
} from '@cc/domain';
import type { MeetingInstance, MeetingSeries } from '@cc/schemas';

import { absorbSlots, type Slot } from './absorb.js';
import { horizonOccurrences } from './horizon.js';
import { blockIntervals, resolveOverlaps, type Move, type PlacementContext } from './placement.js';
import { instanceChange, REWRITABLE } from './state.js';
import { addMinutes, compareInstants, isoWeekStart, localDate, minutesBetween } from './time.js';

export interface DstGapWarning {
  readonly code: 'W-DST-GAP';
  readonly seriesId: string;
  /** The local wall-clock time that does not exist in the series zone; that occurrence is omitted. */
  readonly local: string;
}

export interface MaterialiseResult {
  readonly status: 'ok' | 'no-op';
  readonly changes: readonly Change<MeetingInstance>[];
  /** Every instance of the given series after the writes. */
  readonly instances: readonly MeetingInstance[];
  readonly warnings: readonly DstGapWarning[];
  /** Rule 3 moves made (shown to the user, 02 §4.6 rule 3). */
  readonly moves: readonly Move[];
  /** Overlaps between CC meetings no free slot could resolve. */
  readonly unresolved: readonly { readonly id: string; readonly other: string }[];
}

type InstanceId = MeetingInstance['id'];

const EMPTY_OUTPUTS: MeetingInstance['outputs'] = {
  decisionIds: [],
  actionItemIds: [],
  issueIds: [],
  riskIds: [],
  measureValueIds: [],
  goalIds: [],
  statusUpdates: [],
  verifications: [],
};

/** The period an occurrence belongs to, for matching a rewritten instance (02 §9.4 periods). */
export function periodKey(
  series: Pick<MeetingSeries, 'cadence' | 'timeZone'>,
  start: string,
): string {
  const date = localDate(start, series.timeZone);
  switch (series.cadence) {
    case 'daily':
      return date;
    case 'weekly':
    case 'biweekly':
      return isoWeekStart(date);
    case 'monthly':
      return date.slice(0, 7);
    case 'quarterly':
      return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
    case 'yearly':
      return date.slice(0, 4);
  }
}

const isFutureMutable = (instance: MeetingInstance, now: string) =>
  REWRITABLE.includes(instance.state) &&
  instance.actualStart === undefined &&
  compareInstants(instance.occurrenceStart, now) >= 0;

const without = <T extends object, K extends keyof T>(record: T, key: K): Omit<T, K> => {
  const copy = { ...record };
  delete copy[key];
  return copy;
};

/** What the run changes on one instance, before the audit fields. */
interface Working {
  instance: MeetingInstance;
  verb?: string;
}

export function materialise(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly series: readonly MeetingSeries[];
    readonly instances: readonly MeetingInstance[];
    /** For rule 3 moves; without it, overlaps between CC meetings are left as they are. */
    readonly placement?: PlacementContext;
  },
): MaterialiseResult {
  if (!isSystem(caller, 'rhythm')) {
    throw forbidden('02 §4.1', 'materialisation is run by the rhythm engine (system:rhythm)');
  }
  const now = ctx.clock.now();
  const seriesById = new Map(input.series.map((s) => [s.id, s]));
  const working = new Map<string, Working>(
    input.instances.map((instance) => [instance.id, { instance }]),
  );
  const set = (instance: MeetingInstance, verb: string) => {
    const entry = working.get(instance.id);
    working.set(instance.id, { instance, verb: entry?.verb ?? verb });
  };
  const warnings: DstGapWarning[] = [];
  const fresh: { series: MeetingSeries; start: string }[] = [];

  for (const series of input.series) {
    const own = input.instances.filter((i) => i.seriesId === series.id);
    if (series.status === 'ended') {
      for (const instance of own) {
        if (
          (instance.state === 'planned' || instance.state === 'scheduled') &&
          compareInstants(instance.occurrenceStart, now) >= 0
        ) {
          set({ ...instance, state: 'cancelled' }, 'cancelled');
        }
      }
      continue;
    }
    if (series.status !== 'active') continue;
    const expansion = horizonOccurrences(series, now);
    for (const local of expansion.gaps) {
      warnings.push({ code: 'W-DST-GAP', seriesId: series.id, local });
    }
    const byOccurrence = new Map(own.map((i) => [i.occurrenceStart, i]));
    const occurrenceSet = new Set(expansion.occurrences.map((o) => o.start));
    const leftover = own.filter(
      (i) => isFutureMutable(i, now) && !occurrenceSet.has(i.occurrenceStart),
    );
    for (const occurrence of expansion.occurrences) {
      if (byOccurrence.has(occurrence.start)) continue;
      const period = periodKey(series, occurrence.start);
      const index = leftover.findIndex((i) => periodKey(series, i.occurrenceStart) === period);
      const previous = leftover[index];
      if (previous === undefined) {
        fresh.push({ series, start: occurrence.start });
        continue;
      }
      leftover.splice(index, 1);
      set(
        {
          ...without(previous, 'rescheduledFrom'),
          occurrenceStart: occurrence.start,
          scheduledStart: occurrence.start,
          scheduledEnd: addMinutes(occurrence.start, series.durationMinutes),
        },
        'rewritten',
      );
    }
    for (const instance of leftover) {
      if (instance.state === 'planned' || instance.state === 'scheduled') {
        set({ ...instance, state: 'cancelled' }, 'cancelled');
      }
    }
  }

  fresh.sort((a, b) => a.start.localeCompare(b.start) || a.series.id.localeCompare(b.series.id));
  for (const { series, start } of fresh) {
    const instance: MeetingInstance = {
      id: ctx.ids.id('mtg'),
      ref: ctx.ids.ref('M'),
      seriesId: series.id,
      occurrenceStart: start,
      scheduledStart: start,
      scheduledEnd: addMinutes(start, series.durationMinutes),
      state: 'planned',
      agenda: [],
      outputs: EMPTY_OUTPUTS,
      calendarEvents: [],
      carriedFrom: [],
      absorbedInstanceIds: [],
      notes: '',
      ...created(ctx, caller.actor),
    };
    working.set(instance.id, { instance, verb: 'materialised' });
  }

  // Absorption (02 §4.3) over the future instances of active series.
  const slots: Slot[] = [];
  for (const { instance } of working.values()) {
    const series = seriesById.get(instance.seriesId);
    if (series === undefined || series.status !== 'active') continue;
    if (instance.state === 'absorbed' && instance.absorbedBy !== undefined) {
      slots.push({
        id: instance.id,
        series,
        start: instance.scheduledStart,
        absorbedBy: instance.absorbedBy,
      });
    } else if (isFutureMutable(instance, now)) {
      slots.push({ id: instance.id, series, start: instance.scheduledStart });
    }
  }
  const absorption = absorbSlots(slots);
  for (const slot of slots) {
    const entry = working.get(slot.id);
    if (entry === undefined) continue;
    const instance = entry.instance;
    const by = absorption.absorbedBy.get(slot.id);
    if (instance.state !== 'absorbed' && by !== undefined) {
      set({ ...instance, state: 'absorbed', absorbedBy: by as InstanceId }, 'absorbed');
      continue;
    }
    if (instance.state === 'absorbed') continue;
    const absorbed = (absorption.absorbs.get(slot.id) ?? []) as InstanceId[];
    const kept = instance.absorbedInstanceIds.filter((id) => !absorbed.includes(id));
    const end = addMinutes(
      instance.scheduledStart,
      slot.series.durationMinutes + (absorption.extraMinutes.get(slot.id) ?? 0),
    );
    const next = { ...instance, scheduledEnd: end, absorbedInstanceIds: [...kept, ...absorbed] };
    if (JSON.stringify(next) !== JSON.stringify(instance)) set(next, 'rewritten');
  }

  // Rule 3 (02 §4.6): CC meetings may not overlap; the lower cadence moves.
  let moves: Move[] = [];
  let unresolved: { id: string; other: string }[] = [];
  if (input.placement !== undefined) {
    const movable = [...working.values()]
      .map((w) => w.instance)
      .filter((i) => isFutureMutable(i, now) && seriesById.get(i.seriesId)?.status === 'active');
    if (movable.length > 0) {
      const from = movable.reduce(
        (a, i) => (i.scheduledStart < a ? i.scheduledStart : a),
        movable[0]?.scheduledStart ?? now,
      );
      const to = movable.reduce((a, i) => (i.scheduledEnd > a ? i.scheduledEnd : a), from);
      const blocks = blockIntervals(input.placement.protectedBlocks, from, to);
      const result = resolveOverlaps(
        input.placement,
        movable.map((i) => ({
          id: i.id,
          seriesId: i.seriesId,
          start: i.scheduledStart,
          end: i.scheduledEnd,
          cadence: seriesById.get(i.seriesId)?.cadence ?? 'daily',
        })),
        blocks,
      );
      moves = result.moves;
      unresolved = result.unresolved;
      for (const move of moves) {
        const instance = working.get(move.id)?.instance;
        if (instance === undefined) continue;
        const length = minutesBetween(instance.scheduledStart, instance.scheduledEnd);
        set(
          {
            ...instance,
            scheduledStart: move.to,
            scheduledEnd: addMinutes(move.to, length),
            rescheduledFrom: { start: instance.scheduledStart, by: caller.actor, at: now },
          },
          'moved',
        );
      }
    }
  }

  const changes: Change<MeetingInstance>[] = [];
  const before = new Map(input.instances.map((i) => [i.id, i]));
  const instances: MeetingInstance[] = [];
  for (const { instance, verb } of working.values()) {
    const original = before.get(instance.id);
    if (
      verb === undefined ||
      (original !== undefined && JSON.stringify(original) === JSON.stringify(instance))
    ) {
      instances.push(original ?? instance);
      continue;
    }
    const record =
      original === undefined
        ? instance
        : { ...instance, ...auditOf(touched(ctx, original, caller.actor)) };
    changes.push(instanceChange(ctx, caller, original, record, verb));
    instances.push(record);
  }
  instances.sort(
    (a, b) =>
      a.occurrenceStart.localeCompare(b.occurrenceStart) || a.seriesId.localeCompare(b.seriesId),
  );
  return {
    status: changes.length === 0 ? 'no-op' : 'ok',
    changes,
    instances,
    warnings,
    moves,
    unresolved,
  };
}

function auditOf(record: MeetingInstance) {
  return {
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    version: record.version,
  };
}
