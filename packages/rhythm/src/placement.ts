/**
 * Placement (02 §4.6) and the workspace slot check T2 (01 §6.4).
 *
 * 1. Instances never overlap a `hard` protected block (C-02-07). Overlap with a `soft` block
 *    needs a recorded confirmation for that series.
 * 2. Instances stay inside working hours on workweek days unless the user confirmed an exception
 *    for that series.
 * 3. Two CC instances may not overlap. On a conflict the lower-cadence one moves to the nearest
 *    free slot on the same day.
 * 4. Everything here is deterministic; AI does not place meetings.
 *
 * Working hours, the workweek and protected blocks are read in their own zones: working hours in
 * the workspace zone, each block in its own `timeZone`.
 */
import type { MeetingSeries, ProtectedBlock, Weekday as SchemaWeekday } from '@cc/schemas';

import { absorbSlots, CADENCE_RANK, type Slot } from './absorb.js';
import { expand, firstOccurrenceOnOrAfter } from './expand.js';
import {
  addDays,
  addMinutes,
  compareInstants,
  localDate,
  localDateTime,
  minutesBetween,
  minutesOfDay,
  timeOfDay,
  wallClockInstantCompatible,
  weekdayOf,
} from './time.js';

/** A recorded confirmation (01 §4 `RhythmAnswers.acceptedOverlaps`, keyed by series here). */
export interface PlacementConfirmation {
  readonly seriesId: string;
  readonly reason: 'soft_block' | 'outside_working_hours';
  /** For `soft_block`: the block confirmed; absent confirms every soft block for the series. */
  readonly blockId?: string;
}

export interface PlacementContext {
  /** The workspace zone, in which working hours and the workweek are read. */
  readonly timeZone: string;
  readonly workweek: readonly SchemaWeekday[];
  readonly workingHours: readonly { readonly start: string; readonly end: string }[];
  readonly protectedBlocks: readonly ProtectedBlock[];
  readonly confirmations: readonly PlacementConfirmation[];
}

/** One meeting's time on the calendar. */
export interface Interval {
  readonly id: string;
  readonly seriesId: string;
  readonly start: string;
  readonly end: string;
}

export interface BlockInterval {
  readonly blockId: string;
  readonly policy: 'hard' | 'soft';
  readonly start: string;
  readonly end: string;
}

export type PlacementViolation =
  | {
      readonly kind: 'hard_block' | 'soft_block';
      readonly interval: Interval;
      readonly blockId: string;
    }
  | { readonly kind: 'outside_working_hours'; readonly interval: Interval }
  | { readonly kind: 'overlap'; readonly interval: Interval; readonly other: Interval };

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  compareInstants(a.start, b.end) < 0 && compareInstants(b.start, a.end) < 0;

/** Every occurrence of the protected blocks that touches `[from, to)`. */
export function blockIntervals(
  blocks: readonly ProtectedBlock[],
  from: string,
  to: string,
): BlockInterval[] {
  const out: BlockInterval[] = [];
  for (const block of blocks) {
    // Blocks have no DTSTART of their own; sync one a day before the window so a block that
    // started the evening before is seen.
    const dtstart = firstOccurrenceOnOrAfter(
      block.rrule,
      block.timeZone,
      addDays(localDate(from, block.timeZone), -1),
    );
    if (dtstart === undefined) continue;
    const reach = addMinutes(from, -block.durationMinutes);
    for (const occurrence of expand({ ...block, dtstart }, reach, to).occurrences) {
      const end = addMinutes(occurrence.start, block.durationMinutes);
      if (compareInstants(end, from) <= 0) continue;
      out.push({ blockId: block.id, policy: block.policy, start: occurrence.start, end });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function confirmed(
  ctx: PlacementContext,
  seriesId: string,
  reason: PlacementConfirmation['reason'],
  blockId?: string,
): boolean {
  return ctx.confirmations.some(
    (c) =>
      c.seriesId === seriesId &&
      c.reason === reason &&
      (c.blockId === undefined || c.blockId === blockId),
  );
}

/** Whether `[start, end)` lies inside one working-hours range of a workweek day. */
export function inWorkingHours(ctx: PlacementContext, start: string, end: string): boolean {
  const day = localDate(start, ctx.timeZone);
  if (!ctx.workweek.includes(weekdayOf(day))) return false;
  const from = minutesOfDay(localDateTime(start, ctx.timeZone).slice(11));
  const length = minutesBetween(start, end);
  return ctx.workingHours.some((range) => {
    const a = minutesOfDay(range.start);
    const b = minutesOfDay(range.end);
    return from >= a && from + length <= b;
  });
}

/** The violations of rules 1 to 3 among the intervals; confirmed ones are left out. */
export function checkPlacement(
  ctx: PlacementContext,
  intervals: readonly Interval[],
  blocks: readonly BlockInterval[],
): PlacementViolation[] {
  const out: PlacementViolation[] = [];
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
  for (const [index, interval] of sorted.entries()) {
    for (const block of blocks) {
      if (!overlaps(interval, block)) continue;
      if (block.policy === 'hard') {
        out.push({ kind: 'hard_block', interval, blockId: block.blockId });
      } else if (!confirmed(ctx, interval.seriesId, 'soft_block', block.blockId)) {
        out.push({ kind: 'soft_block', interval, blockId: block.blockId });
      }
    }
    if (
      !inWorkingHours(ctx, interval.start, interval.end) &&
      !confirmed(ctx, interval.seriesId, 'outside_working_hours')
    ) {
      out.push({ kind: 'outside_working_hours', interval });
    }
    for (const other of sorted.slice(index + 1)) {
      if (compareInstants(other.start, interval.end) >= 0) break;
      if (overlaps(interval, other)) out.push({ kind: 'overlap', interval, other });
    }
  }
  return out;
}

type SlotSeries = Pick<
  MeetingSeries,
  | 'id'
  | 'cadence'
  | 'rrule'
  | 'dtstart'
  | 'timeZone'
  | 'durationMinutes'
  | 'workstreamIds'
  | 'absorbs'
  | 'status'
>;

/**
 * Every occurrence of every active series in `[from, to)` as an interval, with absorption
 * applied (an absorbed occurrence is left out; an absorbing one is longer). This is the check of
 * AC-01-05: it expands every RRULE, independent of what is materialised.
 */
export function seriesIntervals(
  series: readonly SlotSeries[],
  from: string,
  to: string,
): Interval[] {
  const slots: Slot[] = [];
  for (const s of series) {
    if (s.status !== 'active') continue;
    for (const occurrence of expand(s, from, to).occurrences) {
      slots.push({ id: `${s.id}@${occurrence.start}`, series: s, start: occurrence.start });
    }
  }
  const absorption = absorbSlots(slots);
  return slots
    .filter((slot) => !absorption.absorbedBy.has(slot.id))
    .map((slot) => ({
      id: slot.id,
      seriesId: slot.series.id,
      start: slot.start,
      end: addMinutes(
        slot.start,
        slot.series.durationMinutes + (absorption.extraMinutes.get(slot.id) ?? 0),
      ),
    }));
}

/**
 * The nearest free start to `preferred` on the same local day (workspace zone) for a meeting of
 * `durationMinutes`: inside working hours on a workweek day, clear of hard blocks, of soft blocks
 * the series has not confirmed, and of `busy`. Candidates are 5 minutes apart; on a tie the
 * earlier start wins. Undefined when the day has no such slot.
 */
export function findSlot(
  ctx: PlacementContext,
  input: {
    readonly seriesId: string;
    readonly preferred: string;
    readonly durationMinutes: number;
    readonly busy: readonly { readonly start: string; readonly end: string }[];
    readonly blocks: readonly BlockInterval[];
  },
): string | undefined {
  const day = localDate(input.preferred, ctx.timeZone);
  if (!ctx.workweek.includes(weekdayOf(day))) return undefined;
  let best: { start: string; distance: number } | undefined;
  for (const range of ctx.workingHours) {
    for (
      let minute = minutesOfDay(range.start);
      minute + input.durationMinutes <= minutesOfDay(range.end);
      minute += 5
    ) {
      const start = wallClockInstantCompatible(`${day}T${timeOfDay(minute)}`, ctx.timeZone);
      const candidate = { start, end: addMinutes(start, input.durationMinutes) };
      if (input.busy.some((b) => overlaps(candidate, b))) continue;
      const blocked = input.blocks.some(
        (block) =>
          overlaps(candidate, block) &&
          (block.policy === 'hard' || !confirmed(ctx, input.seriesId, 'soft_block', block.blockId)),
      );
      if (blocked) continue;
      const distance = Math.abs(minutesBetween(input.preferred, start));
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && compareInstants(start, best.start) < 0)
      ) {
        best = { start, distance };
      }
    }
  }
  return best?.start;
}

export interface Movable extends Interval {
  readonly cadence: MeetingSeries['cadence'];
}

export interface Move {
  readonly id: string;
  readonly seriesId: string;
  readonly from: string;
  readonly to: string;
  /** The interval it gave way to. */
  readonly because: string;
}

/**
 * Rule 3: resolves overlaps between CC meetings. The lower-cadence one (02 §4.3 order; on a tie,
 * the later start, then the larger ID) moves to the nearest free slot on the same day. Returns
 * the moves and the overlaps no slot could resolve.
 */
export function resolveOverlaps(
  ctx: PlacementContext,
  items: readonly Movable[],
  blocks: readonly BlockInterval[],
): { moves: Move[]; unresolved: { id: string; other: string }[] } {
  const current = new Map(items.map((item) => [item.id, { ...item }]));
  const moves: Move[] = [];
  const unresolved: { id: string; other: string }[] = [];
  const stuck = new Set<string>();
  for (let round = 0; round < items.length * 2 + 1; round++) {
    const sorted = [...current.values()].sort(
      (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
    );
    let pair: [Movable, Movable] | undefined;
    for (const [i, a] of sorted.entries()) {
      for (const b of sorted.slice(i + 1)) {
        if (compareInstants(b.start, a.end) >= 0) break;
        const key = [a.id, b.id].sort().join('|');
        if (overlaps(a, b) && !stuck.has(key)) {
          pair = [a, b];
          break;
        }
      }
      if (pair !== undefined) break;
    }
    if (pair === undefined) break;
    const [a, b] = pair;
    const rank = CADENCE_RANK[a.cadence] - CADENCE_RANK[b.cadence];
    const [mover, keeper] =
      rank < 0
        ? [a, b]
        : rank > 0
          ? [b, a]
          : compareInstants(a.start, b.start) > 0 || (a.start === b.start && a.id > b.id)
            ? [a, b]
            : [b, a];
    const duration = minutesBetween(mover.start, mover.end);
    const busy = [...current.values()].filter((item) => item.id !== mover.id);
    const start = findSlot(ctx, {
      seriesId: mover.seriesId,
      preferred: mover.start,
      durationMinutes: duration,
      busy,
      blocks,
    });
    if (start === undefined) {
      stuck.add([a.id, b.id].sort().join('|'));
      unresolved.push({ id: mover.id, other: keeper.id });
      continue;
    }
    moves.push({
      id: mover.id,
      seriesId: mover.seriesId,
      from: mover.start,
      to: start,
      because: keeper.id,
    });
    current.set(mover.id, { ...mover, start, end: addMinutes(start, duration) });
  }
  return { moves, unresolved };
}

export interface NoSlotWarning {
  readonly code: 'W-NO-SLOT';
  readonly text: string;
  readonly meetings: readonly string[];
}

/**
 * T2 (01 §6.4): a required backbone meeting that cannot be placed outside `hard` blocks within
 * working hours on any workweek day of the week starting `weekStart` (a local Monday in the
 * workspace zone). Soft blocks and other meetings do not count here; they are S6's to arrange.
 */
export function checkNoSlot(
  ctx: PlacementContext,
  meetings: readonly { readonly key: string; readonly durationMinutes: number }[],
  weekStart: string,
): NoSlotWarning | undefined {
  const from = wallClockInstantCompatible(`${weekStart}T00:00`, ctx.timeZone);
  const to = wallClockInstantCompatible(`${addDays(weekStart, 7)}T00:00`, ctx.timeZone);
  const hard = blockIntervals(ctx.protectedBlocks, from, to).filter((b) => b.policy === 'hard');
  const unplaceable = meetings.filter((meeting) => {
    for (let d = 0; d < 7; d++) {
      const day = addDays(weekStart, d);
      const slot = findSlot(
        { ...ctx, confirmations: [] },
        {
          seriesId: meeting.key,
          preferred: wallClockInstantCompatible(`${day}T12:00`, ctx.timeZone),
          durationMinutes: meeting.durationMinutes,
          busy: [],
          blocks: hard,
        },
      );
      if (slot !== undefined) return false;
    }
    return true;
  });
  if (unplaceable.length === 0) return undefined;
  return {
    code: 'W-NO-SLOT',
    text: `No slot outside hard protected blocks within working hours on any workweek day for: ${unplaceable.map((m) => m.key).join(', ')}. Change a meeting time or a block before committing.`,
    meetings: unplaceable.map((m) => m.key),
  };
}
