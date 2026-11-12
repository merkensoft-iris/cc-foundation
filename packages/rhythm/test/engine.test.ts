/**
 * The rhythm engine beyond its acceptance criteria: the state machine (02 §4.2), series checks
 * (02 §3, §4.5, §4.6, C-02-07), series changes and idempotence (02 §4.1, C-02-02), CC-to-CC
 * placement (02 §4.6 rule 3), T1 and T2 (01 §6.4), the daylight-saving check (ADR 0001
 * decision 8) and agenda composition (02 §4.4).
 */
import { describe, expect, it } from 'vitest';

import {
  canTransition,
  checkNoSlot,
  checkTimeBudget,
  composeAgenda,
  createSeries,
  dstCheckLine,
  dstCheckWindowFor,
  dueInstant,
  findSlot,
  localDateTime,
  markPrepared,
  markScheduled,
  materialise,
  observesUsDst,
  setSeriesStatus,
  startMeeting,
  TRANSITIONS,
  updateSeries,
  usDstCheckWindows,
  type SeriesCheck,
  type SeriesSpec,
} from '@cc/rhythm';
import type { InstanceState, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { MONTHLY, WEEKLY } from './agendas.ts';
import {
  agentCaller,
  checkChanges,
  failure,
  harness,
  rhythm,
  scenarioPlacement,
  scenarioSeries,
  seriesById,
  user,
  wigSeries,
} from './harness.ts';

const IST = 'Asia/Kolkata';
const ALL = ['ws_ald', 'ws_qlm'];

function specOf(series: MeetingSeries): SeriesSpec {
  const spec: Partial<MeetingSeries> = { ...series };
  for (const key of [
    'id',
    'dtstart',
    'status',
    'createdAt',
    'createdBy',
    'updatedAt',
    'updatedBy',
    'version',
  ] as const) {
    delete spec[key];
  }
  return spec as SeriesSpec;
}

const check = (overrides: Partial<SeriesCheck> = {}): SeriesCheck => ({
  startsOn: '2026-11-09',
  activeWorkstreamIds: ALL,
  placement: scenarioPlacement(),
  ...overrides,
});

describe('instance state machine (02 §4.2)', () => {
  it('allows exactly the diagram edges, plus planned → absorbed and planned → missed', () => {
    const edges = Object.entries(TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}>${to}`),
    );
    expect(edges.sort()).toEqual(
      [
        'planned>scheduled',
        'scheduled>prepared',
        'planned>prepared',
        'prepared>in_progress',
        'scheduled>in_progress',
        'in_progress>completed',
        'prepared>missed',
        'scheduled>missed',
        'planned>skipped',
        'scheduled>skipped',
        'prepared>skipped',
        'scheduled>absorbed',
        'prepared>absorbed',
        'planned>cancelled',
        'scheduled>cancelled',
        'planned>absorbed',
        'planned>missed',
      ].sort(),
    );
    for (const terminal of [
      'completed',
      'missed',
      'skipped',
      'absorbed',
      'cancelled',
    ] as InstanceState[]) {
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
    expect(canTransition('completed', 'in_progress')).toBe(false);
  });

  it('only the user starts a meeting; the engine schedules and prepares; planned → prepared needs no calendar binding', () => {
    const { ctx } = harness();
    const result = materialise(ctx, rhythm, {
      series: [seriesById('ser_ceo_weekly')],
      instances: [],
    });
    const first = result.instances[0] as MeetingInstance;
    expect(failure(() => startMeeting(ctx, agentCaller, first)).code).toBe('E_FORBIDDEN');
    expect(failure(() => startMeeting(ctx, user, first)).rule).toBe('02 §4.2'); // planned
    expect(failure(() => markScheduled(ctx, user, first)).code).toBe('E_FORBIDDEN');
    const prepared = markPrepared(ctx, rhythm, seriesById('ser_ceo_weekly'), first);
    checkChanges(prepared.changes);
    expect(prepared.record.state).toBe('prepared');
    const bound: MeetingSeries = {
      ...seriesById('ser_ceo_weekly'),
      calendars: [
        {
          bindingId: 'bnd_gcal',
          calendarId: 'cc',
          role: 'primary',
          titleTemplate: '[CC] {{series.name}}',
          inviteAttendees: false,
        },
      ],
    };
    expect(failure(() => markPrepared(ctx, rhythm, bound, first)).rule).toBe('02 §4.2');
    const scheduled = markScheduled(ctx, rhythm, first).record;
    expect(markScheduled(ctx, rhythm, scheduled).status).toBe('no-op');
    const started = startMeeting(ctx, user, scheduled);
    expect(started.record.state).toBe('in_progress');
    expect(started.record.actualStart).toBe(ctx.clock.now());
  });
});

describe('series (02 §3, §4.5, §4.6)', () => {
  it('creates every 02 §8.1 series from its spec, with the synced DTSTART and canonical rule', () => {
    const { ctx } = harness();
    for (const series of scenarioSeries()) {
      const confirmed = scenarioPlacement()
        .confirmations.filter((c) => c.seriesId === series.id)
        .map((c) => ({
          reason: c.reason,
          ...(c.blockId === undefined ? {} : { blockId: c.blockId }),
        }));
      const placement = { ...scenarioPlacement(), confirmations: [] };
      const created = createSeries(ctx, user, specOf(series), check({ placement, confirmed }));
      checkChanges(created.changes);
      expect(created.record.dtstart).toBe(series.dtstart);
      expect(created.record.rrule).toBe(series.rrule);
      expect(created.record.prereadLeadMinutes).toBe(series.cadence === 'daily' ? 30 : 1440);
      expect(created.record.graceMinutes).toBe(60);
    }
  });

  it('C-02-07 refuses a series that overlaps a hard block, and a soft overlap without its confirmation', () => {
    const { ctx } = harness();
    const weekly = specOf(seriesById('ser_ceo_weekly'));
    const evening = failure(() =>
      createSeries(
        ctx,
        user,
        { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=30' },
        check(),
      ),
    );
    expect(evening).toMatchObject({ code: 'E_INVARIANT', rule: 'C-02-07' });
    expect(evening.message).toContain('pb_evening');

    const quarterly = specOf(seriesById('ser_ceo_quarterly'));
    const soft = failure(() =>
      createSeries(
        ctx,
        user,
        quarterly,
        check({ placement: { ...scenarioPlacement(), confirmations: [] } }),
      ),
    );
    expect(soft).toMatchObject({ code: 'E_INVARIANT', rule: '02 §4.6' });
    expect(soft.message).toContain('pb_deep_a');

    const late = failure(() =>
      createSeries(
        ctx,
        user,
        { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0' },
        check(),
      ),
    );
    expect(late.message).toContain('outside working hours');
    const confirmed = check({ confirmed: [{ reason: 'outside_working_hours' }] });
    expect(
      createSeries(
        ctx,
        user,
        { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0' },
        confirmed,
      ).status,
    ).toBe('ok');
  });

  it('checks cadence, duration bounds, absorbs, calendars and portfolio coverage', () => {
    const { ctx } = harness();
    const weekly = specOf(seriesById('ser_ceo_weekly'));
    expect(
      failure(() => createSeries(ctx, user, { ...weekly, cadence: 'monthly' }, check())).rule,
    ).toBe('02 §3');
    const bounds = failure(() =>
      createSeries(
        ctx,
        user,
        { ...weekly, durationMinutes: 120 },
        check({
          backbone: { cadence: 'weekly', durationMinutes: { min: 45, default: 60, max: 90 } },
        }),
      ),
    );
    expect(bounds.code).toBe('E_PARAM_BOUNDS');
    expect(bounds.help).toContain('weekly.duration: 45 to 90');
    expect(
      failure(() =>
        createSeries(
          ctx,
          user,
          { ...weekly, absorbs: [{ cadence: 'monthly', absorbedMinutes: 30 }] },
          check(),
        ),
      ).rule,
    ).toBe('02 §4.3');
    const binding = {
      bindingId: 'bnd_gcal' as const,
      calendarId: 'cc',
      titleTemplate: '[CC] {{series.name}}',
      inviteAttendees: false,
    };
    expect(
      failure(() =>
        createSeries(
          ctx,
          user,
          { ...weekly, calendars: [{ ...binding, role: 'mirror' }] },
          check(),
        ),
      ).rule,
    ).toBe('02 §9.6');
    const start = specOf(seriesById('ser_daily_start'));
    expect(
      failure(() => createSeries(ctx, user, { ...start, workstreamIds: ['ws_ald'] }, check())).rule,
    ).toBe('02 §4.5');
    expect(
      failure(() => createSeries(ctx, user, { ...weekly, timeZone: 'Mars/Olympus' }, check())).rule,
    ).toBe('ADR 0001 decision 6');
    expect(failure(() => createSeries(ctx, agentCaller, weekly, check())).code).toBe('E_FORBIDDEN');
  });
});

describe('materialisation and series changes (02 §4.1)', () => {
  it('C-02-02 the horizon holds every occurrence; a series change rewrites only future planned, scheduled or prepared instances, keeping their IDs', () => {
    const { ctx, clock } = harness('2026-11-04T04:10:00Z');
    const weekly = seriesById('ser_ceo_weekly');
    let instances = materialise(ctx, rhythm, { series: [weekly], instances: [] }).instances;
    expect(instances).toHaveLength(13);

    // 11-13 was held; 11-20 is prepared; then on 11-18 the review moves to Thursdays 16:00.
    clock.set('2026-11-13T09:30:00Z');
    const held = {
      ...(instances[0] as MeetingInstance),
      state: 'completed' as const,
      actualStart: '2026-11-13T09:30:00Z',
      actualEnd: '2026-11-13T10:30:00Z',
    };
    const prepared = { ...(instances[1] as MeetingInstance), state: 'prepared' as const };
    instances = [held, prepared, ...instances.slice(2)];
    clock.set('2026-11-18T04:00:00Z');
    const changed = updateSeries(
      ctx,
      user,
      weekly,
      { rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=16;BYMINUTE=0' },
      { activeWorkstreamIds: ALL, placement: scenarioPlacement() },
    );
    expect(changed.record.dtstart).toBe('2026-11-19T16:00');
    const result = materialise(ctx, rhythm, { series: [changed.record], instances });
    checkChanges(result.changes);
    const after = new Map(result.instances.map((i) => [i.id, i]));
    expect(after.get(held.id)).toEqual(held); // past is immutable
    const moved = after.get(prepared.id) as MeetingInstance;
    expect(localDateTime(moved.scheduledStart, IST)).toBe('2026-11-19T16:00');
    expect(moved.state).toBe('prepared');
    // Twelve Friday instances move to the Thursday of their week; one new Thursday (02-11) extends it.
    expect(
      result.changes.filter((c) => c.event.type === 'meeting_instance.materialised'),
    ).toHaveLength(1);
    expect(
      result.changes.filter((c) => c.event.type === 'meeting_instance.rewritten'),
    ).toHaveLength(12);
    expect(
      materialise(ctx, rhythm, { series: [changed.record], instances: result.instances }).status,
    ).toBe('no-op');
  });

  it('a one-off reschedule never makes a duplicate; an ended series cancels its future planned instances', () => {
    const { ctx, clock } = harness('2026-11-04T04:10:00Z');
    const weekly = seriesById('ser_ceo_weekly');
    const first = materialise(ctx, rhythm, { series: [weekly], instances: [] }).instances;
    const nov13 = first[0] as MeetingInstance;
    const moved = {
      ...nov13,
      scheduledStart: '2026-11-12T10:30:00Z',
      scheduledEnd: '2026-11-12T11:30:00Z',
      rescheduledFrom: {
        start: nov13.scheduledStart,
        by: { kind: 'user' as const },
        at: '2026-11-10T00:00:00Z',
      },
    };
    const again = materialise(ctx, rhythm, {
      series: [weekly],
      instances: [moved, ...first.slice(1)],
    });
    expect(again.status).toBe('no-op');

    clock.set('2026-12-01T00:00:00Z');
    const ended = setSeriesStatus(ctx, user, weekly, 'ended').record;
    const result = materialise(ctx, rhythm, {
      series: [ended],
      instances: [moved, ...first.slice(1)],
    });
    const states = result.instances.map((i) => i.state);
    expect(states.filter((s) => s === 'cancelled')).toHaveLength(10); // 12-04 to 02-05
    expect(states.filter((s) => s === 'planned')).toHaveLength(3); // the past three stay
    expect(failure(() => setSeriesStatus(ctx, user, ended, 'active')).rule).toBe('02 §3');
  });

  // Two full 90-day materialisations with placement: ~2 s alone, over 5 s under a parallel run.
  it('02 §4.6 rule 3: of two overlapping CC meetings the lower cadence moves to the nearest free slot that day', () => {
    const { ctx } = harness('2026-11-04T04:10:00Z');
    // A weekly WIG at 15:30 Fridays collides with the weekly CEO review (15:00-16:00): equal
    // cadence, so the later one moves; on the last Friday the 120-minute monthly review holds.
    const wig: MeetingSeries = {
      ...wigSeries(),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=30',
      dtstart: '2026-11-13T15:30',
    };
    const series = [seriesById('ser_ceo_weekly'), seriesById('ser_ceo_monthly'), wig];
    const result = materialise(ctx, rhythm, {
      series,
      instances: [],
      placement: scenarioPlacement(),
    });
    checkChanges(result.changes);
    expect(result.unresolved).toEqual([]);
    const moves = result.moves.map((m) => [localDateTime(m.from, IST), localDateTime(m.to, IST)]);
    expect(moves[0]).toEqual(['2026-11-13T15:30', '2026-11-13T16:00']);
    expect(moves).toContainEqual(['2026-11-27T15:30', '2026-11-27T17:00']);
    const nov13 = result.instances.find(
      (i) => i.seriesId === wig.id && i.occurrenceStart === '2026-11-13T10:00:00Z',
    );
    expect(nov13?.rescheduledFrom).toEqual({
      start: '2026-11-13T10:00:00Z',
      by: rhythm.actor,
      at: ctx.clock.now(),
    });
    expect(
      materialise(ctx, rhythm, {
        series,
        instances: result.instances,
        placement: scenarioPlacement(),
      }).status,
    ).toBe('no-op');
  }, 20_000);

  it('findSlot keeps to working hours and avoids hard blocks and unconfirmed soft blocks', () => {
    const placement = scenarioPlacement();
    const blocks = [
      {
        blockId: 'pb_break',
        policy: 'hard' as const,
        start: '2026-11-13T08:30:00Z',
        end: '2026-11-13T09:30:00Z',
      },
      {
        blockId: 'pb_deep_a',
        policy: 'soft' as const,
        start: '2026-11-13T04:15:00Z',
        end: '2026-11-13T07:15:00Z',
      },
    ];
    // Preferred 14:00 IST, 60 minutes: the afternoon break holds 14:00-15:00; 13:00 and 15:00 are both an
    // hour away, and the earlier wins.
    const at = findSlot(placement, {
      seriesId: 'x',
      preferred: '2026-11-13T08:30:00Z',
      durationMinutes: 60,
      busy: [],
      blocks,
    });
    expect(localDateTime(at as string, IST)).toBe('2026-11-13T13:00');
    // Preferred 10:00 IST, inside the unconfirmed Deep block A (09:45-12:45): 09:00 + 60 overlaps
    // it, so the nearest is 12:45. Saturday is not a workweek day.
    const deep = findSlot(placement, {
      seriesId: 'x',
      preferred: '2026-11-13T04:30:00Z',
      durationMinutes: 60,
      busy: [],
      blocks,
    });
    expect(localDateTime(deep as string, IST)).toBe('2026-11-13T12:45');
    expect(
      findSlot(placement, {
        seriesId: 'x',
        preferred: '2026-11-14T04:30:00Z',
        durationMinutes: 30,
        busy: [],
        blocks,
      }),
    ).toBeUndefined();
  });
});

describe('01 §6.4 workspace post-check', () => {
  it('T1 averages 173.8 minutes a week for the scenario (01 §7.3: 160, about 174 with absorption), within 240', () => {
    const budget = checkTimeBudget(scenarioSeries(), 240);
    expect(budget.averageWeeklyMinutes).toBeCloseTo((50 * 52 * 2 + 40 * 60 + 12 * 120) / 52, 6);
    expect(Math.round(budget.averageWeeklyMinutes)).toBe(174);
    expect(budget.warning).toBeUndefined();
    expect(budget.bySeries['ser_ceo_quarterly']).toBeUndefined();
    expect(budget.bySeries['ser_ceo_yearly']).toBeUndefined();
  });

  it('T1 at a budget of 160 emits W-TIME-BUDGET with the four fixes in order and applies none', () => {
    const series = scenarioSeries();
    const budget = checkTimeBudget(series, 160);
    expect(budget.warning?.code).toBe('W-TIME-BUDGET');
    expect(budget.warning?.options).toEqual(['merge', 'shorten', 'biweekly', 'raise_budget']);
    expect(series).toEqual(scenarioSeries());
  });

  it('T2 emits W-NO-SLOT for a required meeting that fits nowhere outside hard blocks in working hours', () => {
    const placement = scenarioPlacement();
    expect(
      checkNoSlot(placement, [{ key: 'weekly', durationMinutes: 90 }], '2026-11-09'),
    ).toBeUndefined();
    const warning = checkNoSlot(
      placement,
      [
        { key: 'weekly', durationMinutes: 90 },
        { key: 'quarterly', durationMinutes: 480 },
      ],
      '2026-11-09',
    );
    expect(warning).toMatchObject({ code: 'W-NO-SLOT', meetings: ['quarterly'] });
  });
});

describe('US daylight-saving check (ADR 0001 decision 8)', () => {
  it('runs from the Monday before each US transition to the Friday after', () => {
    expect(usDstCheckWindows([2026, 2027])).toEqual([
      { transition: '2026-03-08', from: '2026-03-02', to: '2026-03-13' },
      { transition: '2026-11-01', from: '2026-10-26', to: '2026-11-06' },
      { transition: '2027-03-14', from: '2027-03-08', to: '2027-03-19' },
      { transition: '2027-11-07', from: '2027-11-01', to: '2027-11-12' },
    ]);
  });

  it('applies to zones on US daylight saving only', () => {
    expect(observesUsDst('America/New_York', 2026)).toBe(true);
    expect(observesUsDst('America/Chicago', 2026)).toBe(true);
    expect(observesUsDst('Asia/Kolkata', 2026)).toBe(false);
    expect(observesUsDst('Europe/London', 2026)).toBe(false);
    expect(observesUsDst('America/Phoenix', 2026)).toBe(false);
    expect(dstCheckWindowFor('2027-03-08', 'America/New_York')?.transition).toBe('2027-03-14');
    expect(dstCheckWindowFor('2027-03-20', 'America/New_York')).toBeUndefined();
    expect(dstCheckWindowFor('2027-03-10', IST)).toBeUndefined();
  });

  it("lists a US-zoned workstream's items due that week and the sessions in both zones (ADR 0001 measurements T1, T4)", () => {
    expect(dueInstant({ date: '2027-03-13', timeZone: 'America/New_York' })).toBe(
      '2027-03-14T05:00:00Z',
    ); // 10:30 IST
    expect(dueInstant({ date: '2027-03-14', timeZone: 'America/New_York' })).toBe(
      '2027-03-15T04:00:00Z',
    ); // 09:30 IST
    const line = dstCheckLine({
      date: '2027-03-09',
      workspaceTimeZone: IST,
      workstream: { id: 'ws_us', timeZone: 'America/New_York' },
      openItems: [
        { ref: 'A-0301', due: { date: '2027-03-13', timeZone: 'America/New_York' } },
        { ref: 'A-0302', due: { date: '2027-03-25', timeZone: 'America/New_York' } },
      ],
      sessions: [
        { instanceId: 'mtg_a', start: '2027-03-11T07:45:00Z' },
        { instanceId: 'mtg_b', start: '2027-03-18T07:45:00Z' },
      ],
    });
    expect(line?.items).toEqual([
      {
        ref: 'A-0301',
        dueBy: '2027-03-14T05:00:00Z',
        workstreamTime: '2027-03-14T00:00',
        workspaceTime: '2027-03-14T10:30',
      },
    ]);
    expect(line?.sessions.map((s) => [s.workstreamTime, s.workspaceTime])).toEqual([
      ['2027-03-11T02:45', '2027-03-11T13:15'],
      ['2027-03-18T03:45', '2027-03-18T13:15'],
    ]);
    expect(
      dstCheckLine({
        date: '2027-03-09',
        workspaceTimeZone: IST,
        workstream: { id: 'ws_ald', timeZone: IST },
        openItems: [],
        sessions: [],
      }),
    ).toBeUndefined();
  });
});

describe('agenda composition (02 §4.4)', () => {
  it('a merged weekly repeats the perWorkstream block per workstream and keeps E-1 order for each', () => {
    const agenda = composeAgenda({ template: WEEKLY, series: seriesById('ser_ceo_weekly') });
    expect(
      agenda.map(
        (s) => `${s.sectionId}${s.workstreamId === undefined ? '' : `:${s.workstreamId}`}`,
      ),
    ).toEqual([
      'check_in',
      'scorecard:ws_ald',
      'goals_review:ws_ald',
      'action_review:ws_ald',
      'scorecard:ws_qlm',
      'goals_review:ws_qlm',
      'action_review:ws_qlm',
      'headlines',
      'issues',
      'conclude',
    ]);
    expect(agenda.reduce((sum, s) => sum + s.timeboxMinutes, 0)).toBe(60);
  });

  it('fits timeboxes by shrinking non-backbone sections first, and fails with E_AGENDA_FIT naming the smallest duration', () => {
    const monthly = seriesById('ser_ceo_monthly');
    const short = composeAgenda({ template: MONTHLY, series: { ...monthly, durationMinutes: 70 } });
    const minutes = Object.fromEntries(short.map((s) => [s.sectionId, s.timeboxMinutes]));
    expect(minutes).toEqual({
      check_in: 5,
      money_ops: 15,
      scorecard: 15,
      register_health: 10,
      risk_review: 5,
      issues: 15,
      conclude: 5,
    });
    const error = failure(() =>
      composeAgenda({ template: MONTHLY, series: { ...monthly, durationMinutes: 40 } }),
    );
    expect(error.code).toBe('E_AGENDA_FIT');
    expect(error.help).toContain('smallest duration that fits: 49 minutes');
  });
});
