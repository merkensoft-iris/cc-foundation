/**
 * RRULE expansion fixtures, ported from the P0-03 spike (ADR 0001 measurements): the 8 series of
 * 02 §8.1 in Asia/Kolkata and 4 America/New_York rules (a weekly 13:15, a monthly -1FR, a Sunday
 * 02:30 in the spring-forward gap, a Sunday 01:30 in the fall-back overlap), compared instant by
 * instant over 2026-11-09 to 2028-12-31 against an independent oracle of integer civil-date
 * arithmetic (no date library, no Intl, no host time zone). Every fixture runs under three host
 * time zones. `rrule-temporal` in TZID mode and `ical.js` in floating mode are kept as
 * differential oracles (ADR 0001 follow-up 3).
 */
import ICAL from 'ical.js';
import { RRuleTemporal } from 'rrule-temporal';
import { describe, expect, it } from 'vitest';

import {
  canonicalRule,
  expand,
  firstOccurrenceOnOrAfter,
  materialise,
  wallClockInstant,
} from '@cc/rhythm';
import { Temporal, type MeetingSeries } from '@cc/schemas';

import {
  failure,
  harness,
  HOST_ZONES,
  onHost,
  rhythm,
  scenarioSeries,
  wigSeries,
} from './harness.ts';

// ---- The oracle: integer civil-date arithmetic only. ----

/** Days since 1970-01-01 of a civil date (H. Hinnant's algorithm). */
function days(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** 0 = Monday ... 6 = Sunday. */
const weekday = (y: number, m: number, d: number) => (((days(y, m, d) + 3) % 7) + 7) % 7;
const dim = (y: number, m: number) =>
  days(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - days(y, m, 1);
const WD = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 } as const;

/** The n-th Sunday of a month (1-based). */
const nthSunday = (y: number, m: number, n: number) => {
  const first = 1 + ((6 - weekday(y, m, 1) + 7) % 7);
  return first + 7 * (n - 1);
};

/** UTC offset in minutes of a local wall time; null in a gap. US rule since 2007. */
function offset(zone: 'IST' | 'NY', y: number, m: number, d: number, h: number): number | null {
  if (zone === 'IST') return 330;
  const spring = nthSunday(y, 3, 2);
  const fall = nthSunday(y, 11, 1);
  if (m === 3 && d === spring && h === 2) return null; // 02:00-02:59 does not exist
  let dst = m > 3 && m < 11;
  if (m === 3) dst = d > spring || (d === spring && h >= 3);
  if (m === 11) dst = d < fall || (d === fall && h < 2); // the overlap takes the first (EDT)
  return dst ? -240 : -300;
}

function utcOf(zone: 'IST' | 'NY', y: number, m: number, d: number, h: number, mi: number) {
  const off = offset(zone, y, m, d, h);
  if (off === null) return null;
  const ms = (days(y, m, d) * 1440 + h * 60 + mi - off) * 60000;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

type Match = (y: number, m: number, d: number) => boolean;
const weekly =
  (...wd: (keyof typeof WD)[]): Match =>
  (y, m, d) =>
    wd.some((w) => WD[w] === weekday(y, m, d));
const lastFriday: Match = (y, m, d) => weekday(y, m, d) === 4 && d + 7 > dim(y, m);
const secondLastFridayOf =
  (...months: number[]): Match =>
  (y, m, d) =>
    months.includes(m) && weekday(y, m, d) === 4 && d + 7 <= dim(y, m) && d + 14 > dim(y, m);
const secondFridayOf =
  (month: number): Match =>
  (y, m, d) =>
    m === month && weekday(y, m, d) === 4 && d >= 8 && d <= 14;

function oracle(zone: 'IST' | 'NY', match: Match, h: number, mi: number, from: string, to: string) {
  const out: string[] = [];
  let [y, m, d] = from.split('-').map(Number) as [number, number, number];
  const end = to.split('-').map(Number) as [number, number, number];
  while (days(y, m, d) <= days(...end)) {
    if (match(y, m, d)) {
      const at = utcOf(zone, y, m, d, h, mi);
      if (at !== null) out.push(at);
    }
    d++;
    if (d > dim(y, m)) {
      d = 1;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

// ---- Fixtures. ----

interface Fixture {
  readonly name: string;
  readonly rrule: string;
  readonly zone: string;
  readonly oracle: () => string[];
}

const FROM = '2026-11-09';
const TO = '2028-12-31';
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

const FIXTURES: Fixture[] = [
  ...scenarioSeries().map((s): Fixture => {
    const matchers: Record<string, Match> = {
      ser_daily_start: weekly('MO', 'TU', 'WE', 'TH', 'FR'),
      ser_daily_shutdown: weekly('MO', 'TU', 'WE', 'TH', 'FR'),
      ser_ceo_weekly: weekly('FR'),
      ser_ceo_monthly: lastFriday,
      ser_ceo_quarterly: secondLastFridayOf(3, 6, 9, 12),
      ser_ceo_yearly: secondFridayOf(12),
    };
    const [h, mi] = s.dtstart.slice(11).split(':').map(Number) as [number, number];
    const match = matchers[s.id];
    if (match === undefined) throw new Error(s.id);
    return {
      name: s.id,
      rrule: s.rrule,
      zone: IST,
      oracle: () => oracle('IST', match, h, mi, FROM, TO),
    };
  }),
  {
    name: 'ny_weekly_TH_13:15',
    rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=13;BYMINUTE=15',
    zone: NY,
    oracle: () => oracle('NY', weekly('TH'), 13, 15, FROM, TO),
  },
  {
    name: 'ny_monthly_-1FR_15:00',
    rrule: 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0',
    zone: NY,
    oracle: () => oracle('NY', lastFriday, 15, 0, FROM, TO),
  },
  {
    name: 'ny_gap_SU_02:30',
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=2;BYMINUTE=30',
    zone: NY,
    oracle: () => oracle('NY', weekly('SU'), 2, 30, FROM, TO),
  },
  {
    name: 'ny_overlap_SU_01:30',
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=1;BYMINUTE=30',
    zone: NY,
    oracle: () => oracle('NY', weekly('SU'), 1, 30, FROM, TO),
  },
];

const window = (zone: string) => ({
  from: Temporal.PlainDate.from(FROM).toZonedDateTime({ timeZone: zone }).toInstant().toString(),
  to: Temporal.PlainDate.from(TO)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: zone })
    .toInstant()
    .toString(),
});

function rule(f: Fixture) {
  const dtstart = firstOccurrenceOnOrAfter(f.rrule, f.zone, FROM);
  if (dtstart === undefined) throw new Error(f.name);
  return { rrule: f.rrule, dtstart, timeZone: f.zone };
}

/** rrule-temporal in TZID mode: the library attaches the zone itself. */
function tzidMode(f: Fixture): string[] {
  const { dtstart } = rule(f);
  const r = new RRuleTemporal({
    temporal: Temporal as never,
    rruleString: `DTSTART;TZID=${f.zone}:${dtstart.replace(/[-:]/g, '')}00\nRRULE:${f.rrule}`,
  });
  const w = window(f.zone);
  return r
    .between(new Date(w.from), new Date(w.to), true)
    .map((z) => Temporal.ZonedDateTime.from(z.toString()).toInstant().toString())
    .filter((at) => at < w.to);
}

/** ical.js in floating mode, with the zone attached as CC does. */
function icalFloating(f: Fixture): string[] {
  const { dtstart } = rule(f);
  const recur = ICAL.Recur.fromString(f.rrule);
  const iterator = recur.iterator(ICAL.Time.fromDateTimeString(`${dtstart}:00`));
  const w = window(f.zone);
  const out: string[] = [];
  for (let next = iterator.next(); next !== null && next !== undefined; next = iterator.next()) {
    const local = next.toString().slice(0, 16);
    const at = wallClockInstant(local, f.zone);
    if (at === undefined) continue;
    if (at >= w.to) break;
    if (at >= w.from) out.push(at);
  }
  return out;
}

describe.each(HOST_ZONES)('RRULE expansion on host TZ=%s', (host) => {
  onHost(host);

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s matches the oracle', (_name, f) => {
    const w = window(f.zone);
    const got = expand(rule(f), w.from, w.to).occurrences.map((o) => o.start);
    expect(got).toEqual(f.oracle());
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    '%s agrees with rrule-temporal TZID mode and ical.js floating',
    (_name, f) => {
      const w = window(f.zone);
      const got = expand(rule(f), w.from, w.to).occurrences.map((o) => o.start);
      expect(icalFloating(f)).toEqual(got);
      if (f.name !== 'ny_gap_SU_02:30') expect(tzidMode(f)).toEqual(got);
    },
  );

  it('02 §8.1 dates and counts hold (ADR 0001 measurements)', () => {
    const at = (id: string) => {
      const s = scenarioSeries().find((x) => x.id === id) as MeetingSeries;
      const w = window(IST);
      return expand(s, w.from, w.to).occurrences.map((o) => o.local);
    };
    expect(at('ser_ceo_monthly').map((l) => l.slice(0, 10))).toEqual([
      '2026-11-27',
      '2026-12-25',
      '2027-01-29',
      '2027-02-26',
      '2027-03-26',
      '2027-04-30',
      '2027-05-28',
      '2027-06-25',
      '2027-07-30',
      '2027-08-27',
      '2027-09-24',
      '2027-10-29',
      '2027-11-26',
      '2027-12-31',
      '2028-01-28',
      '2028-02-25',
      '2028-03-31',
      '2028-04-28',
      '2028-05-26',
      '2028-06-30',
      '2028-07-28',
      '2028-08-25',
      '2028-09-29',
      '2028-10-27',
      '2028-11-24',
      '2028-12-29',
    ]);
    expect(at('ser_ceo_quarterly')).toEqual([
      '2026-12-18T09:45',
      '2027-03-19T09:45',
      '2027-06-18T09:45',
      '2027-09-17T09:45',
      '2027-12-24T09:45',
      '2028-03-24T09:45',
      '2028-06-23T09:45',
      '2028-09-22T09:45',
      '2028-12-22T09:45',
    ]);
    expect(at('ser_ceo_yearly')).toEqual([
      '2026-12-11T09:45',
      '2027-12-10T09:45',
      '2028-12-08T09:45',
    ]);
    expect(at('ser_daily_start')).toHaveLength(560);
    expect(at('ser_daily_shutdown')).toHaveLength(560);
    expect(at('ser_ceo_weekly')).toHaveLength(112);
  });

  it('a gap is omitted and reported, an overlap takes the first occurrence (ADR 0001 decision 2)', () => {
    const gap = FIXTURES.find((f) => f.name === 'ny_gap_SU_02:30') as Fixture;
    const w = window(NY);
    const result = expand(rule(gap), w.from, w.to);
    expect(result.gaps).toEqual(['2027-03-14T02:30', '2028-03-12T02:30']);
    const overlap = FIXTURES.find((f) => f.name === 'ny_overlap_SU_01:30') as Fixture;
    const fall = expand(rule(overlap), w.from, w.to).occurrences.find(
      (o) => o.local === '2027-11-07T01:30',
    );
    expect(fall?.start).toBe('2027-11-07T05:30:00Z'); // 01:30 EDT, the first
  });

  it('an unsynced start date syncs DTSTART to the first occurrence (ADR 0001 decision 5)', () => {
    for (const s of scenarioSeries()) {
      expect(firstOccurrenceOnOrAfter(s.rrule, IST, '2026-11-04')).toBe(
        s.id === 'ser_daily_start' || s.id === 'ser_daily_shutdown'
          ? `2026-11-04T${s.dtstart.slice(11)}`
          : s.id === 'ser_ceo_weekly'
            ? '2026-11-06T15:00'
            : s.dtstart,
      );
      expect(firstOccurrenceOnOrAfter(s.rrule, IST, '2026-11-09')).toBe(s.dtstart);
    }
  });
});

describe('the RRULE subset (ADR 0001 decision 4)', () => {
  it('keeps the 02 §8.1 rules as they are: they are canonical', () => {
    for (const s of scenarioSeries()) expect(canonicalRule(s.rrule)).toBe(s.rrule);
  });

  it('writes parts in CC order and sorts RDATE and EXDATE', () => {
    expect(
      canonicalRule(
        'FREQ=MONTHLY;BYMINUTE=0;BYHOUR=15;BYDAY=-1FR\nEXDATE:20261225T150000,20261127T150000',
      ),
    ).toBe('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0\nEXDATE:20261127T150000,20261225T150000');
  });

  it.each([
    ['FREQ=HOURLY;BYHOUR=9;BYMINUTE=0', 'FREQ=HOURLY'],
    ['FREQ=WEEKLY;BYDAY=FR;BYHOUR=9,10;BYMINUTE=0', 'BYHOUR takes exactly one value'],
    ['FREQ=WEEKLY;BYDAY=FR;BYMINUTE=0', 'BYHOUR is required'],
    ['FREQ=WEEKLY;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0', 'only under MONTHLY'],
    ['FREQ=YEARLY;BYDAY=2FR;BYHOUR=9;BYMINUTE=0', 'only under MONTHLY'],
    ['FREQ=MONTHLY;BYDAY=6FR;BYHOUR=9;BYMINUTE=0', 'outside +-1..+-5'],
    ['FREQ=YEARLY;BYMONTH=13;BYHOUR=9;BYMINUTE=0', 'BYMONTH'],
    ['FREQ=MONTHLY;BYMONTHDAY=0;BYHOUR=9;BYMINUTE=0', 'BYMONTHDAY'],
    ['FREQ=WEEKLY;BYSETPOS=1;BYHOUR=9;BYMINUTE=0', 'BYSETPOS is not allowed'],
    ['FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;COUNT=3;UNTIL=20270101', 'COUNT and UNTIL'],
    ['FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0\nEXDATE:20261225T150000Z', 'EXDATE'],
    ['FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0\nRDATE:20260231T090000', 'RDATE'],
  ])('refuses %j with E_INVARIANT', (text, message) => {
    const error = failure(() => canonicalRule(text));
    expect(error.code).toBe('E_INVARIANT');
    expect(error.rule).toBe('ADR 0001 decision 4');
    expect([error.message, ...error.help].join(' ')).toContain(message);
  });

  it('applies RDATE, EXDATE and UNTIL on the wall clock', () => {
    const s = {
      rrule:
        'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0;UNTIL=20261218\nRDATE:20261202T110000\nEXDATE:20261204T150000',
      dtstart: '2026-11-13T15:00',
      timeZone: IST,
    };
    const got = expand(s, '2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z').occurrences.map(
      (o) => o.local,
    );
    expect(got).toEqual([
      '2026-11-13T15:00',
      '2026-11-20T15:00',
      '2026-11-27T15:00',
      '2026-12-02T11:00',
      '2026-12-11T15:00',
      '2026-12-18T15:00',
    ]);
  });
});

describe('materialisation warns about DST gaps (ADR 0001 follow-up 3)', () => {
  it('a New York Sunday 02:30 series gets W-DST-GAP for 2027-03-14 and omits it', () => {
    const { ctx, clock } = harness('2027-02-01T00:00:00Z');
    clock.set('2027-02-01T00:00:00Z');
    const base = wigSeries();
    const series: MeetingSeries = {
      ...base,
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=2;BYMINUTE=30',
      dtstart: '2027-02-07T02:30',
      timeZone: NY,
    };
    const result = materialise(ctx, rhythm, { series: [series], instances: [] });
    expect(result.warnings).toEqual([
      { code: 'W-DST-GAP', seriesId: series.id, local: '2027-03-14T02:30' },
    ]);
    expect(result.instances.map((i) => i.occurrenceStart)).not.toContain('2027-03-14T07:30:00Z');
    expect(result.instances).toHaveLength(12);
  });
});
