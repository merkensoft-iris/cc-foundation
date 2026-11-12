/**
 * Local dates and due dates. A due date is a `LocalDate` (and an optional "HH:MM") read in the
 * item's time zone (03 §3, §5.7). These helpers read an instant in a time zone with the
 * built-in Intl data; they take every instant as an argument and never read the clock (D4).
 */
import type { ActionItem } from '@cc/schemas';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The local wall-clock time of a UTC instant in a time zone: "2026-11-13T15:00:00". */
export function localDateTime(instant: string, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    parts[part.type] = part.value;
  }
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}`;
}

/** The local date of a UTC instant in a time zone: "2026-11-13". */
export function localDate(instant: string, timeZone: string): string {
  return localDateTime(instant, timeZone).slice(0, 10);
}

/** The local date and time an item is due by: the end of its due date, or its due time. */
function dueBy(due: ActionItem['due']): string {
  return due.time === undefined ? `${due.date}T23:59:59` : `${due.date}T${due.time}:00`;
}

/** Whether `instant` is on or before the item's due date (and time), in the item's zone. */
export function onOrBeforeDue(due: ActionItem['due'], instant: string): boolean {
  return localDateTime(instant, due.timeZone) <= dueBy(due);
}

/** Whether the due date (and time) has passed at `now`. */
export function isPastDue(due: ActionItem['due'], now: string): boolean {
  return !onOrBeforeDue(due, now);
}

/**
 * Whether the item falls due before `instant` (02 §5.1 `dueBefore instance.end`): its due
 * time, or for a date alone the start of its due date, is earlier than `instant`, both read
 * in the item's zone. An item due on the day of the meeting is due before it ends.
 */
export function isDueBefore(due: ActionItem['due'], instant: string): boolean {
  const start = due.time === undefined ? `${due.date}T00:00:00` : `${due.date}T${due.time}:00`;
  return start < localDateTime(instant, due.timeZone);
}

/** Whether a local date is inside an inclusive window of local dates. */
export function inWindow(date: string, window: { start: string; end: string }): boolean {
  return date >= window.start && date <= window.end;
}
