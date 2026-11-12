/**
 * Carry-forward (02 §7.1, §4.2 rule 4). Carry-forward itself is structural: the next review's
 * `action_review` input selects every unclosed item due before it ends, so nothing is copied
 * (inputs.ts). What this module adds is the count: `carryCount` increments once per (item,
 * completed review) pair when the review closes (C-02-05).
 *
 * A completed instance counts for an item only when (02 §7.1 rule 2, owner decision key
 * p1-09-carry-rule, 12 Nov 2026):
 *
 * 1. it is a review: its series is weekly or slower. The daily start and shutdown see items but
 *    are not reviews, so they never count (02 §1 "every review that sees an overdue item").
 * 2. the item's workstream is in the series' scope.
 * 3. the item was overdue at the review: its due date is before the instance's local start
 *    date, read in the item's time zone (ADR 0001 decision 7: a date-only due date is overdue
 *    from 00:00 the next day). An item due on the review's own day is not carried by it.
 * 4. the item is accepted and unsettled: not `draft`, `claimed_done`, `verified_done` or
 *    `dropped`.
 *
 * Skipped, absorbed, missed and cancelled instances never count; an absorbing instance counts
 * once for both meetings (AC-02-05, AC-02-06).
 */
import { carryItem, type Caller, type Change, type DomainContext } from '@cc/domain';
import type { ActionItem, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { CADENCE_RANK } from './absorb.js';
import { localDate } from './time.js';

const NOT_CARRIED: readonly ActionItem['lifecycle'][] = [
  'draft',
  'claimed_done',
  'verified_done',
  'dropped',
];

/** Whether a series' instances are reviews that carry items: weekly or slower (rule 1). */
export function isReviewSeries(series: Pick<MeetingSeries, 'cadence'>): boolean {
  return CADENCE_RANK[series.cadence] >= CADENCE_RANK.weekly;
}

export function incrementsCarryCount(
  series: Pick<MeetingSeries, 'workstreamIds' | 'cadence'>,
  instance: Pick<MeetingInstance, 'state' | 'scheduledStart'>,
  item: Pick<ActionItem, 'workstreamId' | 'due' | 'lifecycle'>,
): boolean {
  if (instance.state !== 'completed') return false;
  if (!isReviewSeries(series)) return false;
  if (!series.workstreamIds.includes(item.workstreamId)) return false;
  if (NOT_CARRIED.includes(item.lifecycle)) return false;
  return item.due.date < localDate(instance.scheduledStart, item.due.timeZone);
}

export interface CarryResult {
  readonly changes: readonly Change[];
  /** Every item given, with the carried ones updated. */
  readonly items: readonly ActionItem[];
  /** Refs of the items this review carried. */
  readonly carried: readonly string[];
}

/**
 * The carry step of a review's close (02 §4.7 "close"): increments `carryCount` of every item
 * the completed instance counts for. `counted` tells which items this instance already carried
 * (their `action_item.carried` events name it), so running it again changes nothing (C-02-05).
 */
export function carryForward(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly series: MeetingSeries;
    readonly instance: MeetingInstance;
    readonly items: readonly ActionItem[];
    readonly counted?: (itemId: string) => boolean;
  },
): CarryResult {
  const { series, instance } = input;
  const changes: Change[] = [];
  const carried: string[] = [];
  const items = input.items.map((item) => {
    if (!incrementsCarryCount(series, instance, item)) return item;
    if (input.counted?.(item.id) === true) return item;
    const outcome = carryItem(ctx, caller, item, instance.id);
    changes.push(...outcome.changes);
    carried.push(item.ref);
    return outcome.record;
  });
  return { changes, items, carried: carried.sort() };
}
