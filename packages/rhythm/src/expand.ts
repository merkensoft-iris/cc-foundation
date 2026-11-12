/**
 * RRULE expansion (02 §4.1 rule 4, ADR 0001 decision 2). Rules are expanded on the wall clock
 * (floating mode, DTSTART without TZID) with `rrule-temporal`, always constructed with the
 * process-wide Temporal; the series zone is attached here, so occurrences keep their local time
 * across DST changes. A local time in a DST gap is omitted (RFC 5545 §3.3.10) and reported; an
 * overlap takes the first occurrence (§3.3.5). This is exact because the subset (decision 4)
 * has no frequency finer than daily and exactly one BYHOUR and BYMINUTE.
 *
 * This is the only module that imports `rrule-temporal` (ADR 0001 follow-up 1).
 */
import { formatRRule, parseRRule, Temporal, type ParsedRRule } from '@cc/schemas';
import { RRuleTemporal } from 'rrule-temporal';

import { invariantError } from '@cc/domain';

import { localDateTime, utc, wallClockInstant } from './time.js';

/** One occurrence: its local wall-clock start and its UTC instant. */
export interface Occurrence {
  /** "2026-11-13T15:00", in the rule's zone. */
  readonly local: string;
  /** "2026-11-13T09:30:00Z". */
  readonly start: string;
}

export interface Expansion {
  readonly occurrences: readonly Occurrence[];
  /** Local wall-clock times the rule generated inside a DST gap of the zone; omitted. */
  readonly gaps: readonly string[];
}

/** A rule with its zone and synced DTSTART, as a series or a protected block holds it. */
export interface ZonedRule {
  readonly rrule: string;
  /** Local "YYYY-MM-DDTHH:MM". */
  readonly dtstart: string;
  readonly timeZone: string;
}

/** Parses a rule of the subset, or throws `E_INVARIANT` naming ADR 0001 decision 4. */
export function requireRule(text: string): ParsedRRule {
  const parsed = parseRRule(text);
  if (!parsed.ok) {
    const [first = 'invalid rule', ...rest] = parsed.errors;
    throw invariantError(
      { rule: 'ADR 0001 decision 4', message: `RRULE: ${first}` },
      rest.map((error) => `RRULE: ${error}`),
    );
  }
  return parsed.rule;
}

/** CC's canonical text of a rule (ADR 0001 decision 4: never a library re-serialisation). */
export function canonicalRule(text: string): string {
  return formatRRule(requireRule(text));
}

const basic = (local: string) => `${local.replace(/[-:]/g, '').slice(0, 13)}00`;

function library(rule: ZonedRule): RRuleTemporal {
  requireRule(rule.rrule);
  const [ruleLine, ...dates] = rule.rrule.split('\n');
  return new RRuleTemporal({
    temporal: Temporal,
    rruleString: [`DTSTART:${basic(rule.dtstart)}`, `RRULE:${ruleLine ?? ''}`, ...dates].join('\n'),
  });
}

/** The floating (UTC-labelled) Date for a local wall-clock time, as `rrule-temporal` reads it. */
function floating(local: string): Date {
  return new Date(
    Temporal.PlainDateTime.from(local).toZonedDateTime('UTC').toInstant().epochMilliseconds,
  );
}

function plainOf(value: { toString(): string }): string {
  return Temporal.ZonedDateTime.from(value.toString())
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}

/**
 * Every occurrence whose instant is in `[from, to)`, both UTC timestamps.
 */
export function expand(rule: ZonedRule, from: string, to: string): Expansion {
  const lower = Temporal.PlainDateTime.from(localDateTime(from, rule.timeZone)).subtract({
    days: 1,
  });
  const upper = Temporal.PlainDateTime.from(localDateTime(to, rule.timeZone)).add({ days: 1 });
  const found = library(rule).between(floating(lower.toString()), floating(upper.toString()), true);
  const occurrences: Occurrence[] = [];
  const gaps: string[] = [];
  const a = Temporal.Instant.from(from);
  const b = Temporal.Instant.from(to);
  for (const value of found) {
    const local = plainOf(value);
    const start = wallClockInstant(local, rule.timeZone);
    if (start === undefined) {
      const at = Temporal.PlainDateTime.from(local)
        .toZonedDateTime(rule.timeZone, { disambiguation: 'earlier' })
        .toInstant();
      if (Temporal.Instant.compare(at, a) >= 0 && Temporal.Instant.compare(at, b) < 0) {
        gaps.push(local);
      }
      continue;
    }
    const at = Temporal.Instant.from(start);
    if (Temporal.Instant.compare(at, a) < 0 || Temporal.Instant.compare(at, b) >= 0) continue;
    occurrences.push({ local, start });
  }
  return { occurrences, gaps };
}

/**
 * The first `count` occurrences at or after `from` (a UTC timestamp), searching at most
 * `withinYears` ahead.
 */
export function nextOccurrences(
  rule: ZonedRule,
  from: string,
  count: number,
  withinYears = 6,
): Expansion {
  const to = utc(
    Temporal.Instant.from(from).toZonedDateTimeISO('UTC').add({ years: withinYears }).toInstant(),
  );
  const all = expand(rule, from, to);
  const occurrences = all.occurrences.slice(0, count);
  const last = occurrences.at(-1);
  const gaps =
    last === undefined || occurrences.length < count
      ? all.gaps
      : all.gaps.filter((gap) => gap < last.local);
  return { occurrences, gaps };
}

/**
 * The synced DTSTART (ADR 0001 decision 5): the local start of the first occurrence on or
 * after a local date. Undefined when the rule has no occurrence from that date on.
 */
export function firstOccurrenceOnOrAfter(
  rrule: string,
  timeZone: string,
  date: string,
): string | undefined {
  const rule = requireRule(rrule);
  const time = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`;
  // A provisional DTSTART on the date itself: with includeDtstart off, a DTSTART that does not
  // match the rule is not an occurrence, so the first result is the first real one.
  const provisional = `${date}T${time}`;
  const next = library({ rrule, dtstart: provisional, timeZone }).next(
    floating(`${date}T00:00`),
    true,
  );
  return next === null ? undefined : plainOf(next);
}
