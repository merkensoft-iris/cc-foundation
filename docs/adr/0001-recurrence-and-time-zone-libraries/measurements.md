# 0001 measurements

Supporting detail for [ADR 0001](../0001-recurrence-and-time-zone-libraries.md), condensed from the P0-03 spike report (run 2026-11-09, Linux x86_64, Node v22.23.3, ICU 78.3, tzdata 2026c). Every expected value comes from the independent oracle described in the ADR.

## Candidates

Versions are the latest on the npm registry on 2026-11-09. Install size is `du -sk node_modules/<pkg>` plus its dependencies. Bundle size is an esbuild 0.28.2 `--bundle --minify --format=esm --platform=neutral` build of a minimal import, also shown gzip `-9`. Import time is the best of 5 cold `await import()` runs. GitHub figures come from `gh-axi repo view`.

| Candidate                                                       | Need                            | Licence      | Latest release | First release | Install (with deps)               | Bundle min / gzip                                               | Import                                                                                  | TS types (`strict`, `nodenext`)                                                                                                                                                              | GitHub stars / open issues                         |
| --------------------------------------------------------------- | ------------------------------- | ------------ | -------------- | ------------- | --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `rrule-temporal@2.2.8`                                          | recurrence                      | MIT          | 2026-10-01     | 2025-04-21    | 492 KB + `temporal-spec` 72 KB    | 180.0 KB / 52.1 KB (embeds its own copy of `temporal-polyfill`) | 7.9 ms                                                                                  | yes, clean                                                                                                                                                                                   | 122 / 1 open (43 total, mostly fixed within weeks) |
| `rrule@2.8.1`                                                   | recurrence                      | BSD-3-Clause | **2023-11-10** | 2012          | 1012 KB + `tslib` 140 KB          | 45.9 KB / 13.6 KB                                               | 14 ms                                                                                   | yes, clean                                                                                                                                                                                   | 3752 / 185                                         |
| `ical.js@2.2.1`                                                 | recurrence, parse and serialise | MPL-2.0      | 2025-08-08     | 2014          | 1364 KB                           | 77.8 KB / 23.1 KB                                               | 6 ms                                                                                    | yes, but its own `.d.ts` files fail `tsc` under `nodenext` unless `skipLibCheck` is on (5 errors: TS2834, TS2610)                                                                            | 1184 / 52                                          |
| `@rschedule/core@1.5.0` + `@rschedule/luxon-date-adapter@1.5.0` | recurrence                      | Unlicense    | **2023-02-03** | 2019          | 812 + 136 KB, plus Luxon          | 192.2 KB / 48.5 KB (with Luxon)                                 | n/a                                                                                     | **no**: TS7016 under `nodenext`; no `exports` map, so Node ESM rejects its directory imports; the adapter declares the peer `luxon ^1 \|\| ^2`; `@rschedule/ical-tools` needs `ical.js ^1.3` | (GitLab)                                           |
| `temporal-polyfill@1.0.8` (fullcalendar)                        | time zones                      | MIT          | 2026-11-04     | 2021          | 1172 KB + `temporal-utils` 128 KB | 56.1 KB / 19.3 KB                                               | 12 ms                                                                                   | yes, clean                                                                                                                                                                                   | 788 / 5                                            |
| `@js-temporal/polyfill@0.5.1` (champions' polyfill)             | time zones                      | ISC          | 2025-03-31     | 2021          | 3020 KB + `jsbi` 608 KB           | 152.5 KB / 44.1 KB                                              | 24.7 ms                                                                                 | yes, clean                                                                                                                                                                                   | 797 / 47                                           |
| `luxon@3.7.2` (+ `@types/luxon@3.7.6`)                          | time zones                      | MIT          | 2025-09-05     | 2017          | 4608 KB                           | 70.9 KB / 21.9 KB                                               | 5.9 ms                                                                                  | via `@types`                                                                                                                                                                                 | 16458 / 158                                        |
| `date-fns-tz@3.2.0` (peer `date-fns@4.4.0`)                     | time zones                      | MIT          | 2024-09-30     | 2018          | 812 KB + `date-fns` 28 MB         | 28.6 KB / 8.4 KB                                                | **698 ms** unbundled (it loads the `date-fns` barrel; 714-1049 ms for `date-fns` alone) | yes                                                                                                                                                                                          | 1178 / 68                                          |
| `@date-fns/tz@1.5.0`                                            | time zones                      | MIT          | 2026-05-21     | 2024          | 228 KB                            | 4.8 KB / 1.7 KB                                                 | 5.5 ms                                                                                  | yes                                                                                                                                                                                          | (date-fns monorepo)                                |
| `ical-generator@11.1.3`                                         | `.ics` writer                   | MIT          | 2026-10-29     | 2013          | 852 KB                            | 36.3 KB / 9.1 KB                                                | 3.5 ms                                                                                  | yes                                                                                                                                                                                          | n/a                                                |
| hand-written writer (spike report Appendix B)                   | `.ics` writer                   | ours         | n/a            | n/a           | 0                                 | ~2 KB source                                                    | n/a                                                                                     | n/a                                                                                                                                                                                          | n/a                                                |

## Recurrence: 28 fixtures × 3 host time zones

| Library (mode)                                               | host `UTC` | host `Asia/Kolkata` | host `America/New_York` | Failures                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------- | ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rrule-temporal` (TZID mode)                                 | **28/28**  | **28/28**           | **28/28**               | none                                                                                                                                                                                                                                                                                                             |
| `rrule-temporal` (floating + CC's Temporal zone step)        | **28/28**  | **28/28**           | **28/28**               | none                                                                                                                                                                                                                                                                                                             |
| `ical.js` (floating + CC's Temporal zone step, no VTIMEZONE) | **28/28**  | **28/28**           | **28/28**               | none                                                                                                                                                                                                                                                                                                             |
| `ical.js` (TZID mode, hand-supplied VTIMEZONE)               | 26/28      | 26/28               | 26/28                   | gap: 02:30 becomes **01:30 EST** (an hour _before_ the gap, wrong under either RFC reading); overlap: picks the **second** 01:30 (EST)                                                                                                                                                                           |
| `@rschedule/core` + Luxon                                    | 26/28      | 26/28               | 26/28                   | gap: shifted to 03:30 EDT (the "shift" reading; see the ADR Result); overlap: picks the second 01:30 (EST)                                                                                                                                                                                                       |
| `rrule` (README reading: UTC fields = host wall clock)       | 27/28      | 27/28               | 28/28*                  | gap shifted to 03:30. With host UTC or Kolkata it also puts the **valid** time 2027-11-07 02:30 EST at 01:30 EST, an hour early on the fall-back day. *With host New York it passes all 28 only because the gap fixture counts as passing under the shift reading. Its behaviour changes with the host time zone |
| `rrule` (returned `Date` read as the instant)                | 27/28      | **0/28**            | **0/28**                | every instant is off by the host's UTC offset (for example 09:00 IST becomes 14:30 IST when the host is Kolkata)                                                                                                                                                                                                 |

Every library gets all 8 of the 02 §8.1 IST series right (synced and unsynced) once its output is read correctly. All agree that an unsynced DTSTART adds no extra occurrence for these rules. The expected dates, which are also the oracle's:

- `ser_ceo_monthly` (`-1FR`, 15:00): 2026-11-27, 2026-12-25, 2027-01-29, 02-26, 03-26, 04-30, 05-28, 06-25, 07-30, 08-27, 09-24, 10-29, 11-26, **2027-12-31**, 2028-01-28, 02-25, 03-31, 04-28, 05-26, 06-30, 07-28, 08-25, 09-29, 10-27, 11-24, 12-29. That is 26 instances.
- `ser_ceo_quarterly` (`BYMONTH=3,6,9,12;BYDAY=-2FR`, 09:45): **2026-12-18**, 2027-03-19, 06-18, 09-17, **2027-12-24**, 2028-03-24, 06-23, 09-22, 12-22. That is 9 instances.
- `ser_ceo_yearly` (`BYMONTH=12;BYDAY=2FR`, 09:45): **2026-12-11**, 2027-12-10, 2028-12-08.
- Counts from 2026-11-09 to 2028-12-31: daily start and shutdown 560 each; weekly CEO and the two weekly 13:15 sessions the scenario then had 112 each. Over the 13-week horizon (to 2027-02-07): daily 65, weekly 13, monthly 3, quarterly 1, yearly 1.

## Time zones: 172 fixtures × 3 host time zones

| Library                       | host `UTC`  | host `Asia/Kolkata` | host `America/New_York` | DST-week detection 2026-2028              | Failures                                                                                                                                                                           |
| ----------------------------- | ----------- | ------------------- | ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temporal-polyfill@1.0.8`     | **172/172** | **172/172**         | **172/172**             | correct; native `getTimeZoneTransition()` | none                                                                                                                                                                               |
| `@js-temporal/polyfill@0.5.1` | **172/172** | **172/172**         | **172/172**             | correct; native transition API            | none (about 2× slower: 17-26 ms against 7-8 ms per run)                                                                                                                            |
| `@date-fns/tz@1.5.0`          | **172/172** | **172/172**         | **172/172**             | correct, by comparing offsets             | none                                                                                                                                                                               |
| `luxon@3.7.2`                 | 170/172     | 170/172             | 170/172                 | correct                                   | overlap 01:30 New York becomes 12:00 IST (the **second** occurrence, EST); expected 11:00 IST (EDT). Luxon offers no option to choose                                              |
| `date-fns-tz@3.2.0`           | 170/172     | **168/172**         | 170/172                 | correct                                   | gap 02:30 New York becomes 12:00 IST (01:30 EST, an hour early); expected 13:00 IST. With host Kolkata, the overlap case also fails. Its behaviour changes with the host time zone |

Expected values, from the oracle, for the four DST weeks of 2026 and 2027:

- **T1, New York date-only due dates.** Due dates on or before a spring-forward Sunday become overdue at **10:30 IST** the next day (00:00 EST = 05:00Z). Due dates from that Sunday until the fall-back Saturday become overdue at **09:30 IST** (00:00 EDT). Examples: due 2026-03-07 is overdue from 2026-03-08 10:30 IST; due 2026-03-08 is overdue from 2026-03-09 09:30 IST. The same pattern holds in reverse in November: due 2026-10-31 is overdue from 2026-11-01 09:30 IST; due 2026-11-01 is overdue from 2026-11-02 10:30 IST. Both times are after the 09:00 IST daily start.
- **T2, a due time of 17:00 New York:** 03:30 IST the next day under EST, 02:30 IST under EDT.
- **T4, a weekly session at 13:15 IST:** 02:45 EST or 03:45 EDT, always on the **same calendar date** in New York.
- **T3 (RFC 5545 §3.3.5, which is Temporal's `compatible`):** 02:30 New York on 2026-03-08 and 2027-03-14 is 13:00 IST. 01:30 New York on 2026-11-01 and 2027-11-07 is 11:00 IST.
- **T5:** the ISO weeks in which the New York offset changes start 2026-03-02, 2026-10-26, 2027-03-08, 2027-11-01, 2028-03-06 and 2028-10-30. Each is the week whose Sunday is the transition.

## `.ics` export and RRULE text round trip

| Writer and form                                                              | 314 events parsed back by `ical.js` | Mismatched (instant, UID or SEQUENCE) | Size     | Longest line | CRLF only |
| ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------- | -------- | ------------ | --------- |
| hand writer, UTC `DTSTART:20261109T033000Z`                                  | 314                                 | **0** (all 3 hosts)                   | 62,466 B | 40 octets    | yes       |
| hand writer, `TZID` + VTIMEZONE built from Temporal transitions              | 314                                 | **0** (all 3 hosts)                   | 75,189 B | 41 octets    | yes       |
| `ical-generator`, UTC                                                        | 314                                 | **0** (all 3 hosts)                   | 57,718 B | 40 octets    | yes       |
| `ical-generator`, `TZID` (Luxon-zoned values + the same VTIMEZONE generator) | 314                                 | **0** (all 3 hosts)                   | 70,181 B | 41 octets    | yes       |

`ical-generator`'s own typings warn that in TZID mode a native `Date` is read in "the local time of the machine running the code" (`dist/index.d.mts` around lines 1777-1784 and 2307-2312), which is the host-time-zone trap again. It also ships no time-zone database: VTIMEZONE needs an external generator.

RRULE text round trip (parse, then serialise) for the 8 series:

- `rrule-temporal` keeps every rule part but reorders them (`FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,...`).
- `rrule` writes `BYDAY=+2FR` for `2FR`. That is valid RFC grammar but not the same text.
- `ical.js` keeps the text unchanged.
- In floating mode, `rrule-temporal.toString()` writes `DTSTART;TZID=UTC:...` and `EXDATE:...Z`, so a floating rule does **not** round-trip through the library. CC must store its own canonical string and never a library re-serialisation.

## Performance

| Library (mode)               | Median  | First run |
| ---------------------------- | ------- | --------- |
| `rrule-temporal` (TZID mode) | 4.0 ms  | 28 ms     |
| `rrule-temporal` (floating)  | 13.9 ms | 24 ms     |
| `ical.js` (floating)         | 13.6 ms | 19 ms     |
| rSchedule                    | 26.4 ms | 60 ms     |
| `rrule`                      | 61.4 ms | 74 ms     |

A previous run of the same benchmark gave 3.5, 7.4, 7.3, 14.7 and 42.6 ms, so there is noise of up to 2×. Every option is far inside the daily 00:05 extension job's needs.

## Commands run

Environment and install:

```bash
node -p "process.version+' icu '+process.versions.icu+' tz '+process.versions.tz"   # v22.23.3 icu 78.3 tz 2026c
mkdir spike-p0-03 && cd spike-p0-03 && npm init -y && npm pkg set type=module
npm install --no-audit --no-fund --legacy-peer-deps rrule@2.8.1 rrule-temporal@2.2.8 @rschedule/core@1.5.0 \
  @rschedule/luxon-date-adapter@1.5.0 @rschedule/ical-tools@1.5.0 ical.js@2.2.1 luxon@3.7.2 @types/luxon \
  temporal-polyfill@1.0.8 @js-temporal/polyfill@0.5.1 date-fns@4.4.0 date-fns-tz@3.2.0 @date-fns/tz@1.5.0 \
  ical-generator@11.1.3 typescript@5 esbuild @types/node@22
# (--legacy-peer-deps: ical-generator lists optional peers such as rrule, luxon and moment)
for p in <each package>; do npm view $p version license time dependencies peerDependencies repository.url; done
for r in ggaabe/rrule-temporal jkbrzt/rrule kewisch/ical.js fullcalendar/temporal-polyfill js-temporal/temporal-polyfill moment/luxon marnusw/date-fns-tz; do gh-axi repo view -R $r; done
gh-axi issue list -R ggaabe/rrule-temporal --state all; gh-axi issue view 141 -R ggaabe/rrule-temporal
curl -sS -o rfc/rfc5545.txt https://www.rfc-editor.org/rfc/rfc5545.txt   # quoted lines 1890-1900, 2382-2386, 2492-2496, 6821-6823
```

Fixtures, each on three host time zones:

```bash
for tz in UTC Asia/Kolkata America/New_York; do
  TZ=$tz node recur-fixtures.mjs > out-recur-$tz.json    # 28 fixtures × 7 library modes
  TZ=$tz node tz-fixtures.mjs    > out-tz-$tz.json       # 172 fixtures × 5 libraries + DST-week detection
  TZ=$tz node ics-fixtures.mjs   > out-ics-$tz.json      # 314 events × 4 writer modes + RRULE text round trip
done
node summarize.mjs out-recur-UTC.json                    # per-fixture PASS/FAIL lines
TZ=UTC node bench.mjs                                    # materialisation timing
```

Sizes, types, interop and native Temporal:

```bash
esbuild <entry>.mjs --bundle --minify --format=esm --platform=neutral --outfile=out/<n>.js; gzip -9c out/<n>.js | wc -c
du -sk node_modules/<pkg>
node --input-type=module -e "const t0=performance.now(); await import('<pkg>'); console.log(performance.now()-t0)"   # best of 5
tsc -p tscheck --noEmit     # strict, module/moduleResolution nodenext, skipLibCheck false
npm install node@26 electron@45.2.3 && node node_modules/electron/install.js
#   -> node 26: "libatomic.so.1: cannot open shared object file"; electron: "libglib-2.0.so.0: cannot open shared object file"
grep -a -o "harmony[-_]temporal[a-z_-]*" node_modules/electron/dist/electron   # 1 hit: harmony_temporal
```

Key raw output (host `UTC`, recurrence; other hosts in the recurrence table above):

```text
rrule-temporal@2.2.8 | ser_ceo_quarterly | exp=9  | got=9  | 2026-12-18T09:45+05:30 | PASS
rrule-temporal@2.2.8 | ser_ceo_yearly    | exp=3  | got=3  | 2026-12-11T09:45+05:30 | PASS
rrule-temporal@2.2.8 | ser_ceo_monthly   | exp=26 | got=26 | 2026-11-27T15:00+05:30 | PASS
ical.js (TZID)       | ny_gap_SU_02:30     | FAIL extra ["2027-03-14T01:30-05:00","2028-03-12T01:30-05:00"]
ical.js (TZID)       | ny_overlap_SU_01:30 | FAIL got ["2027-11-07T01:30-05:00",...] expected ["2027-11-07T01:30-04:00",...]
rschedule+luxon      | ny_gap_SU_02:30     | FAIL extra ["2027-03-14T03:30-04:00","2028-03-12T03:30-04:00"]   (shift reading)
rrule (README)       | ny_gap_SU_02:30     | FAIL missing ["2027-11-07T02:30-05:00",...] extra ["2027-03-14T03:30-04:00","2027-11-07T01:30-05:00"]
host Asia/Kolkata: rrule (Date as instant) 0/28, e.g. ser_daily_start 09:00+05:30 -> 14:30+05:30
```

```text
luxon@3.7.2       170/172  2026-11-01T01:30 => 2026-11-01T12:00+05:30 (exp 11:00+05:30)
date-fns-tz@3.2.0 170/172  2026-03-08T02:30 => 2026-03-08T12:00+05:30 (exp 13:00+05:30)   [168/172 with host Asia/Kolkata]
temporal-polyfill, @js-temporal/polyfill, @date-fns/tz: 172/172 on all three hosts
ics: 314 events; hand writer utc/tzid and ical-generator utc/tzid all "mismatched 0" on all three hosts
```

## Wall-clock expansion pattern (report Appendix A)

```js
// Expand on the wall clock, then attach the series zone. Gap -> omit (RFC 5545 §3.3.10 "MUST be ignored"),
// overlap -> first occurrence (§3.3.5). Exact for FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with one BYHOUR and one BYMINUTE.
import { Temporal } from 'temporal-polyfill';
import { RRuleTemporal } from 'rrule-temporal';

const toZoned = (plainIso, zone) => {
  const p = Temporal.PlainDateTime.from(plainIso);
  try {
    p.toZonedDateTime(zone, { disambiguation: 'reject' });
  } catch {
    // 'reject' throws on gaps and on overlaps; it is a gap only if the wall clock moves
    if (!p.toZonedDateTime(zone, { disambiguation: 'earlier' }).toPlainDateTime().equals(p))
      return null;
  }
  return p.toZonedDateTime(zone, { disambiguation: 'earlier' }).epochMilliseconds;
};
// window [a, b] in UTC ms; dtstart is the local wall clock 'YYYY-MM-DDTHH:MM'
function expand(rrule, zone, dtstart, a, b) {
  const basic = dtstart.replace(/[-:]/g, '') + '00';
  const r = new RRuleTemporal({
    temporal: Temporal,
    rruleString: `DTSTART:${basic}\nRRULE:${rrule}`,
  });
  const floatEdge = (ms, pad) =>
    new Date(
      Temporal.Instant.fromEpochMilliseconds(ms)
        .toZonedDateTimeISO(zone)
        .toPlainDateTime()
        .toZonedDateTime('UTC').epochMilliseconds + pad,
    );
  return r
    .between(floatEdge(a, -864e5), floatEdge(b, 864e5), true) // floating results come back UTC-zoned
    .map((z) => toZoned(z.toPlainDateTime().toString(), zone))
    .filter((ms) => ms !== null && ms >= a && ms <= b);
}
// A date-only due date in zone Z is overdue from 00:00 of the next day in Z
const overdueFrom = (date, zone) =>
  Temporal.PlainDate.from(date).add({ days: 1 }).toZonedDateTime({ timeZone: zone }).toInstant();
// The DST-check week test: does the zone's offset change inside [weekStart, weekStart + 7 days)?
const offsetChanges = (mondayIso, zone) => {
  const s = Temporal.PlainDate.from(mondayIso).toZonedDateTime({ timeZone: zone });
  const t = s.getTimeZoneTransition('next');
  return !!t && Temporal.ZonedDateTime.compare(t, s.add({ days: 7 })) < 0;
};
```

Appendix A was run as written (`appendixA-check.mjs`, spike report Appendix B) against the 12 synced recurrence fixtures with hosts UTC, Asia/Kolkata and America/New_York. It scored 12/12 on each host. `overdueFrom('2026-03-07', NY)` gives 2026-03-08T10:30+05:30. `offsetChanges` finds exactly the six T5 weeks.
