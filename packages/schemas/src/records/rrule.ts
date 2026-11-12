/**
 * The RRULE subset CC accepts (ADR 0001 decision 4), for `MeetingSeries.rrule` (02 §3) and
 * `ProtectedBlock.rrule` (01 §4). CC validates a rule before any recurrence library sees it and
 * stores its own canonical string, never a library re-serialisation.
 *
 * The text is the RRULE value, optionally followed by `RDATE:` and `EXDATE:` lines, separated by
 * `\n`. Every date-time is a local wall-clock time `YYYYMMDDTHHMMSS` in the owning record's
 * time zone (no `Z`, no `TZID`), e.g.
 *
 *   FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0
 *   EXDATE:20261225T150000
 *
 * Allowed: FREQ in DAILY, WEEKLY, MONTHLY, YEARLY; INTERVAL >= 1; BYDAY, with ordinals +-1..+-5
 * only under MONTHLY, or YEARLY with BYMONTH; BYMONTH 1-12; BYMONTHDAY +-1..+-31; exactly one
 * BYHOUR (0-23) and one BYMINUTE (0-59); COUNT or UNTIL; WKST; local RDATE and EXDATE. Anything
 * else is refused (`E_INVARIANT` where a command checks it).
 */
import { z } from 'zod';

import { Temporal } from '../temporal.js';

export const RRULE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RRuleFreq = (typeof RRULE_FREQS)[number];

export const RRULE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type RRuleWeekday = (typeof RRULE_WEEKDAYS)[number];

/** One BYDAY entry: `FR`, or `-1FR` (the last Friday) with an ordinal. */
export interface RRuleByDay {
  readonly ordinal?: number;
  readonly weekday: RRuleWeekday;
}

/** A parsed rule of the subset. Local date-times are ISO strings, e.g. "2026-12-25T15:00:00". */
export interface ParsedRRule {
  readonly freq: RRuleFreq;
  readonly interval: number;
  readonly byMonth: readonly number[];
  readonly byMonthDay: readonly number[];
  readonly byDay: readonly RRuleByDay[];
  readonly hour: number;
  readonly minute: number;
  readonly count?: number;
  /** Local date-time, inclusive; a date alone is read as its end, 23:59:59. */
  readonly until?: string;
  readonly wkst?: RRuleWeekday;
  readonly rdates: readonly string[];
  readonly exdates: readonly string[];
}

export type RRuleParse =
  | { readonly ok: true; readonly rule: ParsedRRule }
  | { readonly ok: false; readonly errors: readonly string[] };

const PARTS = [
  'FREQ',
  'INTERVAL',
  'BYMONTH',
  'BYMONTHDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'COUNT',
  'UNTIL',
  'WKST',
] as const;
type Part = (typeof PARTS)[number];
const isPart = (name: string): name is Part => (PARTS as readonly string[]).includes(name);

const INTEGER = /^[+-]?\d+$/;
const LOCAL_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const LOCAL_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const BYDAY_ENTRY = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/;

/** "20261225T150000" as "2026-12-25T15:00:00", or undefined when it is not a real local time. */
function localDateTime(text: string): string | undefined {
  const match = LOCAL_DATE_TIME.exec(text);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  try {
    return Temporal.PlainDateTime.from(iso, { overflow: 'reject' }).toString() === iso
      ? iso
      : undefined;
  } catch {
    return undefined;
  }
}

function localDate(text: string): string | undefined {
  const match = LOCAL_DATE.exec(text);
  if (match === null) return undefined;
  return localDateTime(`${text}T235959`);
}

function integers(
  value: string,
  part: string,
  ok: (n: number) => boolean,
  errors: string[],
): number[] {
  const out: number[] = [];
  for (const item of value.split(',')) {
    if (!INTEGER.test(item) || !ok(Number(item))) {
      errors.push(`${part}: "${item}" is out of range`);
      continue;
    }
    out.push(Number(item));
  }
  return out;
}

function dateList(line: string, name: 'RDATE' | 'EXDATE', errors: string[]): string[] {
  const out: string[] = [];
  for (const item of line.slice(name.length + 1).split(',')) {
    const value = localDateTime(item);
    if (value === undefined) {
      errors.push(`${name}: "${item}" is not a local date-time YYYYMMDDTHHMMSS`);
    } else {
      out.push(value);
    }
  }
  return out;
}

/** Parses and checks a rule against the subset. */
export function parseRRule(text: string): RRuleParse {
  const errors: string[] = [];
  const [ruleLine = '', ...extra] = text.split('\n');
  const rdates: string[] = [];
  const exdates: string[] = [];
  for (const line of extra) {
    if (line.startsWith('RDATE:')) rdates.push(...dateList(line, 'RDATE', errors));
    else if (line.startsWith('EXDATE:')) exdates.push(...dateList(line, 'EXDATE', errors));
    else errors.push(`only RDATE: and EXDATE: lines may follow the rule, not "${line}"`);
  }
  const seen = new Map<Part, string>();
  for (const piece of ruleLine.split(';')) {
    const eq = piece.indexOf('=');
    const name = eq < 0 ? piece : piece.slice(0, eq);
    const value = eq < 0 ? '' : piece.slice(eq + 1);
    if (!isPart(name)) {
      errors.push(`${name === '' ? '(empty part)' : name} is not allowed (ADR 0001 decision 4)`);
      continue;
    }
    if (seen.has(name)) errors.push(`${name} appears twice`);
    if (value === '') errors.push(`${name} has no value`);
    seen.set(name, value);
  }

  const freqText = seen.get('FREQ');
  const freq = RRULE_FREQS.find((f) => f === freqText);
  if (freq === undefined) {
    errors.push(
      freqText === undefined
        ? 'FREQ is required'
        : `FREQ=${freqText} is not allowed; use ${RRULE_FREQS.join(', ')}`,
    );
  }
  const one = (part: Part, min: number, max: number): number | undefined => {
    const value = seen.get(part);
    if (value === undefined) return undefined;
    if (value.includes(',')) {
      errors.push(`${part} takes exactly one value`);
      return undefined;
    }
    const [n] = integers(value, part, (v) => v >= min && v <= max, errors);
    return n;
  };
  const interval = seen.has('INTERVAL') ? one('INTERVAL', 1, 1000) : 1;
  const hour = one('BYHOUR', 0, 23);
  const minute = one('BYMINUTE', 0, 59);
  if (!seen.has('BYHOUR')) errors.push('BYHOUR is required (exactly one hour)');
  if (!seen.has('BYMINUTE')) errors.push('BYMINUTE is required (exactly one minute)');
  const byMonth = seen.has('BYMONTH')
    ? integers(seen.get('BYMONTH') ?? '', 'BYMONTH', (n) => n >= 1 && n <= 12, errors)
    : [];
  const byMonthDay = seen.has('BYMONTHDAY')
    ? integers(
        seen.get('BYMONTHDAY') ?? '',
        'BYMONTHDAY',
        (n) => n !== 0 && n >= -31 && n <= 31,
        errors,
      )
    : [];
  const byDay: RRuleByDay[] = [];
  for (const item of seen.has('BYDAY') ? (seen.get('BYDAY') ?? '').split(',') : []) {
    const match = BYDAY_ENTRY.exec(item);
    if (match === null) {
      errors.push(`BYDAY: "${item}" is not a weekday with an optional ordinal +-1..+-5`);
      continue;
    }
    const [, ordinalText, weekday] = match;
    if (ordinalText === undefined) {
      byDay.push({ weekday: weekday as RRuleWeekday });
      continue;
    }
    const ordinal = Number(ordinalText);
    if (ordinal === 0 || Math.abs(ordinal) > 5) {
      errors.push(`BYDAY: ordinal ${ordinalText} is outside +-1..+-5`);
    } else if (!(freq === 'MONTHLY' || (freq === 'YEARLY' && byMonth.length > 0))) {
      errors.push(
        `BYDAY: an ordinal (${item}) is allowed only under MONTHLY, or YEARLY with BYMONTH`,
      );
    }
    byDay.push({ ordinal, weekday: weekday as RRuleWeekday });
  }
  const count = seen.has('COUNT') ? one('COUNT', 1, 100000) : undefined;
  let until: string | undefined;
  if (seen.has('UNTIL')) {
    const value = seen.get('UNTIL') ?? '';
    until = localDateTime(value) ?? localDate(value);
    if (until === undefined) {
      errors.push(`UNTIL: "${value}" is not a local date YYYYMMDD or date-time YYYYMMDDTHHMMSS`);
    }
  }
  if (seen.has('COUNT') && seen.has('UNTIL')) errors.push('COUNT and UNTIL cannot both be set');
  let wkst: RRuleWeekday | undefined;
  if (seen.has('WKST')) {
    wkst = RRULE_WEEKDAYS.find((d) => d === seen.get('WKST'));
    if (wkst === undefined) errors.push(`WKST: "${seen.get('WKST') ?? ''}" is not a weekday`);
  }

  if (
    errors.length > 0 ||
    freq === undefined ||
    interval === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    rule: {
      freq,
      interval,
      byMonth,
      byMonthDay,
      byDay,
      hour,
      minute,
      ...(count === undefined ? {} : { count }),
      ...(until === undefined ? {} : { until }),
      ...(wkst === undefined ? {} : { wkst }),
      rdates,
      exdates,
    },
  };
}

const compact = (iso: string) => iso.replace(/[-:]/g, '');

/**
 * CC's canonical text of a rule: parts in the order FREQ, INTERVAL (when not 1), BYMONTH,
 * BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, COUNT, UNTIL, WKST, then RDATE and EXDATE lines in date
 * order. The 02 §8.1 rules are already canonical.
 */
export function formatRRule(rule: ParsedRRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.map((d) => `${d.ordinal ?? ''}${d.weekday}`).join(',')}`);
  }
  parts.push(`BYHOUR=${rule.hour}`, `BYMINUTE=${rule.minute}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${compact(rule.until)}`);
  if (rule.wkst !== undefined) parts.push(`WKST=${rule.wkst}`);
  const lines = [parts.join(';')];
  const dates = (list: readonly string[]) => [...new Set(list)].sort().map(compact).join(',');
  if (rule.rdates.length > 0) lines.push(`RDATE:${dates(rule.rdates)}`);
  if (rule.exdates.length > 0) lines.push(`EXDATE:${dates(rule.exdates)}`);
  return lines.join('\n');
}

/** An RRULE of the ADR 0001 subset, as text. */
export const RRuleText = z
  .string()
  .regex(/^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/)
  .superRefine((text, ctx) => {
    const parsed = parseRRule(text);
    if (!parsed.ok) for (const message of parsed.errors) ctx.addIssue({ code: 'custom', message });
  })
  .describe(
    'RFC 5545 RRULE of the ADR 0001 subset, local to the time zone, optionally followed by RDATE: and EXDATE: lines',
  );
