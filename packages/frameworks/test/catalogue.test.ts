/**
 * The built catalogue against the design (01 §5): the three v1 templates with their
 * backbones, parameters and vocabularies, the six packs, and the template checks that every
 * foundation and engine file passes (C-01-03).
 */
import { describe, expect, it } from 'vitest';

import {
  builtPacks,
  builtTemplates,
  checkPack,
  checkTemplate,
  findTemplate,
  templateDir,
} from '@cc/frameworks';
import { V1_PACK_IDS, type FrameworkTemplate } from '@cc/schemas';

function template(id: 'eos-lite' | '4dx' | 'personal-os'): FrameworkTemplate {
  const found = findTemplate(id);
  if (found === undefined) throw new Error(`no template ${id}`);
  return found;
}

const durations = (t: FrameworkTemplate) =>
  Object.fromEntries(
    t.backbone.meetings.map((m) => [
      m.key,
      [m.required, m.durationMinutes.min, m.durationMinutes.default, m.durationMinutes.max],
    ]),
  );

describe('the v1 catalogue (01 §5)', () => {
  it('builds personal-os, 4dx and eos-lite at 1.0.0, and the six packs of 01 §5.5', () => {
    expect(builtTemplates.map((t) => `${t.id}@${t.version}`).sort()).toEqual([
      '4dx@1.0.0',
      'eos-lite@1.0.0',
      'personal-os@1.0.0',
    ]);
    expect(builtPacks.map((p) => p.id).sort()).toEqual([...V1_PACK_IDS].sort());
    for (const t of builtTemplates) expect(checkTemplate(t), t.id).toEqual([]);
    for (const p of builtPacks) expect(checkPack(p), p.id).toEqual([]);
  });

  it('personal-os follows 01 §5.1', () => {
    const t = template('personal-os');
    expect(t.backbone.goalModel).toBe('personal_goals');
    expect(durations(t)).toEqual({
      weekly: [true, 30, 45, 90],
      daily: [false, 5, 10, 15],
      monthly: [false, 30, 60, 90],
      quarterly: [true, 60, 90, 180],
    });
    expect(t.backbone.invariants.map((i) => i.id)).toEqual([
      'PO-1',
      'PO-2',
      'PO-3',
      'PO-4',
      'PO-5',
    ]);
    expect(t.parameters.map((p) => p.key)).toEqual([
      'weekly.weekday',
      'weekly.time',
      'weekly.duration',
      'daily.enabled',
      'daily.time',
      'monthly.enabled',
      'maxGoals',
    ]);
    expect(t.vocabulary).toEqual({
      goal: 'Goal',
      action: 'Action',
      issue: 'Snag',
      measure: 'Measure',
      meeting: 'Review',
    });
  });

  it('4dx follows 01 §5.2', () => {
    const t = template('4dx');
    expect(t.backbone.goalModel).toBe('wig');
    expect(durations(t)).toEqual({ weekly: [true, 15, 30, 45] });
    expect(t.backbone.invariants.map((i) => i.id)).toEqual(['X-1', 'X-2', 'X-3', 'X-4', 'X-5']);
    expect(t.parameters.map((p) => [p.key, p.default, p.min, p.max])).toEqual([
      ['weekly.weekday', 'MO', undefined, undefined],
      ['weekly.time', '13:15', undefined, undefined],
      ['weekly.duration', 30, 15, 45],
      ['commitmentsPerOwnerPerWeek', 3, 1, 5],
      ['leadMeasureCount', 2, 1, 3],
    ]);
    expect(t.vocabulary.goal).toBe('WIG');
    expect(t.vocabulary.meeting).toBe('WIG session');
  });

  it('eos-lite follows 01 §5.3, with the mode-dependent defaults', () => {
    const t = template('eos-lite');
    expect(t.backbone.goalModel).toBe('rocks');
    expect(durations(t)).toEqual({
      weekly: [true, 45, 60, 90],
      monthly: [true, 60, 90, 120],
      quarterly: [true, 120, 240, 480],
      yearly: [true, 240, 480, 480],
      daily: [false, 5, 10, 15],
    });
    const meetings = Object.fromEntries(t.backbone.meetings.map((m) => [m.key, m]));
    expect(meetings['yearly']?.durationMinutes.defaultByMode).toEqual({ solo: 240 });
    expect(meetings['daily']?.modes).toEqual(['team']);
    expect(t.backbone.invariants.map((i) => i.id)).toEqual([
      'E-1',
      'E-2',
      'E-3',
      'E-4',
      'E-5',
      'E-6',
      'E-7',
      'E-8',
    ]);
    const spec = Object.fromEntries(t.parameters.map((p) => [p.key, p]));
    expect(Object.keys(spec)).toEqual([
      'weekly.weekday',
      'weekly.time',
      'weekly.duration',
      'monthly.week',
      'quarterly.weekOfQuarter',
      'priorityCount',
      'todoHorizonDays',
      'conclude.rating',
      'decision.method',
      'decision.memoForOneWayDoors',
    ]);
    expect([
      spec['priorityCount']?.min,
      spec['priorityCount']?.max,
      spec['priorityCount']?.default,
    ]).toEqual([1, 5, 3]);
    expect([
      spec['todoHorizonDays']?.min,
      spec['todoHorizonDays']?.max,
      spec['todoHorizonDays']?.default,
    ]).toEqual([7, 14, 7]);
    expect([spec['quarterly.weekOfQuarter']?.min, spec['quarterly.weekOfQuarter']?.max]).toEqual([
      -2, -1,
    ]);
    expect(spec['monthly.week']?.enum).toEqual(['first', 'last']);
    expect(spec['decision.method']?.enum).toEqual(['single_decider', 'daci']);
    expect([spec['conclude.rating']?.default, spec['conclude.rating']?.defaultByMode]).toEqual([
      true,
      { solo: false },
    ]);
    expect(t.extensionSlots).toEqual(['after:headlines']);
  });

  it('places a custom: template under custom/<name>, since a colon is not a Windows file name character', () => {
    expect(templateDir('eos-lite')).toBe('eos-lite');
    expect(templateDir('custom:ald-weekly')).toBe('custom/ald-weekly');
  });
});

describe('template checks (C-01-03)', () => {
  const base = () => structuredClone(template('eos-lite'));

  it('every invariant names a registered validator whose parameters the template declares', () => {
    const unknown = base();
    unknown.backbone.invariants[0] = { id: 'E-1', text: 'x', validator: 'noSuchValidator' };
    expect(checkTemplate(unknown)).toEqual([
      'invariant E-1: no validator noSuchValidator in packages/frameworks/validators',
    ]);
    const missing = base();
    missing.parameters = missing.parameters.filter((p) => p.key !== 'priorityCount');
    expect(checkTemplate(missing)).toEqual([
      'invariant E-3: priorityCountAndShape reads parameter priorityCount, which the template does not declare',
    ]);
  });

  it('defaults lie within their bounds, and duration bounds match their meeting', () => {
    const bad = base();
    bad.parameters = bad.parameters.map((p) =>
      p.key === 'priorityCount' ? { ...p, default: 6 } : p,
    );
    expect(checkTemplate(bad)).toEqual([
      'parameter priorityCount: default 6 is not an integer from 1 to 5',
    ]);
    const duration = base();
    duration.parameters = duration.parameters.map((p) =>
      p.key === 'weekly.duration' ? { ...p, max: 120 } : p,
    );
    expect(checkTemplate(duration)).toEqual([
      'parameter weekly.duration: bounds must match the weekly meeting (45 to 90)',
    ]);
  });

  it('only a custom: template is a fork, and every custom: template is one', () => {
    const notFork = {
      ...base(),
      forkedFrom: { templateId: 'eos-lite' as const, version: '1.0.0' },
    };
    expect(checkTemplate(notFork)).toEqual(['forkedFrom: only a custom: template is a fork']);
    const orphan = { ...base(), id: 'custom:orphan' };
    expect(checkTemplate(orphan)).toEqual([
      'forkedFrom: a custom: template records the template it was forked from',
    ]);
  });

  it('rejects what the schema rejects', () => {
    expect(checkTemplate({ ...base(), id: 'kanban' })[0]).toMatch(/^id: /);
    expect(checkPack({ id: 'marketing' })[0]).toMatch(/^id: /);
  });
});
