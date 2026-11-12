/**
 * Input resolution (02 §6.1; P1-08) on the reference records: relative times, each source, the
 * minimal fields and flags, and the flagged empty input for connectors.
 */
import { describe, expect, it } from 'vitest';

import {
  agendaTemplate,
  ATTENTION_ORDER,
  nextInstance,
  previousInstance,
  readPeriods,
  resolveInput,
  resolveRelativeTime,
  type ResolveScope,
} from '@cc/rhythm';
import type { ActionItem, InputQuery, Issue, MeetingInstance } from '@cc/schemas';

import {
  instanceOf,
  item,
  meetingData,
  seriesById,
  type DataOverrides,
} from './meetings-harness.ts';

const weeklyQuery = (sectionId: string, queryId: string): InputQuery => {
  const section = agendaTemplate('agenda.eos-lite.weekly@1').sections.find(
    (s) => s.id === sectionId,
  );
  const query = section?.inputs.find((q) => q.id === queryId);
  if (query === undefined) throw new Error(`no ${sectionId}/${queryId}`);
  return query;
};

function scope(
  instance: MeetingInstance,
  workstreamIds: string[],
  overrides: DataOverrides = {},
): ResolveScope {
  return {
    series: seriesById(instance.seriesId),
    instance,
    workstreamIds: workstreamIds as never,
    data: meetingData(overrides),
  };
}

const first = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
const held = instanceOf('ser_ceo_weekly', '2026-11-06T15:00', {
  state: 'completed',
  actualStart: '2026-11-06T09:31:00Z',
  actualEnd: '2026-11-06T10:40:00Z',
});
const missed = instanceOf('ser_ceo_weekly', '2026-11-20T15:00', { state: 'missed' });
const later = instanceOf('ser_ceo_weekly', '2026-11-27T15:00', { state: 'absorbed' });
const after = instanceOf('ser_ceo_weekly', '2026-12-04T15:00', { state: 'scheduled' });

describe('02 §6.1 relative times', () => {
  it('resolves instance, previous held and next instances against the instance', () => {
    const s = scope(first, ['ws_ald'], { instances: [held, first, missed, later, after] });
    expect(resolveRelativeTime('instance.start', s)).toBe('2026-11-13T09:30:00Z');
    expect(resolveRelativeTime('instance.end', s)).toBe('2026-11-13T10:30:00Z');
    expect(resolveRelativeTime('previous_instance.end', s)).toBe('2026-11-06T10:40:00Z');
    expect(resolveRelativeTime('next_instance.start', s)).toBe('2026-12-04T09:30:00Z');
    expect(resolveRelativeTime('instance.start+1d', s)).toBe('2026-11-14T09:30:00Z');
    expect(resolveRelativeTime('instance.start-7d', s)).toBe('2026-11-06T09:30:00Z');
  });

  it('a missed instance is not the previous one: its agenda carried in (02 §4.2 rule 2)', () => {
    const s = scope(after, ['ws_ald'], { instances: [held, first, missed, after] });
    expect(previousInstance(s)?.id).toBe(held.id);
    expect(nextInstance(scope(held, ['ws_ald'], { instances: [held, missed, after] }))?.id).toBe(
      after.id,
    );
  });
});

describe('action_items', () => {
  it('the action_review "due" input lists accepted items due before the instance ends, with minimal fields', () => {
    const result = resolveInput(weeklyQuery('action_review', 'due'), scope(first, ['ws_ald']));
    expect(result.rows.map((r) => r.ref)).toEqual(['A-0142']);
    expect(result.rows[0]).toEqual({
      ref: 'A-0142',
      title: 'Send revised proposal with phased pricing to the consulting lead',
      workstreamIds: ['ws_ald'],
      ownerId: 'per_self',
      due: '2026-11-12',
      lifecycle: 'waiting',
      health: 'on_track',
      carryCount: 0,
      evidence: 'none',
      flags: ['overdue'],
    });
    expect(result.count).toBe(1);
  });

  it('a perWorkstream section reads its own workstream only', () => {
    const result = resolveInput(weeklyQuery('action_review', 'due'), {
      ...scope(instanceOf('ser_ceo_weekly', '2026-11-20T15:00'), ['ws_qlm']),
    });
    expect(result.rows.map((r) => r.ref)).toEqual(['A-0144']);
  });

  it('drafts and dropped items are never listed', () => {
    const items: ActionItem[] = [
      item('A-0142', { lifecycle: 'draft' }),
      item('A-0160', {
        lifecycle: 'dropped',
        dropReason: 'superseded',
        due: { date: '2026-11-10', timeZone: 'Asia/Kolkata' },
      }),
    ];
    const result = resolveInput(
      weeklyQuery('action_review', 'due'),
      scope(first, ['ws_ald'], { actionItems: items }),
    );
    expect(result.rows).toEqual([]);
  });

  it('the "claimed" input lists claims since the previous held instance, and is flagged without one', () => {
    const claimed = item('A-0160', {
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-10T08:00:00Z', by: { kind: 'user' } },
    });
    const old = item('A-0142', {
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-05T08:00:00Z', by: { kind: 'user' } },
    });
    const withPrevious = resolveInput(
      weeklyQuery('action_review', 'claimed'),
      scope(first, ['ws_ald'], { actionItems: [claimed, old], instances: [held, first] }),
    );
    expect(withPrevious.rows.map((r) => [r.ref, r.flags])).toEqual([['A-0160', ['claimed']]]);
    const firstOne = resolveInput(
      weeklyQuery('action_review', 'claimed'),
      scope(first, ['ws_ald'], { actionItems: [claimed] }),
    );
    expect([firstOne.count, firstOne.flags]).toEqual([0, ['no_previous_instance']]);
  });

  it('an item with no update since the previous held instance is flagged update_needed', () => {
    const stale = item('A-0142', { updatedAt: '2026-11-06T10:00:00Z' });
    const fresh = item('A-0160', {
      due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' },
      updatedAt: '2026-11-12T08:10:00Z',
    });
    const result = resolveInput(
      weeklyQuery('action_review', 'due'),
      scope(first, ['ws_ald'], { actionItems: [stale, fresh], instances: [held, first] }),
    );
    expect(result.rows.map((r) => [r.ref, r.flags])).toEqual([
      ['A-0142', ['overdue', 'update_needed']],
      ['A-0160', []],
    ]);
  });

  it('escalationAtLeast, ownerIds and limit filter, and a cut list is flagged truncated', () => {
    const items = [
      item('A-0142', { escalationLevel: 2 }),
      item('A-0160', { escalationLevel: 3 }),
      item('A-0144', { escalationLevel: 1 }),
    ];
    const query: InputQuery = {
      id: 'q',
      source: 'action_items',
      filter: { scope: 'meeting', escalationAtLeast: 2, ownerIds: ['per_self'] },
      limit: 1,
    };
    const result = resolveInput(query, scope(first, ['ws_ald', 'ws_qlm'], { actionItems: items }));
    expect([result.count, result.rows.map((r) => r.ref), result.flags]).toEqual([
      2,
      ['A-0142'],
      ['truncated'],
    ]);
  });
});

describe('measures', () => {
  it('a Friday review reads the week it closes and the three before; missing and not-normal values are flagged', () => {
    const result = resolveInput(weeklyQuery('scorecard', 'measures'), scope(first, ['ws_ald']));
    expect(result.rows.map((r) => [r.ref, r.flags])).toEqual([
      ['K-0003', ['not_normal', 'off_target']],
      ['K-0006', ['missing_value']],
    ]);
    expect(result.flags).toEqual(['missing_lead_value']);
    const values = (result.rows[0]?.detail as { values: { periodStart: string; value: unknown }[] })
      .values;
    expect(values.map((v) => [v.periodStart, v.value])).toEqual([
      ['2026-10-19', null],
      ['2026-10-26', null],
      ['2026-11-02', null],
      ['2026-11-09', 1],
    ]);
  });

  it('X-5: a Monday session reads the week just ended', () => {
    expect(readPeriods('weekly', '2026-11-16', 1)).toEqual(['2026-11-09']);
    expect(readPeriods('weekly', '2026-11-13', 2)).toEqual(['2026-11-02', '2026-11-09']);
    expect(readPeriods('monthly', '2026-11-27', 2)).toEqual(['2026-10-01', '2026-11-01']);
    expect(readPeriods('quarterly', '2026-12-18', 1)).toEqual(['2026-10-01']);
    expect(readPeriods('daily', '2026-11-13', 1)).toEqual(['2026-11-12']);
  });
});

describe('goals, decisions, issues and risks', () => {
  it('goals of the current period, flagged by health', () => {
    const result = resolveInput(weeklyQuery('goals_review', 'goals'), scope(first, ['ws_ald']));
    expect(result.rows.map((r) => [r.ref, r.health, r.flags])).toEqual([
      ['G-0002', 'on_track', []],
      ['G-0004', 'at_risk', ['at_risk']],
    ]);
    const next: InputQuery = {
      id: 'g',
      source: 'goals',
      filter: { scope: 'meeting', period: 'next' },
    };
    expect(resolveInput(next, scope(first, ['ws_ald'])).rows).toEqual([]);
  });

  it('open issues ranked, resolved ones left out; rows tagged with their workstream', () => {
    const open = (ref: string, workstreamId: string, rank?: number): Issue => ({
      id: `iss_${ref}` as Issue['id'],
      ref,
      workstreamId: workstreamId as Issue['workstreamId'],
      title: `Issue ${ref}`,
      raisedFrom: { kind: 'manual' },
      ...(rank === undefined ? {} : { rank }),
      status: 'open',
      createdAt: '2026-11-10T00:00:00Z',
      createdBy: { kind: 'user' },
      updatedAt: '2026-11-10T00:00:00Z',
      updatedBy: { kind: 'user' },
      version: 1,
    });
    const issues = [
      ...meetingData().issues,
      open('I-0050', 'ws_qlm'),
      open('I-0051', 'ws_ald', 1),
      open('I-0052', 'ws_us', 0),
    ];
    const result = resolveInput(
      weeklyQuery('issues', 'issues'),
      scope(first, ['ws_ald', 'ws_qlm'], { issues }),
    );
    expect(result.rows.map((r) => [r.ref, r.workstreamIds])).toEqual([
      ['I-0051', ['ws_ald']],
      ['I-0050', ['ws_qlm']],
    ]);
  });

  it('decisions by status, risks by status', () => {
    const decisions: InputQuery = {
      id: 'd',
      source: 'decisions',
      filter: { scope: 'meeting', status: ['open'] },
    };
    expect(resolveInput(decisions, scope(first, ['ws_ald'])).rows.map((r) => r.ref)).toEqual([
      'D-0008',
    ]);
    const risks: InputQuery = {
      id: 'r',
      source: 'risks',
      filter: { scope: ['ws_workspace'], status: ['watching'] },
    };
    expect(resolveInput(risks, scope(first, ['ws_ald'])).rows.map((r) => r.ref)).toEqual([
      'R-0002',
    ]);
  });
});

describe('register and rhythm health', () => {
  it('register health lists items carried or re-planned twice and the oldest open item', () => {
    const monthly = instanceOf('ser_ceo_monthly', '2026-11-27T15:00');
    const items = [
      item('A-0142', { carryCount: 2, createdAt: '2026-11-01T00:00:00Z' }),
      item('A-0160', { replannedCount: 2 }),
    ];
    const query: InputQuery = {
      id: 'register',
      source: 'register_health',
      filter: { scope: 'meeting', window: 'month' },
    };
    const result = resolveInput(
      query,
      scope(monthly, ['ws_ald', 'ws_qlm'], { actionItems: items }),
    );
    expect(result.rows.map((r) => [r.ref, r.flags])).toEqual([
      ['A-0142', ['carried_twice', 'oldest_open']],
      ['A-0160', ['replanned_twice']],
    ]);
    expect(result.summary?.['window']).toEqual({ start: '2026-11-01', end: '2026-11-27' });
  });

  it('rhythm health counts held on time, missed, skipped and overruns in the quarter so far', () => {
    const quarterly = instanceOf('ser_ceo_quarterly', '2026-12-18T09:45');
    const instances = [
      held,
      instanceOf('ser_ceo_weekly', '2026-10-30T15:00', {
        state: 'completed',
        actualStart: '2026-10-30T09:50:00Z',
        actualEnd: '2026-10-30T11:00:00Z',
      }),
      instanceOf('ser_ceo_weekly', '2026-11-20T15:00', { state: 'missed' }),
      instanceOf('ser_ceo_weekly', '2026-12-25T15:00', { state: 'skipped', skipReason: 'holiday' }),
      instanceOf('ser_ceo_weekly', '2026-12-11T15:00', { state: 'skipped', skipReason: 'travel' }),
    ];
    const query: InputQuery = {
      id: 'rhythm',
      source: 'rhythm_health',
      filter: { window: 'quarter' },
    };
    const result = resolveInput(query, scope(quarterly, ['ws_ald'], { instances }));
    expect(result.summary).toEqual({
      window: { start: '2026-10-01', end: '2026-12-18' },
      due: 3,
      held: 2,
      heldOnTime: 1,
      missed: 1,
      skipped: 1,
      overruns: 2,
    });
  });
});

describe('attention (02 §5.7)', () => {
  const dailyQuery = agendaTemplate('agenda.portfolio.daily-start@1').sections[0]?.inputs[0];
  if (dailyQuery === undefined) throw new Error('no attention input');

  it('Q6: the categories keep their fixed order, oldest first within each', () => {
    const daily = instanceOf('ser_daily_start', '2026-11-13T09:00');
    const weekly = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const clash = instanceOf('ser_goal_wig', '2026-11-13T15:30');
    const s = scope(daily, ['ws_ald'], {
      actionItems: [
        item('A-0142', { escalationLevel: 2, createdAt: '2026-11-02T00:00:00Z' }),
        item('A-0160', { escalationLevel: 3, createdAt: '2026-11-01T00:00:00Z' }),
        item('A-0144', { escalationLevel: 1 }),
      ],
      instances: [daily, weekly, clash],
    });
    const result = resolveInput(dailyQuery, {
      ...s,
      data: {
        ...s.data,
        attention: [
          {
            category: 'backup',
            ref: 'backup',
            title: 'Backup failing',
            since: '2026-11-12T00:00:00Z',
          },
          { category: 'confirmation', ref: 'cnf_2', title: 'Send', since: '2026-11-12T00:00:00Z' },
          { category: 'confirmation', ref: 'cnf_1', title: 'Post', since: '2026-11-11T00:00:00Z' },
        ],
      },
    });
    expect(
      result.rows.map((r) => [(r.detail as { category: string }).category, r.ref, r.flags]),
    ).toEqual([
      ['confirmation', 'cnf_1', []],
      ['confirmation', 'cnf_2', []],
      ['escalation', 'A-0160', ['escalation_3']],
      ['escalation', 'A-0142', ['escalation_2']],
      ['backup', 'backup', []],
      ['meetings', weekly.ref, ['conflict']],
      ['meetings', clash.ref, ['conflict']],
    ]);
    expect(ATTENTION_ORDER.slice(0, 5)).toEqual([
      'confirmation',
      'session',
      'escalation',
      'development_request',
      'backup',
    ]);
  });

  it('ADR 0001 decision 8: the US daylight-saving check line shows for a US-zoned workstream in the change week', () => {
    const daily = instanceOf('ser_daily_start', '2026-11-02T09:00');
    const result = resolveInput(dailyQuery, scope(daily, ['ws_ald'], { instances: [daily] }));
    expect(result.rows.map((r) => r.ref)).toEqual(['dst:ws_us:2026-11-01']);
    const outside = instanceOf('ser_daily_start', '2026-11-13T09:00');
    expect(
      resolveInput(dailyQuery, scope(outside, ['ws_ald'], { instances: [outside] })).rows,
    ).toEqual([]);
  });
});

describe('connector inputs (02 §6.1 rule 3)', () => {
  const query: InputQuery = {
    id: 'pipeline',
    source: 'connector',
    action: 'list_new_ranked',
    input: {},
  };
  const wig = instanceOf('ser_goal_wig', '2026-11-16T13:15');

  it('with no binding, or no connector host in P1, the input is a flagged empty input', () => {
    expect(resolveInput(query, scope(wig, ['ws_goal']))).toEqual({
      queryId: 'pipeline',
      source: 'connector',
      count: 0,
      rows: [],
      flags: ['connector_unbound'],
    });
    const bound = { ...query, bindingId: 'bnd_linkedin' } as InputQuery;
    expect(resolveInput(bound, scope(wig, ['ws_goal'])).flags).toEqual(['connector_unavailable']);
  });

  it('a failed read is flagged empty, never stale data; rows read are marked untrusted', () => {
    const bound = { ...query, bindingId: 'bnd_linkedin' } as InputQuery;
    const base = scope(wig, ['ws_goal']);
    const failed = resolveInput(bound, {
      ...base,
      data: { ...base.data, connector: () => ({ ok: false, code: 'E_RATE_LIMIT' }) },
    });
    expect([failed.count, failed.flags]).toEqual([0, ['connector_failed:E_RATE_LIMIT']]);
    const read = resolveInput(bound, {
      ...base,
      data: {
        ...base.data,
        connector: () => ({ ok: true, rows: [{ ref: 'p1', title: 'Posting' }] }),
      },
    });
    expect(read.rows.map((r) => [r.ref, r.flags])).toEqual([['p1', ['untrusted']]]);
  });
});
