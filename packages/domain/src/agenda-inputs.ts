/**
 * The `action_review` input of a meeting instance (02 §5.1, §7.1 rule 1): carry-forward is
 * structural, so the next instance selects every item in scope that is open, in progress,
 * waiting or claimed and due before the instance ends, plus every item claimed since the
 * previous instance ended (the auto-verified ones among them for a spot check, 03 §9.2 step
 * 4). A rejected claim keeps its claim, so a rejected item is listed even when not yet due. A
 * dropped item is not listed.
 */
import type { ActionItem } from '@cc/schemas';

import { isDueBefore } from './time.js';
import type { WorkstreamId } from './types.js';

const REVIEWED: ReadonlySet<ActionItem['lifecycle']> = new Set([
  'open',
  'in_progress',
  'waiting',
  'claimed_done',
]);

export interface ActionReviewScope {
  /** The workstreams in the instance's scope. */
  readonly workstreamIds: readonly WorkstreamId[];
  /** The instance's end, a UTC timestamp. */
  readonly instanceEnd: string;
  /** The previous instance's end, a UTC timestamp; absent for the first instance. */
  readonly previousInstanceEnd?: string;
}

/** Whether an item belongs in the instance's `action_review` input. */
export function inActionReview(item: ActionItem, scope: ActionReviewScope): boolean {
  if (!scope.workstreamIds.includes(item.workstreamId)) return false;
  if (REVIEWED.has(item.lifecycle) && isDueBefore(item.due, scope.instanceEnd)) return true;
  const since = scope.previousInstanceEnd;
  return (
    since !== undefined &&
    item.lifecycle !== 'dropped' &&
    item.claim !== undefined &&
    Date.parse(item.claim.at) > Date.parse(since) &&
    Date.parse(item.claim.at) <= Date.parse(scope.instanceEnd)
  );
}

/** The instance's `action_review` input, in due-date order. */
export function actionReviewInput(
  items: readonly ActionItem[],
  scope: ActionReviewScope,
): ActionItem[] {
  return items
    .filter((item) => inActionReview(item, scope))
    .sort((a, b) => a.due.date.localeCompare(b.due.date) || a.ref.localeCompare(b.ref));
}
