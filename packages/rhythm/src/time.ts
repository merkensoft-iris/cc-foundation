/**
 * Time for the rhythm engine, on the process-wide Temporal (ADR 0001 decision 1). Every instant
 * is an argument: nothing here reads the clock or the host time zone (D4, 08 §4.2).
 */
import { Temporal } from '@cc/schemas';

/** A UTC instant as records store it: "2026-11-13T09:30:00Z". */
export function utc(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: 'second' });
}

export function instant(text: string): Temporal.Instant {
  return Temporal.Instant.from(text);
}

/** Minutes added to a UTC timestamp. */
export function addMinutes(text: string, minutes: number): string {
  return utc(instant(text).add({ minutes }));
}

/** Minutes from `a` to `b` (negative when `b` is earlier). */
export function minutesBetween(a: string, b: string): number {
  return instant(a).until(instant(b)).total('minutes');
}

export function compareInstants(a: string, b: string): number {
  return Temporal.Instant.compare(instant(a), instant(b));
}

/** The zoned date-time of a UTC timestamp. */
export function zoned(text: string, timeZone: string): Temporal.ZonedDateTime {
  return instant(text).toZonedDateTimeISO(timeZone);
}

/** The local date "2026-11-13" of a UTC timestamp in a zone. */
export function localDate(text: string, timeZone: string): string {
  return zoned(text, timeZone).toPlainDate().toString();
}

/** The local wall-clock "2026-11-13T15:00" of a UTC timestamp in a zone. */
export function localDateTime(text: string, timeZone: string): string {
  return zoned(text, timeZone).toPlainDateTime().toString({ smallestUnit: 'minute' });
}

/**
 * The instant of a local wall-clock time, or undefined when it falls in a gap (ADR 0001
 * decision 2: a generated local time in a gap is omitted, RFC 5545 §3.3.10; an overlap takes the
 * first occurrence, §3.3.5).
 */
export function wallClockInstant(local: string, timeZone: string): string | undefined {
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  if (!earlier.toPlainDateTime().equals(plain)) return undefined;
  return utc(earlier.toInstant());
}

/**
 * The instant of a local wall-clock time, moved forward over a gap (`compatible`, RFC 5545
 * §3.3.5). For window edges and placement, never for occurrences.
 */
export function wallClockInstantCompatible(local: string, timeZone: string): string {
  return utc(
    Temporal.PlainDateTime.from(local)
      .toZonedDateTime(timeZone, { disambiguation: 'compatible' })
      .toInstant(),
  );
}

/** The start of a local date in a zone, as a UTC timestamp. */
export function startOfDay(date: string, timeZone: string): string {
  return utc(Temporal.PlainDate.from(date).toZonedDateTime({ timeZone }).toInstant());
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** ISO weekday of a local date, 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[isoWeekday(date) - 1] ?? 'MO';
}

/** The Monday of the ISO week holding a local date. */
export function isoWeekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/**
 * Whether a time zone name is valid, checked by construction (ADR 0001 decision 6), never by
 * membership in `Intl.supportedValuesOf`.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.ZonedDateTime.from({ year: 2000, month: 1, day: 1, timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" as minutes after midnight. */
export function minutesOfDay(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minutes after midnight as "HH:MM". */
export function timeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
