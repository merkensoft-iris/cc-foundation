/**
 * Register metrics, docs/design/03-decisions-and-action-items.md §9.6, derived nightly and
 * shown in `register_health` (02 §5.2, E-8):
 *
 * - Closed on time (measure K-0006).
 * - Verified share: (`auto` + `confirmed`) over all `verified_done`; attested reported apart.
 * - Rejected claims in the window.
 * - Items rolled over twice or more (`carryCount >= 2`), and the oldest open item.
 *
 * A window is an inclusive range of local dates. Each item's dates are read in its own due
 * time zone (the owning workstream's, 03 §3).
 *
 * **Closed on time** counts each item once, in the window that holds its due date: the items
 * due in the window that are, at `asOf`, either verified or overdue. Overdue is read as in 07
 * §4.3: past due and not claimed. An item not yet past due, or claimed and waiting for review,
 * is not counted yet; a dropped item is not counted (its drop is a decision, not a miss). On
 * time: `closedAt` on or before the due date (and time).
 * Attested items count as closed (OQ-03-02 default: yes, with the verified share shown next to
 * it).
 */
import type { ActionItem } from '@cc/schemas';

import { isActive, WORKING } from './health.js';
import { inWindow, isPastDue, localDate, onOrBeforeDue } from './time.js';

export interface Window {
  /** First local date, inclusive. */
  readonly start: string;
  /** Last local date, inclusive. */
  readonly end: string;
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** numerator / denominator, or null when the denominator is 0. */
  readonly value: number | null;
}

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function closedBy(item: ActionItem, asOf: string): boolean {
  return (
    item.lifecycle === 'verified_done' &&
    item.closedAt !== undefined &&
    Date.parse(item.closedAt) <= Date.parse(asOf)
  );
}

/** Closed on time (K-0006): items due in the window, verified on time over verified or overdue. */
export function closedOnTime(items: readonly ActionItem[], window: Window, asOf: string): Ratio {
  let closed = 0;
  let onTime = 0;
  for (const item of items) {
    if (item.lifecycle === 'dropped' || item.lifecycle === 'draft') continue;
    if (!inWindow(item.due.date, window)) continue;
    if (closedBy(item, asOf)) {
      closed += 1;
      if (item.closedAt !== undefined && onOrBeforeDue(item.due, item.closedAt)) onTime += 1;
    } else if (WORKING.has(item.lifecycle) && isPastDue(item.due, asOf)) {
      closed += 1; // overdue: counted, not on time
    }
  }
  return ratio(onTime, closed);
}

/** The verified items whose `closedAt` falls in the window, read in their due time zone. */
function verifiedIn(items: readonly ActionItem[], window: Window, asOf: string): ActionItem[] {
  return items.filter(
    (item) =>
      closedBy(item, asOf) &&
      item.closedAt !== undefined &&
      inWindow(localDate(item.closedAt, item.due.timeZone), window),
  );
}

export interface VerifiedShare {
  /** (auto + confirmed) over every verified_done item closed in the window. */
  readonly share: Ratio;
  readonly auto: number;
  readonly confirmed: number;
  /** Reported separately (03 §9.3). */
  readonly attested: number;
}

/** Verified share over the items verified in the window (03 §9.6). */
export function verifiedShare(
  items: readonly ActionItem[],
  window: Window,
  asOf: string,
): VerifiedShare {
  const verified = verifiedIn(items, window, asOf);
  const count = (method: string) =>
    verified.filter((item) => item.verification?.method === method).length;
  const auto = count('auto');
  const confirmed = count('confirmed');
  return {
    share: ratio(auto + confirmed, verified.length),
    auto,
    confirmed,
    attested: count('attested'),
  };
}

/** Rejected claims whose rejection falls in the window. */
export function rejectedClaims(items: readonly ActionItem[], window: Window): number {
  return items
    .flatMap((item) =>
      (item.verification?.rejectedClaims ?? []).map((rejection) =>
        localDate(rejection.at, item.due.timeZone),
      ),
    )
    .filter((date) => inWindow(date, window)).length;
}

/** The count of verified items, the derived formula `verified_items_count` (03 §5.4). */
export function verifiedItemsCount(
  items: readonly ActionItem[],
  window: Window,
  asOf: string,
): number {
  return verifiedIn(items, window, asOf).length;
}

export interface RegisterHealth {
  readonly window: Window;
  readonly closedOnTime: Ratio;
  readonly verifiedShare: VerifiedShare;
  readonly rejectedClaims: number;
  /** Active items with carryCount >= 2, by ref. */
  readonly carriedTwiceOrMore: readonly string[];
  /** Active items re-planned twice or more (02 §7.1 rule 3), by ref. */
  readonly replannedTwiceOrMore: readonly string[];
  /** The active item created earliest, if any. */
  readonly oldestOpen?: { readonly ref: string; readonly createdAt: string };
}

/**
 * Every metric of 03 §9.6 over one window, as of an instant (the nightly run's clock). "Open"
 * means accepted and not yet closed: drafts are not commitments yet.
 */
export function registerHealth(
  items: readonly ActionItem[],
  window: Window,
  asOf: string,
): RegisterHealth {
  const open = items
    .filter((item) => isActive(item) && item.lifecycle !== 'draft')
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.ref.localeCompare(b.ref) : a.createdAt < b.createdAt ? -1 : 1,
    );
  const oldest = open[0];
  return {
    window,
    closedOnTime: closedOnTime(items, window, asOf),
    verifiedShare: verifiedShare(items, window, asOf),
    rejectedClaims: rejectedClaims(items, window),
    carriedTwiceOrMore: open.filter((item) => item.carryCount >= 2).map((item) => item.ref),
    replannedTwiceOrMore: open.filter((item) => item.replannedCount >= 2).map((item) => item.ref),
    ...(oldest === undefined
      ? {}
      : { oldestOpen: { ref: oldest.ref, createdAt: oldest.createdAt } }),
  };
}

/** K-0006 as a percentage (measure formula `action_items_closed_on_time_pct`), or null. */
export function closedOnTimePct(
  items: readonly ActionItem[],
  window: Window,
  asOf: string,
): number | null {
  const value = closedOnTime(items, window, asOf).value;
  return value === null ? null : Math.round(value * 1000) / 10;
}
