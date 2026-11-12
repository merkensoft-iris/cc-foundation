/**
 * The time-budget check T1 (01 §6.4): if the rhythm's average weekly minutes exceed
 * `weeklyManagementMinutes`, warning `W-TIME-BUDGET` offers, in order: merge more meetings,
 * shorten meetings to their backbone minimums, move personal-os weekly reviews to biweekly, or
 * raise the budget. The user picks one; CC never applies a fix by itself.
 *
 * What counts (owner decision, key p1-07-spec, 11 Nov 2026; stated in 01 §6.4): every daily,
 * weekly, biweekly and monthly instance over the 52 weeks from the rhythm's start, with
 * absorption applied (an absorbed instance counts 0, the absorbing one its longer length),
 * divided by 52. Quarterly and yearly sessions are not counted. This is the reading that
 * reproduces 01 §7.3: 160 minutes a week, about 174 with the monthly absorption, within 240.
 */
import type { Cadence, MeetingSeries } from '@cc/schemas';

import { absorbSlots, type Slot } from './absorb.js';
import { expand } from './expand.js';
import { addDays, startOfDay } from './time.js';

export const BUDGET_WEEKS = 52;
export const BUDGET_CADENCES: readonly Cadence[] = ['daily', 'weekly', 'biweekly', 'monthly'];

/** The fixes of 01 §6.4 T1, in order, as `RhythmAnswers.timeBudgetFix` names them. */
export const TIME_BUDGET_FIXES = ['merge', 'shorten', 'biweekly', 'raise_budget'] as const;

export interface TimeBudgetWarning {
  readonly code: 'W-TIME-BUDGET';
  readonly text: string;
  readonly averageWeeklyMinutes: number;
  readonly weeklyManagementMinutes: number;
  readonly options: typeof TIME_BUDGET_FIXES;
}

export interface TimeBudget {
  /** Average minutes a week, unrounded. */
  readonly averageWeeklyMinutes: number;
  /** Minutes a week per series, absorption applied. */
  readonly bySeries: Readonly<Record<string, number>>;
  readonly warning?: TimeBudgetWarning;
}

type BudgetSeries = Pick<
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
 * T1 for a set of series. `from` is the first local date counted (read in each series' zone),
 * by default the earliest series start.
 */
export function checkTimeBudget(
  series: readonly BudgetSeries[],
  weeklyManagementMinutes: number,
  from?: string,
): TimeBudget {
  const active = series.filter((s) => s.status === 'active');
  const first = from ?? active.map((s) => s.dtstart.slice(0, 10)).sort()[0] ?? '1970-01-01';
  const slots: Slot[] = [];
  for (const s of active) {
    const window = {
      from: startOfDay(first, s.timeZone),
      to: startOfDay(addDays(first, BUDGET_WEEKS * 7), s.timeZone),
    };
    for (const occurrence of expand(s, window.from, window.to).occurrences) {
      slots.push({ id: `${s.id}@${occurrence.start}`, series: s, start: occurrence.start });
    }
  }
  const absorption = absorbSlots(slots);
  const totals: Record<string, number> = {};
  let total = 0;
  for (const slot of slots) {
    if (!BUDGET_CADENCES.includes(slot.series.cadence)) continue;
    const minutes = absorption.absorbedBy.has(slot.id)
      ? 0
      : slot.series.durationMinutes + (absorption.extraMinutes.get(slot.id) ?? 0);
    totals[slot.series.id] = (totals[slot.series.id] ?? 0) + minutes;
    total += minutes;
  }
  const averageWeeklyMinutes = total / BUDGET_WEEKS;
  const bySeries = Object.fromEntries(
    Object.entries(totals).map(([id, minutes]) => [id, minutes / BUDGET_WEEKS]),
  );
  if (averageWeeklyMinutes <= weeklyManagementMinutes) return { averageWeeklyMinutes, bySeries };
  return {
    averageWeeklyMinutes,
    bySeries,
    warning: {
      code: 'W-TIME-BUDGET',
      text: `The rhythm averages ${Math.round(averageWeeklyMinutes)} minutes a week, over the budget of ${weeklyManagementMinutes}. Pick one: merge more meetings, shorten meetings to their backbone minimums, move personal-os weekly reviews to biweekly, or raise the budget.`,
      averageWeeklyMinutes,
      weeklyManagementMinutes,
      options: TIME_BUDGET_FIXES,
    },
  };
}
