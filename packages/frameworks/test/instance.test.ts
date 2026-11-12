/**
 * Checked instance changes and the invariant validators (01 §5, §9, C-01-03, C-01-04).
 * Each invariant of the three v1 templates is shown to hold on the scenario and to break.
 */
import { describe, expect, it } from 'vitest';

import {
  changeInstance,
  checkInvariants,
  findTemplate,
  validateInstance,
  type InstanceState,
} from '@cc/frameworks';
import type { FrameworkTemplate } from '@cc/schemas';

import { ceoWeekly, alderwick, goalArea, personalArea } from './states.ts';

function template(id: 'eos-lite' | '4dx' | 'personal-os'): FrameworkTemplate {
  const found = findTemplate(id);
  if (found === undefined) throw new Error(`no template ${id}`);
  return found;
}

const eosLite = template('eos-lite');
const fourDx = template('4dx');
const personalOs = template('personal-os');

/** A copy of an object without one key (an absent optional field). */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;
}

/** The invariant IDs a state breaks. */
function broken(t: FrameworkTemplate, state: InstanceState): string[] {
  return [...new Set(checkInvariants(t, state).map((violation) => violation.invariantId))];
}

describe('the scenario instances hold every invariant', () => {
  it('Alderwick (eos-lite, merged weekly CEO review), a 4dx goal area and a personal area (personal-os)', () => {
    expect(checkInvariants(eosLite, alderwick())).toEqual([]);
    expect(checkInvariants(fourDx, goalArea())).toEqual([]);
    expect(checkInvariants(personalOs, personalArea())).toEqual([]);
    expect(validateInstance(eosLite, alderwick()).ok).toBe(true);
  });
});

describe('checked changes (C-01-03, C-01-04)', () => {
  it('AC-01-03 setting priorityCount = 7 on an eos-lite instance fails with E_PARAM_BOUNDS (bounds 1 to 5)', () => {
    const result = changeInstance(eosLite, alderwick(), {
      kind: 'set_parameters',
      parameters: { priorityCount: 7 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_PARAM_BOUNDS');
    expect(result.error.details).toMatchObject({
      key: 'priorityCount',
      value: 7,
      bounds: { type: 'int', min: 1, max: 5 },
    });
    expect(result.error.message).toBe(
      'priorityCount = 7 is outside its bounds: an integer from 1 to 5',
    );
  });

  it('AC-01-03 deleting the weekly series of an eos-lite instance fails with E_INVARIANT naming E-1', () => {
    const state = alderwick();
    const result = changeInstance(eosLite, state, {
      kind: 'remove_series',
      seriesId: ceoWeekly.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_INVARIANT');
    expect(result.error.details['invariantId']).toBe('E-1');
    expect(result.error.message).toMatch(/^E-1: /);
    expect(result.error.help[0]).toMatch(/^E-1: Exactly one weekly leadership meeting/);
    // Nothing is written: the state the caller holds is unchanged.
    expect(state.series.map((series) => series.id)).toContain(ceoWeekly.id);
  });

  it('C-01-04 values are never clamped: type, enum, weekday, time and unknown keys are rejected', () => {
    const bounds = (parameters: Record<string, unknown>) => {
      const result = changeInstance(eosLite, alderwick(), { kind: 'set_parameters', parameters });
      return result.ok ? 'ok' : `${result.error.code} ${String(result.error.details['key'])}`;
    };
    expect(bounds({ priorityCount: 5 })).toBe('ok');
    expect(bounds({ priorityCount: 0 })).toBe('E_PARAM_BOUNDS priorityCount');
    expect(bounds({ priorityCount: 2.5 })).toBe('E_PARAM_BOUNDS priorityCount');
    expect(bounds({ todoHorizonDays: 15 })).toBe('E_PARAM_BOUNDS todoHorizonDays');
    expect(bounds({ 'weekly.duration': 30 })).toBe('E_PARAM_BOUNDS weekly.duration');
    expect(bounds({ 'weekly.weekday': 'Friday' })).toBe('E_PARAM_BOUNDS weekly.weekday');
    expect(bounds({ 'weekly.time': '25:00' })).toBe('E_PARAM_BOUNDS weekly.time');
    expect(bounds({ 'decision.method': 'vote' })).toBe('E_PARAM_BOUNDS decision.method');
    expect(bounds({ 'conclude.rating': 'yes' })).toBe('E_PARAM_BOUNDS conclude.rating');
    expect(bounds({ maxGoals: 2 })).toBe('E_PARAM_BOUNDS maxGoals');
  });

  it('C-01-03 a parameter change that breaks an invariant is refused: priorityCount below the active priorities', () => {
    const result = changeInstance(eosLite, alderwick(), {
      kind: 'set_parameters',
      parameters: { priorityCount: 2 },
    });
    expect(result.ok ? 'ok' : result.error.details['invariantId']).toBe('E-3');
  });

  it('C-01-03 a valid change returns the new state; packs must exist in the release', () => {
    const result = changeInstance(eosLite, alderwick(), {
      kind: 'set_packs',
      packIds: ['pack.client-services'],
    });
    expect(result.ok && result.value.instance.packIds).toEqual(['pack.client-services']);
    const unknown = changeInstance(eosLite, alderwick(), {
      kind: 'set_packs',
      packIds: ['pack.unknown'],
    });
    expect(unknown.ok ? 'ok' : unknown.error.code).toBe('E_USAGE');
  });

  it('C-01-03 an upserted series is checked too: a weekly series that moves weekly is not fixed', () => {
    const result = changeInstance(eosLite, alderwick(), {
      kind: 'upsert_series',
      series: { ...ceoWeekly, rrule: 'FREQ=WEEKLY;BYDAY=TU,FR;BYHOUR=15;BYMINUTE=0' },
    });
    expect(result.ok ? 'ok' : result.error.details['invariantId']).toBe('E-1');
  });

  it('validates against the template version the instance pins', () => {
    const state = alderwick();
    const result = validateInstance(eosLite, {
      ...state,
      instance: { ...state.instance, templateVersion: '2.0.0' },
    });
    expect(result.ok ? 'ok' : result.error.code).toBe('E_USAGE');
  });
});

describe('eos-lite invariants E-1 to E-8 (01 §5.3)', () => {
  it('E-1 one weekly meeting per workstream, fixed weekday and time, backbone order', () => {
    const state = alderwick();
    const duplicate = { ...ceoWeekly, id: 'ser_second', workstreamIds: ['ws_ald'] };
    expect(broken(eosLite, { ...state, series: [...state.series, duplicate] })).toEqual(['E-1']);
    const swapped = {
      ...ceoWeekly,
      agenda: [
        'check_in',
        'goals_review',
        'scorecard',
        'action_review',
        'headlines',
        'issues',
        'conclude',
      ] as const,
    };
    expect(broken(eosLite, { ...state, series: [swapped, ...state.series.slice(1)] })).toEqual([
      'E-1',
    ]);
    const paused = { ...ceoWeekly, status: 'paused' as const };
    expect(broken(eosLite, { ...state, series: [paused, ...state.series.slice(1)] })).toEqual([
      'E-1',
    ]);
  });

  it('E-2 5 to 15 weekly scorecard lines, 3 in solo mode, each with an owner and a target', () => {
    const state = alderwick();
    expect(broken(eosLite, { ...state, measures: state.measures.slice(0, 3) })).toEqual([]);
    expect(broken(eosLite, { ...state, measures: state.measures.slice(0, 2) })).toEqual(['E-2']);
    const team = { ...state, instance: { ...state.instance, mode: 'team' as const } };
    expect(broken(eosLite, { ...team, measures: state.measures.slice(0, 4) })).toEqual(['E-2']);
    const [first, ...rest] = state.measures;
    if (first === undefined) throw new Error('no measure');
    expect(broken(eosLite, { ...state, measures: [without(first, 'target'), ...rest] })).toEqual([
      'E-2',
    ]);
  });

  it('E-3 1 to priorityCount priorities with owner and done-means, graded done or not done', () => {
    const state = alderwick();
    expect(broken(eosLite, { ...state, goals: [] })).toEqual(['E-3']);
    const [first, ...rest] = state.goals;
    if (first === undefined) throw new Error('no goal');
    expect(broken(eosLite, { ...state, goals: [{ ...first, doneMeans: '' }, ...rest] })).toEqual([
      'E-3',
    ]);
    const graded = { ...first, id: 'goal_old', status: 'not_done' as const, grade: 0.9 };
    expect(broken(eosLite, { ...state, goals: [...state.goals, graded] })).toEqual(['E-3']);
  });

  it('E-4 a to-do is due within todoHorizonDays of creation unless it links to a priority', () => {
    const state = alderwick();
    const [item] = state.actionItems ?? [];
    if (item === undefined) throw new Error('no item');
    const late = { ...item, due: { date: '2026-11-30' } };
    expect(broken(eosLite, { ...state, actionItems: [late] })).toEqual(['E-4']);
    const linked = { ...late, goalIds: ['goal_ald_1'] };
    expect(broken(eosLite, { ...state, actionItems: [linked] })).toEqual([]);
    const fortnight = {
      ...state,
      instance: { ...state.instance, parameters: { todoHorizonDays: 14 } },
    };
    expect(
      broken(eosLite, { ...fortnight, actionItems: [{ ...item, due: { date: '2026-11-27' } }] }),
    ).toEqual([]);
    expect(broken(eosLite, { ...state, actionItems: [{ ...item, doneMeans: ' ' }] })).toEqual([
      'E-4',
    ]);
  });

  it('E-5 action_review records only done or not done', () => {
    const state = {
      ...alderwick(),
      actionReview: [{ actionItemId: 'act_a0142', outcome: 'done' }],
    };
    expect(broken(eosLite, state)).toEqual([]);
    const discussed = {
      ...state,
      actionReview: [{ actionItemId: 'act_a0142', outcome: 'discussed' }],
    };
    expect(broken(eosLite, discussed)).toEqual(['E-5']);
  });

  it('E-6 a resolved issue ends as a decision, action items or a drop with a note', () => {
    const issue = (
      status: 'resolved' | 'dropped',
      kind: 'decision' | 'dropped',
      refs: string[],
      note: string,
    ) => ({
      id: 'iss_i0012',
      status,
      resolution: { kind, refs, note },
    });
    const state = alderwick();
    expect(
      broken(eosLite, { ...state, issues: [issue('resolved', 'decision', ['D-0008'], '')] }),
    ).toEqual([]);
    expect(broken(eosLite, { ...state, issues: [issue('resolved', 'decision', [], '')] })).toEqual([
      'E-6',
    ]);
    expect(
      broken(eosLite, { ...state, issues: [issue('dropped', 'dropped', [], 'Not worth it')] }),
    ).toEqual([]);
    expect(broken(eosLite, { ...state, issues: [issue('dropped', 'dropped', [], '')] })).toEqual([
      'E-6',
    ]);
    expect(broken(eosLite, { ...state, issues: [{ id: 'iss_x', status: 'resolved' }] })).toEqual([
      'E-6',
    ]);
  });

  it('E-7 every decision has a decider', () => {
    expect(broken(eosLite, { ...alderwick(), decisions: [{ id: 'dec_x' }] })).toEqual(['E-7']);
  });

  it('E-8 the monthly review includes register health', () => {
    const state = alderwick();
    const series = state.series.map((s) =>
      s.backboneMeetingKey === 'monthly'
        ? { ...s, agenda: s.agenda.filter((t) => t !== 'register_health') }
        : s,
    );
    expect(broken(eosLite, { ...state, series })).toEqual(['E-8']);
  });
});

describe('4dx invariants X-1 to X-5 (01 §5.2)', () => {
  it('X-1 1 or 2 active WIGs, each from X to Y by a date', () => {
    const state = goalArea();
    const [wig] = state.goals;
    if (wig === undefined) throw new Error('no WIG');
    expect(broken(fourDx, { ...state, goals: [], actionItems: [] })).toEqual(['X-1']);
    const three = [wig, { ...wig, id: 'goal_2' }, { ...wig, id: 'goal_3' }];
    expect(broken(fourDx, { ...state, goals: three })).toContain('X-1');
    expect(broken(fourDx, { ...state, goals: [without(wig, 'target')] })).toEqual(['X-1']);
  });

  it('X-2 1 to leadMeasureCount weekly lead measures with owner and target, and exactly one lag', () => {
    const state = goalArea();
    const [lag, ...leads] = state.measures;
    if (lag === undefined) throw new Error('no lag');
    expect(broken(fourDx, { ...state, measures: leads })).toEqual(['X-2']);
    expect(broken(fourDx, { ...state, measures: [lag] })).toEqual(['X-2']);
    const oneLead = {
      ...state,
      instance: { ...state.instance, parameters: { leadMeasureCount: 1 } },
    };
    expect(broken(fourDx, oneLead)).toEqual(['X-2']);
    const monthly = leads.map((m) => ({ ...m, cadence: 'monthly' as const }));
    expect(broken(fourDx, { ...state, measures: [lag, ...monthly] })).toEqual(['X-2']);
  });

  it('X-3 one weekly WIG session: account, scoreboard, commit, conclude', () => {
    const state = goalArea();
    expect(broken(fourDx, { ...state, series: [] })).toEqual(['X-3']);
    const series = state.series.map((s) => ({
      ...s,
      agenda: ['scorecard', 'action_review', 'plan_commitments', 'conclude'] as const,
    }));
    expect(broken(fourDx, { ...state, series })).toEqual(['X-3']);
  });

  it('X-4 a commitment has an owner, a 7-day horizon and a WIG link, within commitmentsPerOwnerPerWeek', () => {
    const state = goalArea();
    const [item] = state.actionItems ?? [];
    if (item === undefined) throw new Error('no item');
    expect(
      broken(fourDx, { ...state, actionItems: [{ ...item, due: { date: '2026-11-17' } }] }),
    ).toEqual(['X-4']);
    const unlinked = { ...item, goalIds: [] };
    expect(broken(fourDx, { ...state, actionItems: [unlinked] })).toEqual(['X-4']);
    const four = [1, 2, 3, 4].map((n) => ({ ...item, id: `act_${n}` }));
    expect(broken(fourDx, { ...state, actionItems: four })).toEqual(['X-4']);
  });

  it('X-5 every lead measure has last period value or is flagged in the pre-read', () => {
    const state = goalArea();
    const flagged = {
      leadMeasureIdsWithValue: ['msr_wig_lead1'],
      flaggedMeasureIds: ['msr_wig_lead2'],
    };
    expect(broken(fourDx, { ...state, preread: flagged })).toEqual([]);
    const missing = { leadMeasureIdsWithValue: ['msr_wig_lead1'], flaggedMeasureIds: [] };
    expect(broken(fourDx, { ...state, preread: missing })).toEqual(['X-5']);
  });
});

describe('personal-os invariants PO-1 to PO-5 (01 §5.1)', () => {
  it('PO-1 exactly one active weekly review, which several workstreams may share', () => {
    const state = personalArea();
    expect(broken(personalOs, { ...state, series: [] })).toContain('PO-1');
    const [weekly] = state.series;
    if (weekly === undefined) throw new Error('no series');
    const shared = { ...weekly, workstreamIds: ['ws_health', 'ws_reading'] };
    expect(broken(personalOs, { ...state, series: [shared] })).toEqual([]);
  });

  it('PO-2 1 to maxGoals active goals', () => {
    const state = personalArea();
    const [goal] = state.goals;
    if (goal === undefined) throw new Error('no goal');
    expect(broken(personalOs, { ...state, goals: [] })).toEqual(['PO-2']);
    const four = [1, 2, 3, 4].map((n) => ({ ...goal, id: `goal_${n}` }));
    expect(broken(personalOs, { ...state, goals: four })).toEqual(['PO-2']);
    const max1 = { ...state, instance: { ...state.instance, parameters: { maxGoals: 1 } } };
    expect(broken(personalOs, { ...max1, goals: four.slice(0, 2) })).toEqual(['PO-2']);
  });

  it('PO-3 every goal has a done-means or a measure', () => {
    const state = personalArea();
    const [goal] = state.goals;
    if (goal === undefined) throw new Error('no goal');
    expect(broken(personalOs, { ...state, goals: [{ ...goal, doneMeans: '' }] })).toEqual(['PO-3']);
    const measured = { ...goal, doneMeans: '', measureIds: ['msr_run'] };
    expect(broken(personalOs, { ...state, goals: [measured] })).toEqual([]);
  });

  it('PO-4 the weekly review agenda order', () => {
    const state = personalArea();
    const series = state.series.map((s) => ({
      ...s,
      agenda: s.agenda.filter((t) => t !== 'plan_commitments'),
    }));
    expect(broken(personalOs, { ...state, series })).toEqual(['PO-4']);
  });

  it('PO-5 every open action item has an owner and a due date', () => {
    const state = personalArea();
    const item = {
      id: 'act_run',
      kind: 'todo' as const,
      doneMeans: 'Run logged.',
      lifecycle: 'open' as const,
      createdOn: '2026-11-09',
      goalIds: [],
    };
    expect(
      broken(personalOs, { ...state, actionItems: [{ ...item, ownerId: 'per_self' }] }),
    ).toEqual(['PO-5']);
    expect(
      broken(personalOs, { ...state, actionItems: [{ ...item, due: { date: '2026-11-15' } }] }),
    ).toEqual(['PO-5']);
    const done = { ...item, lifecycle: 'verified_done' as const };
    expect(broken(personalOs, { ...state, actionItems: [done] })).toEqual([]);
  });
});
