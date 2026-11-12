# 0001. Recurrence and time-zone libraries

- **Status:** accepted
- **Date:** 2026-11-11
- **Task:** P0-03
- **Closes:** none (no open question ID covers this choice; it settles the library choice that
  08 §3 leaves to P0)
- **Spec:** [09 §5](../design/09-build-plan.md) row P0-03; rests on
  [02 §8.1](../design/02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata), 02 §4.1,
  02 §9.1-§9.2 and [08 §3](../design/08-repository-and-automation.md) (dependency rules D3, D4);
  changes 02 §7.1 and 02 §8.1 (see Consequences)

## Question

Which recurrence (RFC 5545 RRULE) library and which IANA time-zone library should
`cc-foundation` adopt so that the 02 §8.1 series and the due dates of a workstream in `America/New_York`
come out right, with output that does not depend on the host time zone, inside D4 (pure
`rhythm`, `domain`, `frameworks` and `policy`: no I/O, no clock, no randomness)?

## Method

Spike run 2026-11-09 on Linux x86_64, Node v22.23.3, ICU 78.3, tzdata 2026c, in a throwaway
directory. Candidates were the latest npm releases that day:

- recurrence: `rrule-temporal@2.2.8`, `rrule@2.8.1`, `ical.js@2.2.1`,
  `@rschedule/core@1.5.0` with its Luxon adapter;
- time zones: `temporal-polyfill@1.0.8`, `@js-temporal/polyfill@0.5.1`, `luxon@3.7.2`,
  `date-fns-tz@3.2.0`, `@date-fns/tz@1.5.0`;
- `.ics` writing: `ical-generator@11.1.3` and a ~50-line hand-written writer.

`rrule-rust` (a native addon) and `ics` (a third writer) were considered and not tested.

1. **Independent oracle.** Expected values come from pure integer civil-date arithmetic (no date
   library, no `Intl`, no host time zone): `Asia/Kolkata` fixed at +05:30, `America/New_York` on
   the US rule since 2007. No candidate grades itself.
2. **Recurrence fixtures, 28 per library:** the 8 series of 02 §8.1 in `Asia/Kolkata`, DTSTART
   synced to the first occurrence on or after 2026-11-09, compared instant by instant over
   2026-11-01 to 2028-12-31; 4 `America/New_York` fixtures (weekly 13:15, monthly `-1FR`, a
   Sunday 02:30 in the spring-forward gap, a Sunday 01:30 in the fall-back overlap); and 16
   unsynced-DTSTART variants seeded on 2026-11-04.
3. **Time-zone fixtures, 172 per library**, over every day of the transition week and the week
   after in March and November 2026 and 2027: a date-only New York due date to the IST instant
   it becomes overdue; a 17:00 New York due time to IST; a 13:15 IST weekly session to New
   York wall time; four New York wall times in a gap or overlap; and detection of every ISO week
   of 2026-2028 in which the New York offset changes.
4. **Host time-zone matrix:** every fixture file ran with `TZ` set to `UTC`, `Asia/Kolkata` and
   `America/New_York`.
5. **`.ics` round trip:** 314 VEVENTs (the 02 §4.1 scenario horizon from 2026-11-09 plus two New
   York series over two years, crossing four DST transitions), written by both writers in UTC
   and `TZID`+VTIMEZONE form, parsed back with `ical.js` and compared by instant, UID and
   SEQUENCE. RRULE text was also parsed and re-serialised.
6. **Packaging and performance:** install size, esbuild bundle size, import time, `tsc` under
   `strict` with `nodenext`, and seven runs of materialising the 8 IST series.

Commands, sizes and per-fixture figures are in
[0001-recurrence-and-time-zone-libraries/measurements.md](0001-recurrence-and-time-zone-libraries/measurements.md).

## Result

- **02 §8.1 holds.** Every library, once its output is read correctly, expands all 8 IST series
  right: first quarterly session Fri 2026-12-18 09:45 IST, first annual review Fri 2026-12-11
  09:45 IST, first monthly review Fri 2026-11-27 15:00 IST (AC-02-02). Over the 13-week horizon
  to 2027-02-07: daily 65, weekly 13, monthly 3, quarterly 1, yearly 1 (AC-02-01). An unsynced
  DTSTART added no occurrence for these rules.
- **Recurrence, 28 fixtures on 3 hosts:** `rrule-temporal` (TZID mode and floating mode) and
  `ical.js` in floating mode scored 28/28 on every host. `ical.js` in TZID mode and rSchedule
  scored 26/28 (wrong gap and overlap). `rrule` depends on the host time zone: read as its README
  says it scores 27/28 or 28/28 depending on host and has a fall-back-day bug; read naively it
  scores 0/28 on an IST or New York host.
- **RFC 5545 contradicts itself on DST gaps** (§3.3.10 says a nonexistent generated instance
  "MUST be ignored"; later text in the same section says to shift it as §3.3.5 does).
  `rrule-temporal` omits (upstream issue ggaabe/rrule-temporal#141); `rrule` and rSchedule shift;
  `ical.js` does neither. Overlaps are not contradictory: §3.3.5 takes the first occurrence.
  None of this affects the IST scenario, which has no DST.
- **Time zones, 172 fixtures on 3 hosts:** `temporal-polyfill`, `@js-temporal/polyfill` and
  `@date-fns/tz` scored 172/172 everywhere. Luxon scored 170/172 (takes the second occurrence on
  overlaps, with no option). `date-fns-tz` scored 170/172, or 168/172 with an IST host (wrong on
  gaps, host-dependent).
- **New York workstream dates:** a New York date-only due date becomes overdue at 10:30 IST (EST) or
  09:30 IST (EDT) the next day, after the 09:00 IST daily start, so the E1 flag first shows at
  the D+2 daily start. The 13:15 IST session always falls on the same New York calendar date.
  The weeks in which the New York offset changes start 2026-03-02, 2026-10-26, 2027-03-08,
  2027-11-01, 2028-03-06 and 2028-10-30.
- **`.ics`:** both writers in both forms parsed back 314/314 with no mismatch on all three
  hosts, CRLF only and lines within 75 octets. `ical-generator`'s TZID mode reads a native `Date`
  in the host's local time.
- **Surprises:**
  - With `TZ=Asia/Kolkata`, `Intl` and `Temporal.Now.timeZoneId()` report `Asia/Calcutta`, and
    `Intl.supportedValuesOf('timeZone')` omits `Asia/Kolkata`; Temporal accepts both and treats
    them as equal.
  - `rrule-temporal` returns objects from its own embedded polyfill unless constructed with
    `temporal: Temporal`; mixing implementations throws.
  - `rrule-temporal` with `strict: true` accepts `BYMONTH=13`, and in floating mode its
    `toString()` writes `TZID=UTC`, so a floating rule does not round-trip through it.
  - RDATE and EXDATE work in both modes.
- **Performance:** median materialisation of the 8 IST series was 4.0 ms (`rrule-temporal` TZID),
  13.9 ms (floating), 13.6 ms (`ical.js` floating), 26.4 ms (rSchedule), 61.4 ms (`rrule`), with
  up to 2× noise between runs. All are far inside the daily extension job's needs.
- **Not tested:** native Temporal in Electron 45 and Node 26 (neither binary starts on the spike
  host); the Google Calendar import of an export (AC-02-08); zones other than `Asia/Kolkata` and
  `America/New_York`, and rules outside 2026-2028; RRULE parts outside the subset in decision 4.

## Decision

1. **Time zones: Temporal**, from `temporal-polyfill@1.0.8`, pinned exactly. One module per
   process provides `Temporal` and every package imports it from there (where it lives is
   P0-01's layout call). Only that module may later switch to native Temporal, and it switches
   for the whole process, because objects from two implementations do not interoperate.
   Temporal was correct everywhere, has `PlainDate` (the `LocalDate` type), explicit
   `disambiguation` and `getTimeZoneTransition()`, and needs no host time zone.
2. **Recurrence: `rrule-temporal@2.2.8`**, pinned exactly, always constructed with
   `temporal: Temporal`, and used in **floating mode**: `packages/rhythm` expands on the wall
   clock (DTSTART without TZID) and attaches the series zone itself with Temporal (about 15 lines;
   see the measurements file). A generated local time in a **gap is omitted** (RFC 5545 §3.3.10
   "MUST be ignored", matching the library's own TZID mode and #141); an **overlap takes the
   first occurrence** (`disambiguation: 'earlier'`, §3.3.5). Floating mode keeps the DST rule in
   CC's tested code, avoids the library's recently fixed DST code paths (#136, #141), and keeps
   the library replaceable (`ical.js` floating is the tested drop-in). It is exact because
   decision 4 allows no frequency finer than daily.
3. **`.ics` export: no runtime library.** A ~50-line pure writer in `packages/rhythm` emits one
   VEVENT per instance with `UID:<instanceId>@command-center`, `SEQUENCE`, `DTSTAMP` from the
   injected clock, `SUMMARY`, `TRANSP:OPAQUE`, **UTC** `DTSTART`/`DTEND`, CRLF and 75-octet
   folding. UTC needs no VTIMEZONE, and per-instance events (02 §9.2 rule 1) gain nothing from
   TZID. `ical.js@2.2.1` is a devDependency only, to parse exports back in tests, which keeps its
   MPL-2.0 licence and its `skipLibCheck` problem out of shipped code.
4. **CC validates the rule before any library sees it.** The schema for `MeetingSeries.rrule` and
   `ProtectedBlock.rrule` allows only: `FREQ` in DAILY, WEEKLY, MONTHLY, YEARLY; `INTERVAL` ≥ 1;
   `BYDAY` ordinals ±1..±5 only under MONTHLY, or YEARLY with `BYMONTH`; `BYMONTH` 1-12;
   `BYMONTHDAY` ±1..±31; exactly one `BYHOUR` (0-23) and one `BYMINUTE` (0-59); optional `COUNT`
   or `UNTIL`; `WKST`; local `RDATE`/`EXDATE`. Anything else is `E_INVARIANT`. CC stores its own
   canonical string, never a library re-serialisation.
5. **DTSTART is synced to the first occurrence** when a series is created or changed (RFC 5545
   §3.8.5.3 leaves the set undefined otherwise).
6. **`IanaTimeZone` validates by construction:** it must parse as
   `Temporal.ZonedDateTime.from({ year: 2000, month: 1, day: 1, timeZone })`, never by membership
   in `Intl.supportedValuesOf`. Legacy link names are rewritten to current names on input
   (`Asia/Calcutta` → `Asia/Kolkata` and so on, from tzdata's `backward` file). Zones are compared
   through Temporal, never as strings.
7. **Due dates:** a date-only due date in zone Z is overdue from 00:00 of the next day in Z
   (`PlainDate(D+1).toZonedDateTime(Z)`); an explicit due time uses
   `disambiguation: 'compatible'` (RFC 5545 §3.3.5).
8. **The US daylight-saving check** (02 §8.1 notes; the owner's decision of 10 Nov 2026, option
   (c)): for any workstream whose recorded time zone observes US daylight saving (for example
   `America/New_York`), the check runs from the Monday before each US transition to the Friday
   after (12 days). There is no separate onboarding question: the condition is the time zone
   each workstream already records at S2, and Temporal gives the transitions. The spike's
   proposed content, which this ADR adopts, is one `attention` line in the daily start listing the
   workstream's open items due that week with both New York and IST times, plus the New York
   time of the 13:15 IST session. The same rule can later key on other zones' own transitions.

**Not chosen:**

- `rrule@2.8.1`: correct only on a UTC host or when every result is reinterpreted through the
  host zone; a fall-back-day bug; last release 2023-11, 185 open issues.
- `@rschedule/core@1.5.0`: last release 2023-02, no `exports` map, no types under `nodenext`,
  outdated Luxon peer range, wrong on overlaps.
- `ical.js` as the primary library: needs caller-supplied VTIMEZONE data, wrong on gap and
  overlap in TZID mode, MPL-2.0. Kept as test parser and fallback expander.
- Luxon: second occurrence on overlaps with no option; no plain-date type.
- `date-fns-tz`: wrong on gaps, host-dependent, 0.7-1.2 s unbundled import.
- `@date-fns/tz` (runner-up): correct and 1.7 KB gzip, but built on `Date`, so `LocalDate` and
  disambiguation would be hand-rolled, and no transition API.
- `@js-temporal/polyfill`: same results as `temporal-polyfill`, but 44 KB against 19 KB gzip,
  about 2× slower, last release 2025-03.
- DST check weeks (a) the week ending on the transition Sunday only, or (b) the working week
  after it only: the owner chose (c), which covers both warning in advance and the first week
  on the new offset.

## Consequences

- One model for time across schemas, domain, rhythm and the core: `LocalDate` is
  `Temporal.PlainDate`, UTC instants are `Temporal.Instant`. Output is deterministic on any host
  time zone, and `.ics` export has no runtime dependency, which fits D4.
- **Risks accepted:** `rrule-temporal` is young (first release April 2025, one maintainer);
  exact pinning, the oracle fixture suite and the tested `ical.js` fallback limit that.
  `rrule-temporal` embeds its own polyfill (together 71.5 KB gzip, about 56 KB duplicated);
  size does not matter in Electron or the CLI, and the renderer (D3) must not import it. Two
  polyfill copies exist in one process unless `temporal: Temporal` is always passed; a lint rule
  or wrapper constructor enforces it. A New York workstream's E1 flag shows one daily start later than for
  IST items, as the design is written.
- **Follow-up tasks:**
  1. P0-01: pin Electron and Node LTS and record `typeof Temporal` in the main process,
     `utilityProcess`, renderer and headless Node. Add a D4 lint rule banning `Temporal.Now.*`,
     `Date.now`, a bare `new Date()`, `Intl.DateTimeFormat().resolvedOptions()` and any import of
     `rrule-temporal` or Temporal outside the one module.
  2. Schemas: P1-01 has merged with a shape-only regex for `IanaTimeZone`
     (`packages/schemas/src/records/common.ts`); a follow-up PR replaces it with the refinement
     and alias map (decision 6). The RRULE subset schema (decision 4) lands with the
     `MeetingSeries` and `ProtectedBlock` schemas.
  3. P1-07: port the spike's oracle and fixtures as `packages/rhythm` fixture tests run under
     three `TZ=` hosts in CI, keeping `rrule-temporal` TZID mode and `ical.js` floating as
     differential oracles. Warn when a series' wall-clock time falls in a DST gap of its zone
     within the horizon. Build the daylight-saving check of decision 8 from the recorded time
     zone, with no new onboarding field.
  4. P1-09: the UTC `.ics` writer. AC-02-08's Google Calendar import still needs one manual
     check.
  5. Upstream reports, not yet filed: `ical.js` TZID-mode gap and overlap results contradict
     RFC 5545 §3.3.5; `rrule-temporal` `strict` accepts `BYMONTH=13`, and floating `toString()`
     writes `TZID=UTC`.
- **Design documents a later PR updates:**
  - [02 §7.1](../design/02-rhythm-and-calendar.md#71-carry-forward) rule 2: state that the
    due-date comparison with the instance's local start date is made in the item's time zone.
  - [02 §8.1](../design/02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata) notes:
    define the daylight-saving check as decision 8 states it (window, condition, content).
  - [08 §3](../design/08-repository-and-automation.md) stack table, "Dates and recurrence": name
    `temporal-polyfill` and `rrule-temporal`, citing this ADR.
  - 02 §3 / the schemas: the RRULE subset and `IanaTimeZone` rules (decisions 4 and 6), with
    follow-up 2.
- **Open questions:** none closed or opened. OQ-02-04 (then a live call across the IST and New
  York overlap; closed on 12 Nov 2026 when job search left the reference scenario) kept its
  default; the overlap windows it named move by an hour twice a year.

## Evidence

- Spike report, P0-03, 2026-11-09 (scout task; prototype in a throwaway directory, full source
  in the report's Appendix B), held with the supervising task records outside this repository.
- [0001-recurrence-and-time-zone-libraries/measurements.md](0001-recurrence-and-time-zone-libraries/measurements.md):
  candidate table, per-fixture results, expected values, commands, and the wall-clock expansion
  pattern (report Appendix A) that the decision relies on.
- RFC 5545 §3.3.5, §3.3.10, §3.8.5.3 (https://www.rfc-editor.org/rfc/rfc5545.txt).
- Upstream issues ggaabe/rrule-temporal#136 and #141.
- The owner's decision on the daylight-saving check window: phase-0 choices board, 10 Nov 2026,
  recorded in the spike report §9.
