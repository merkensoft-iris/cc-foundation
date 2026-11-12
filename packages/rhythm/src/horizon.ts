/**
 * The rolling horizon (02 §4.1 rule 1): 13 weeks for daily, weekly and biweekly series; the
 * next 4 occurrences for monthly, the next 2 for quarterly and the next 1 for yearly.
 *
 * The 13 weeks run from the later of today and the series' first day (its synced DTSTART), both
 * local dates in the series zone, to the start of the day 91 days later. AC-02-01 fixes this
 * reading: seeding on 2026-11-04 a rhythm whose meetings start in the week of 2026-11-09 (README
 * scenario) materialises daily and weekly instances from 2026-11-09 to 2027-02-05, and the
 * P0-03 spike counted that horizon as ending on 2027-02-07.
 */
import type { Cadence, MeetingSeries } from '@cc/schemas';

import { expand, nextOccurrences, type Expansion } from './expand.js';
import { addDays, compareInstants, localDate, startOfDay } from './time.js';

export const HORIZON_DAYS = 91;

/** How many next occurrences a monthly, quarterly or yearly series keeps materialised. */
export const HORIZON_COUNT: Partial<Record<Cadence, number>> = {
  monthly: 4,
  quarterly: 2,
  yearly: 1,
};

type SeriesRule = Pick<MeetingSeries, 'cadence' | 'rrule' | 'dtstart' | 'timeZone'>;

/** The UTC window `[from, to)` a series materialises at `now`, for the 13-week cadences. */
export function horizonWindow(series: SeriesRule, now: string): { from: string; to: string } {
  const today = localDate(now, series.timeZone);
  const first = series.dtstart.slice(0, 10);
  const anchor = today > first ? today : first;
  const from =
    compareInstants(now, startOfDay(anchor, series.timeZone)) > 0
      ? now
      : startOfDay(anchor, series.timeZone);
  return { from, to: startOfDay(addDays(anchor, HORIZON_DAYS), series.timeZone) };
}

/**
 * The occurrences of a series inside its horizon at `now`: those that start at or after `now`.
 * Past occurrences are never materialised late: past instances are immutable (02 §4.1 rule 3).
 */
export function horizonOccurrences(series: SeriesRule, now: string): Expansion {
  const count = HORIZON_COUNT[series.cadence];
  if (count !== undefined) return nextOccurrences(series, now, count);
  const window = horizonWindow(series, now);
  return expand(series, window.from, window.to);
}
