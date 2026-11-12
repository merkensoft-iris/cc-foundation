/**
 * The US daylight-saving check (ADR 0001 decision 8; 02 §8.1 notes; the owner's decision of
 * 10 Nov 2026, option (c)). For a workstream whose recorded time zone observes US daylight
 * saving, the check runs from the Monday before each US transition to the Friday after
 * (12 days). There is no onboarding question: the condition is the zone each workstream already
 * records, and Temporal gives the transitions.
 *
 * Content (the spike's proposal, adopted by the ADR): one `attention` line in the daily start
 * listing the workstream's open items due that week with both the workstream's and the
 * workspace's times, plus the workstream-zone time of the sessions that week. The attention input
 * itself is P1-08; this module decides when the line shows and what it holds.
 *
 * "Observes US daylight saving" is read as: the zone changes its offset on the same local date as
 * `America/New_York` (the second Sunday of March and the first Sunday of November).
 */
import { Temporal } from '@cc/schemas';

import { addDays, localDate, localDateTime, utc } from './time.js';

export const US_REFERENCE_ZONE = 'America/New_York';

/** One US transition and its check window, local dates in the reference zone. */
export interface DstCheckWindow {
  /** The transition Sunday. */
  readonly transition: string;
  /** The Monday before (transition - 6 days). */
  readonly from: string;
  /** The Friday after (transition + 5 days), inclusive. */
  readonly to: string;
}

/** The local dates of a zone's offset changes in a year. */
function transitionDates(timeZone: string, year: number): string[] {
  const out: string[] = [];
  let at: Temporal.ZonedDateTime | null = Temporal.PlainDate.from({
    year,
    month: 1,
    day: 1,
  }).toZonedDateTime({ timeZone });
  for (;;) {
    at = at.getTimeZoneTransition('next');
    if (at === null || at.year !== year) break;
    out.push(at.toPlainDate().toString());
  }
  return out;
}

/** The US check windows whose transition falls in the given years. */
export function usDstCheckWindows(years: readonly number[]): DstCheckWindow[] {
  return years.flatMap((year) =>
    transitionDates(US_REFERENCE_ZONE, year).map((transition) => ({
      transition,
      from: addDays(transition, -6),
      to: addDays(transition, 5),
    })),
  );
}

/** Whether a zone follows the US daylight-saving dates in a year. */
export function observesUsDst(timeZone: string, year: number): boolean {
  const us = transitionDates(US_REFERENCE_ZONE, year);
  const own = transitionDates(timeZone, year);
  return us.length > 0 && us.every((date) => own.includes(date));
}

/** The check window holding a local date, when the zone observes US daylight saving. */
export function dstCheckWindowFor(date: string, timeZone: string): DstCheckWindow | undefined {
  const year = Number(date.slice(0, 4));
  if (!observesUsDst(timeZone, year)) return undefined;
  return usDstCheckWindows([year - 1, year, year + 1]).find(
    (window) => date >= window.from && date <= window.to,
  );
}

export interface DstCheckItem {
  readonly ref: string;
  readonly due: { readonly date: string; readonly time?: string; readonly timeZone: string };
}

export interface DstCheckLine {
  readonly workstreamId: string;
  readonly window: DstCheckWindow;
  /** Open items due in the window; `dueBy` is the instant they fall due (ADR 0001 decision 7). */
  readonly items: readonly {
    readonly ref: string;
    readonly dueBy: string;
    /** Local wall-clock times "2026-11-02T00:00" in the workstream's and the workspace's zone. */
    readonly workstreamTime: string;
    readonly workspaceTime: string;
  }[];
  /** The workstream's sessions in the window, in both zones. */
  readonly sessions: readonly {
    readonly instanceId: string;
    readonly start: string;
    readonly workstreamTime: string;
    readonly workspaceTime: string;
  }[];
}

/**
 * The instant a due date falls due (ADR 0001 decision 7): a date alone from 00:00 of the next
 * day in its zone; an explicit time with `compatible` disambiguation.
 */
export function dueInstant(due: DstCheckItem['due']): string {
  if (due.time === undefined) {
    return utc(
      Temporal.PlainDate.from(due.date)
        .add({ days: 1 })
        .toZonedDateTime({ timeZone: due.timeZone })
        .toInstant(),
    );
  }
  return utc(
    Temporal.PlainDateTime.from(`${due.date}T${due.time}`)
      .toZonedDateTime(due.timeZone, { disambiguation: 'compatible' })
      .toInstant(),
  );
}

/**
 * The check line for one workstream on one daily-start date (a local date in the workspace
 * zone), or undefined outside a window or for a zone without US daylight saving.
 */
export function dstCheckLine(input: {
  readonly date: string;
  readonly workspaceTimeZone: string;
  readonly workstream: { readonly id: string; readonly timeZone: string };
  readonly openItems: readonly DstCheckItem[];
  readonly sessions: readonly { readonly instanceId: string; readonly start: string }[];
}): DstCheckLine | undefined {
  const zone = input.workstream.timeZone;
  const window = dstCheckWindowFor(input.date, zone);
  if (window === undefined) return undefined;
  const inWindow = (instant: string) => {
    const date = localDate(instant, zone);
    return date >= window.from && date <= window.to;
  };
  const both = (instant: string) => ({
    workstreamTime: localDateTime(instant, zone),
    workspaceTime: localDateTime(instant, input.workspaceTimeZone),
  });
  const items = input.openItems
    .filter((item) => item.due.date >= window.from && item.due.date <= window.to)
    .map((item) => {
      const dueBy = dueInstant(item.due);
      return { ref: item.ref, dueBy, ...both(dueBy) };
    });
  const sessions = input.sessions
    .filter((session) => inWindow(session.start))
    .map((session) => ({ ...session, ...both(session.start) }));
  return { workstreamId: input.workstream.id, window, items, sessions };
}
