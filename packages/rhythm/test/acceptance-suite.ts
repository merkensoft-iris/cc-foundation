/**
 * The P1-07 acceptance criteria (09 §6.1): AC-01-05, AC-02-01, AC-02-02, AC-02-06, AC-02-07, on
 * the 02 §8.1 scenario series seeded on 2026-11-04 with a fake clock.
 *
 * The suite takes the store it runs the engine jobs on: acceptance.test.ts runs it on the
 * in-memory fake, and packages/core/test/rhythm-store.test.ts on the workspace store (P1-02),
 * where only the core may import @cc/store (D5).
 */
import { describe, expect, it } from 'vitest';

import {
  blockIntervals,
  checkPlacement,
  completeMeeting,
  composeAgenda,
  expand,
  extendHorizon,
  horizonWindow,
  incrementsCarryCount,
  localDate,
  localDateTime,
  RHYTHM_ESCALATION_OPTIONS,
  runMissedCheck,
  seriesIntervals,
  skipInstance,
  startMeeting,
  startOfDay,
} from '@cc/rhythm';
import type { ActionItem, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { MONTHLY, WEEKLY } from './agendas.ts';
import {
  agentCaller,
  checkChanges,
  failure,
  harness,
  HOST_ZONES,
  onHost,
  scenarioPlacement,
  scenarioSeries,
  seriesById,
  user,
  type TestRhythmStore,
} from './harness.ts';

const IST = 'Asia/Kolkata';

/** Makes the store a test runs on, holding `series` and nothing else. */
export type MakeStore = (series: readonly MeetingSeries[]) => TestRhythmStore;

const ofSeries = (instances: Iterable<MeetingInstance>, id: string) =>
  [...instances]
    .filter((i) => i.seriesId === id)
    .sort((a, b) => a.occurrenceStart.localeCompare(b.occurrenceStart));

const onDate = (instances: Iterable<MeetingInstance>, id: string, date: string) => {
  const found = ofSeries(instances, id).find((i) => localDate(i.occurrenceStart, IST) === date);
  if (found === undefined) throw new Error(`${id} has no instance on ${date}`);
  return found;
};

/** Declares the acceptance tests on the stores `makeStore` makes. */
export function describeAcceptance(makeStore: MakeStore): void {
  function seed(series = scenarioSeries()) {
    const h = harness('2026-11-04T04:10:00Z');
    const store = makeStore(series);
    extendHorizon(store, h.ctx, scenarioPlacement());
    return { ...h, store };
  }

  describe.each(HOST_ZONES)('on host TZ=%s', (host) => {
    onHost(host);

    it('AC-02-01 seeding on 2026-11-04 materialises daily and weekly instances from 2026-11-09 to 2027-02-05, as many as the RRULE expansion, and a second run changes nothing', () => {
      const { ctx, store } = seed();
      for (const id of ['ser_daily_start', 'ser_daily_shutdown', 'ser_ceo_weekly']) {
        const series = seriesById(id);
        const instances = ofSeries(store.instances.values(), id);
        const dates = instances.map((i) => localDate(i.scheduledStart, IST));
        expect(dates[0]! >= '2026-11-09').toBe(true);
        expect(dates.at(-1)! <= '2027-02-05').toBe(true);
        const window = horizonWindow(series, '2026-11-04T04:10:00Z');
        expect(window.from).toBe(startOfDay(series.dtstart.slice(0, 10), IST));
        const expansion = expand(series, window.from, window.to).occurrences;
        expect(instances.map((i) => i.occurrenceStart)).toEqual(expansion.map((o) => o.start));
        expect(instances).toHaveLength(id.startsWith('ser_daily') ? 65 : 13);
      }
      expect(
        localDate(
          ofSeries(store.instances.values(), 'ser_daily_start').at(-1)!.scheduledStart,
          IST,
        ),
      ).toBe('2027-02-05');
      expect(ofSeries(store.instances.values(), 'ser_ceo_monthly')).toHaveLength(4);
      expect(ofSeries(store.instances.values(), 'ser_ceo_quarterly')).toHaveLength(2);
      expect(ofSeries(store.instances.values(), 'ser_ceo_yearly')).toHaveLength(1);

      const count = store.instances.size;
      const again = extendHorizon(store, ctx, scenarioPlacement());
      expect(again.status).toBe('no-op');
      expect(again.changes).toEqual([]);
      expect(store.instances.size).toBe(count);
      expect(store.commits).toHaveLength(1);
    });

    it('AC-02-02 the 2026-11-27 weekly CEO review is absorbed by the monthly review of the same date, which runs 15:00-17:00 IST and begins with the weekly backbone sections', () => {
      const { store } = seed();
      const weekly = onDate(store.instances.values(), 'ser_ceo_weekly', '2026-11-27');
      const monthly = onDate(store.instances.values(), 'ser_ceo_monthly', '2026-11-27');
      expect(weekly.state).toBe('absorbed');
      expect(weekly.absorbedBy).toBe(monthly.id);
      expect(monthly.absorbedInstanceIds).toEqual([weekly.id]);
      expect(localDateTime(monthly.scheduledStart, IST)).toBe('2026-11-27T15:00');
      expect(localDateTime(monthly.scheduledEnd, IST)).toBe('2026-11-27T17:00');

      const monthlySeries = seriesById('ser_ceo_monthly');
      const weeklySeries = seriesById('ser_ceo_weekly');
      const agenda = composeAgenda({
        template: MONTHLY,
        series: monthlySeries,
        absorbed: [
          { instanceId: weekly.id, template: WEEKLY, series: weeklySeries, absorbedMinutes: 30 },
        ],
      });
      const absorbed = agenda.filter((s) => s.absorbedFrom === weekly.id);
      expect(agenda.slice(0, absorbed.length)).toEqual(absorbed);
      expect(absorbed.map((s) => [s.sectionId, s.workstreamId ?? null])).toEqual([
        ['check_in', null],
        ['scorecard', 'ws_ald'],
        ['goals_review', 'ws_ald'],
        ['action_review', 'ws_ald'],
        ['scorecard', 'ws_qlm'],
        ['goals_review', 'ws_qlm'],
        ['action_review', 'ws_qlm'],
        ['headlines', null],
        ['issues', null],
        ['conclude', null],
      ]);
      expect(absorbed.reduce((sum, s) => sum + s.timeboxMinutes, 0)).toBe(30);
      const own = agenda.slice(absorbed.length);
      expect(own.map((s) => s.sectionId)).toEqual(MONTHLY.sections.map((s) => s.id));
      expect(own.reduce((sum, s) => sum + s.timeboxMinutes, 0)).toBe(90);
    });

    it('AC-02-06 skipping the 2026-12-25 weekly meeting with the reason "holiday" increments no carryCount', () => {
      const item: Pick<ActionItem, 'workstreamId' | 'due' | 'lifecycle'> = {
        workstreamId: 'ws_ald',
        due: { date: '2026-11-13', timeZone: IST },
        lifecycle: 'open',
      };
      // On the scenario, 2026-12-25 is the last Friday: the monthly review absorbs that week's
      // review, so the meeting held that day is the monthly instance. Skipping it skips both.
      const { ctx, clock, store } = seed();
      clock.set('2026-12-20T04:00:00Z');
      extendHorizon(store, ctx, scenarioPlacement());
      const weekly = onDate(store.instances.values(), 'ser_ceo_weekly', '2026-12-25');
      const monthly = onDate(store.instances.values(), 'ser_ceo_monthly', '2026-12-25');
      expect(weekly.state).toBe('absorbed');
      const skipped = skipInstance(ctx, user, monthly, 'holiday');
      checkChanges(skipped.changes);
      expect(skipped.record.state).toBe('skipped');
      expect(skipped.record.skipReason).toBe('holiday');
      expect(incrementsCarryCount(seriesById('ser_ceo_monthly'), skipped.record, item)).toBe(false);
      expect(incrementsCarryCount(weeklySeriesOf(), weekly, item)).toBe(false);

      // Without the monthly series, the weekly instance itself is skipped.
      const alone = seed([seriesById('ser_ceo_weekly')]);
      alone.clock.set('2026-12-20T04:00:00Z');
      const week = onDate(alone.store.instances.values(), 'ser_ceo_weekly', '2026-12-25');
      expect(week.state).toBe('planned');
      const skippedWeek = skipInstance(alone.ctx, user, week, 'holiday').record;
      expect(skippedWeek.state).toBe('skipped');
      expect(incrementsCarryCount(weeklySeriesOf(), skippedWeek, item)).toBe(false);

      // A held review the week before does count, so the rule is not vacuous.
      const held = onDate(alone.store.instances.values(), 'ser_ceo_weekly', '2026-12-18');
      alone.clock.set('2026-12-18T09:30:00Z');
      const started = startMeeting(alone.ctx, user, { ...held, state: 'prepared' }).record;
      alone.clock.set('2026-12-18T10:30:00Z');
      const completed = completeMeeting(alone.ctx, user, started).record;
      expect(incrementsCarryCount(weeklySeriesOf(), completed, item)).toBe(true);

      // A skip needs a reason, and only the user skips.
      expect(failure(() => skipInstance(alone.ctx, user, week, '  ')).rule).toBe('02 §4.2');
      expect(failure(() => skipInstance(alone.ctx, agentCaller, week, 'holiday')).code).toBe(
        'E_FORBIDDEN',
      );
    });

    it('AC-02-07 two consecutive missed weekly instances raise exactly one rhythm escalation with the three options', () => {
      const series = [seriesById('ser_ceo_weekly'), seriesById('ser_ceo_monthly')];
      const { ctx, clock, store } = seed(series);

      clock.set('2026-11-13T12:00:00Z'); // 11-13 15:00-16:00 IST + 60 min grace has passed
      const first = runMissedCheck(store, ctx);
      expect(first.escalations).toEqual([]);
      const nov13 = onDate(store.instances.values(), 'ser_ceo_weekly', '2026-11-13');
      const nov20 = onDate(store.instances.values(), 'ser_ceo_weekly', '2026-11-20');
      expect(nov13.state).toBe('missed');
      expect(nov20.carriedFrom).toEqual([nov13.id]);

      clock.set('2026-11-20T12:00:00Z');
      const second = runMissedCheck(store, ctx);
      expect(second.escalations).toHaveLength(1);
      const [escalation] = second.escalations;
      expect(escalation?.seriesId).toBe('ser_ceo_weekly');
      expect(escalation?.options).toEqual([
        'reschedule_series',
        'change_rhythm',
        'pause_workstream',
      ]);
      expect(RHYTHM_ESCALATION_OPTIONS).toHaveLength(3);
      expect(escalation?.missedInstanceIds).toEqual([nov13.id, nov20.id]);
      expect(escalation?.issue.raisedFrom).toEqual({ kind: 'rhythm', seriesId: 'ser_ceo_weekly' });
      expect(escalation?.issue.status).toBe('open');

      // A third miss (12-04; 11-27 was absorbed and is not held) adds no second escalation.
      clock.set('2026-12-04T12:00:00Z');
      const third = runMissedCheck(store, ctx);
      expect(onDate(store.instances.values(), 'ser_ceo_weekly', '2026-12-04').state).toBe('missed');
      expect(third.escalations).toEqual([]);
      const rhythmIssues = [...store.issues.values()].filter((i) => i.raisedFrom.kind === 'rhythm');
      expect(rhythmIssues).toHaveLength(1);
      // The scheduler never changes the rhythm itself.
      const byId = (a: MeetingSeries, b: MeetingSeries) => a.id.localeCompare(b.id);
      expect([...store.listSeries()].sort(byId)).toEqual([...series].sort(byId));
    });

    it('AC-02-07 a held meeting between two misses, or a daily series, raises no rhythm escalation', () => {
      const { ctx, clock, store } = seed([
        seriesById('ser_ceo_weekly'),
        seriesById('ser_daily_start'),
      ]);
      clock.set('2026-11-13T12:00:00Z');
      runMissedCheck(store, ctx);
      const nov20 = onDate(store.instances.values(), 'ser_ceo_weekly', '2026-11-20');
      clock.set('2026-11-20T09:35:00Z');
      store.commit(startMeeting(ctx, user, { ...nov20, state: 'prepared' }).changes);
      clock.set('2026-11-20T10:30:00Z');
      store.commit(completeMeeting(ctx, user, store.instances.get(nov20.id)!).changes);
      clock.set('2026-12-03T12:00:00Z'); // 11-27 missed too: missed, held, missed
      const result = runMissedCheck(store, ctx);
      expect(onDate(store.instances.values(), 'ser_ceo_weekly', '2026-11-27').state).toBe('missed');
      expect(onDate(store.instances.values(), 'ser_daily_start', '2026-12-03').state).toBe(
        'missed',
      );
      expect(result.escalations).toEqual([]);
      expect(store.issues.size).toBe(0);
    });

    it('AC-01-05 no composed series in the scenario overlaps a hard protected block in any week from 2026-11-09 to 2027-02-05', () => {
      const from = startOfDay('2026-11-09', IST);
      const to = startOfDay('2027-02-06', IST);
      const placement = scenarioPlacement();
      const intervals = seriesIntervals(scenarioSeries(), from, to);
      // Every RRULE is expanded: 65 + 65 daily, 13 weekly minus 3 absorbed, 3 monthly,
      // 1 quarterly and 1 yearly.
      expect(intervals).toHaveLength(65 * 2 + 13 - 3 + 3 + 1 + 1);
      const blocks = blockIntervals(placement.protectedBlocks, from, to);
      expect(blocks.filter((b) => b.policy === 'hard')).toHaveLength(65 * 2);
      const violations = checkPlacement(placement, intervals, blocks);
      expect(violations.filter((v) => v.kind === 'hard_block')).toEqual([]);
      // Nothing else either: the soft overlaps are the two confirmed at S6 (02 §8.1).
      expect(violations).toEqual([]);
      const unconfirmed = checkPlacement({ ...placement, confirmations: [] }, intervals, blocks);
      expect(new Set(unconfirmed.map((v) => `${v.kind}:${v.interval.seriesId}`))).toEqual(
        new Set(['soft_block:ser_ceo_quarterly', 'soft_block:ser_ceo_yearly']),
      );

      // The check does find an overlap: a weekly review moved to 18:00 hits the evening block.
      const moved: MeetingSeries = {
        ...seriesById('ser_ceo_weekly'),
        rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0',
        dtstart: '2026-11-13T18:00',
      };
      const hits = checkPlacement(placement, seriesIntervals([moved], from, to), blocks);
      expect(
        hits.filter((v) => v.kind === 'hard_block' && v.blockId === 'pb_evening'),
      ).toHaveLength(13);
    });
  });
}

function weeklySeriesOf(): MeetingSeries {
  return seriesById('ser_ceo_weekly');
}
