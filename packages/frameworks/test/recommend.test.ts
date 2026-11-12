/**
 * The recommender of 01 §6: the scenario (AC-01-01), the availability rule (AC-01-02), every
 * base rule and modifier at least once (§6.6 item 4), and the properties of §6.6.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  builtTemplates,
  findTemplate,
  FrameworkError,
  recommend,
  RECOMMENDER_VERSION,
} from '@cc/frameworks';
import type {
  FrameworkTemplate,
  OnboardingProfile,
  ToolAnswer,
  WorkstreamAnswers,
} from '@cc/schemas';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const TODAY = '2026-11-04';

function fixture(name: string): OnboardingProfile {
  return JSON.parse(
    readFileSync(join(root, 'fixtures', 'onboarding', name), 'utf8'),
  ) as OnboardingProfile;
}

const scenario = () => fixture('scenario.json');

function company(overrides: Partial<WorkstreamAnswers> = {}): WorkstreamAnswers {
  return {
    key: 'acme',
    kind: 'company',
    name: 'Acme',
    principal: { kind: 'self' },
    headcount: 1,
    leadershipGroupSize: 1,
    hasTeamsUnderLeads: false,
    stage: 'early_revenue',
    businessType: 'ecommerce',
    primaryGoal: 'grow_revenue',
    goalShape: 'few_priorities',
    existingFramework: 'none',
    weightPreference: 'light',
    confidentiality: 'normal',
    ...overrides,
  };
}

function profileOf(workstreams: WorkstreamAnswers[], tools: ToolAnswer[] = []): OnboardingProfile {
  const base = scenario();
  return { ...base, workstreams, tools };
}

function one(workstream: WorkstreamAnswers, options = {}) {
  const [recommendation] = recommend(profileOf([workstream]), TODAY, options);
  if (recommendation === undefined) throw new Error('no recommendation');
  return recommendation;
}

/** A P7 release: eos, okr and scaling-up built (stand-ins with their own IDs). */
function p7Templates(): FrameworkTemplate[] {
  const eosLite = findTemplate('eos-lite');
  const fourDx = findTemplate('4dx');
  if (eosLite === undefined || fourDx === undefined) throw new Error('catalogue incomplete');
  return [
    ...builtTemplates,
    { ...eosLite, id: 'eos', name: 'EOS' },
    { ...eosLite, id: 'scaling-up', name: 'Scaling Up' },
    { ...fourDx, id: 'okr', name: 'OKR', backbone: { ...fourDx.backbone, goalModel: 'okr' } },
  ];
}

describe('recommend() on the reference scenario (01 §7)', () => {
  it('AC-01-01 returns the templates, modes, packs and fired rules of 01 §7.2', () => {
    const result = recommend(scenario(), TODAY);
    expect(
      result.map(({ workstreamKey, templateId, mode, packIds, firedRules }) => ({
        workstreamKey,
        templateId,
        mode,
        packIds,
        firedRules,
      })),
    ).toEqual([
      {
        workstreamKey: 'alderwick',
        templateId: 'eos-lite',
        mode: 'solo',
        packIds: ['pack.client-services', 'pack.product', 'pack.marketing'],
        firedRules: ['R8', 'M2', 'M5', 'M6', 'M7', 'M8'],
      },
      {
        workstreamKey: 'quillmarsh',
        templateId: 'eos-lite',
        mode: 'solo',
        packIds: ['pack.product', 'pack.marketing'],
        firedRules: ['R8', 'M2', 'M6', 'M7', 'M8'],
      },
    ]);
  });

  it('AC-01-01 carries the notes of 01 §7.2: the merge group, normal privacy for both companies', () => {
    const [ald, qlm] = recommend(scenario(), TODAY);
    expect(ald?.mergeGroup).toBe('weekly-ceo-review');
    expect(qlm?.mergeGroup).toBe('weekly-ceo-review');
    expect(ald?.privacy).toBe('normal');
    expect(qlm?.privacy).toBe('normal');
    expect(qlm?.aiDataPolicy).toBe('allow');
    expect(recommend(scenario(), TODAY).flatMap((r) => r.warnings)).toEqual([]);
  });

  it('AC-01-01 the sample profile gives the same recommendations as the scenario', () => {
    const strip = (profile: OnboardingProfile) =>
      recommend(profile, TODAY).map(({ templateId, mode, packIds, firedRules }) => ({
        templateId,
        mode,
        packIds,
        firedRules,
      }));
    expect(strip(fixture('sample-profile.json'))).toEqual(strip(scenario()));
  });
});

describe('the availability rule (01 §6.2)', () => {
  const alderwick12 = (weightPreference: WorkstreamAnswers['weightPreference']) => {
    const profile = scenario();
    const [ald, ...rest] = profile.workstreams;
    if (ald === undefined) throw new Error('scenario has no Alderwick');
    return { ...profile, workstreams: [{ ...ald, headcount: 12, weightPreference }, ...rest] };
  };

  it('AC-01-02 headcount 12 with standard weight returns eos-lite with W-NOT-BUILT naming eos before P7', () => {
    const [ald] = recommend(alderwick12('standard'), TODAY);
    expect(ald?.templateId).toBe('eos-lite');
    expect(ald?.firedRules[0]).toBe('R7');
    expect(ald?.warnings).toHaveLength(1);
    expect(ald?.warnings[0]?.code).toBe('W-NOT-BUILT');
    expect(ald?.warnings[0]?.text).toMatch(/\bR7 selected eos\b/);
  });

  it('AC-01-02 headcount 12 with standard weight returns eos (R7) once eos is built', () => {
    const [ald] = recommend(alderwick12('standard'), TODAY, { templates: p7Templates() });
    expect(ald?.templateId).toBe('eos');
    expect(ald?.firedRules[0]).toBe('R7');
    expect(ald?.warnings).toEqual([]);
  });

  it('AC-01-02 headcount 12 with light weight returns eos-lite (R7) and no W-NOT-BUILT', () => {
    const [ald] = recommend(alderwick12('light'), TODAY);
    expect(ald?.templateId).toBe('eos-lite');
    expect(ald?.firedRules[0]).toBe('R7');
    expect(ald?.warnings).toEqual([]);
  });

  it('maps okr to 4dx and scaling-up to eos-lite before P7', () => {
    const okr = one(company({ headcount: 20, existingFramework: 'okr', keepExisting: true }));
    expect([okr.templateId, okr.firedRules[0], okr.warnings[0]?.code]).toEqual([
      '4dx',
      'R1',
      'W-NOT-BUILT',
    ]);
    const scaling = one(company({ headcount: 80, weightPreference: 'full' }));
    expect([scaling.templateId, scaling.firedRules[0]]).toEqual(['eos-lite', 'R6']);
    expect(scaling.warnings[0]?.text).toMatch(/selected scaling-up/);
  });
});

describe('base rules R1 to R9 (01 §6.2)', () => {
  const cases: [string, Partial<WorkstreamAnswers>, string, string][] = [
    [
      'R1 keeps a built existing framework',
      { headcount: 20, existingFramework: '4dx', keepExisting: true },
      'R1',
      '4dx',
    ],
    [
      'R1 does not fire for an existing framework the user drops',
      { existingFramework: '4dx', keepExisting: false },
      'R8',
      'eos-lite',
    ],
    [
      'R1 does not fire for "other"',
      { existingFramework: 'other', keepExisting: true },
      'R8',
      'eos-lite',
    ],
    ['R2 a job search', { kind: 'job_search', businessType: 'n_a' }, 'R2', '4dx'],
    [
      'R3 one dominant outcome within a year',
      { goalShape: 'one_dominant_outcome', deadline: '2027-06-30' },
      'R3',
      '4dx',
    ],
    [
      'R3 needs the deadline within 365 days',
      { goalShape: 'one_dominant_outcome', deadline: '2027-12-31' },
      'R8',
      'eos-lite',
    ],
    [
      'R3 needs a deadline',
      { goalShape: 'one_dominant_outcome', deadline: null },
      'R8',
      'eos-lite',
    ],
    ['R4 a personal goal area', { kind: 'personal', businessType: 'n_a' }, 'R4', 'personal-os'],
    [
      'R6 a company of 50 or more (eos before P7: eos-lite)',
      { headcount: 50, weightPreference: 'standard' },
      'R6',
      'eos-lite',
    ],
    ['R7 a company of 10 to 49, light', { headcount: 49 }, 'R7', 'eos-lite'],
    ['R8 a company of fewer than 10', { headcount: 9, weightPreference: 'full' }, 'R8', 'eos-lite'],
    ['R8 a business unit', { kind: 'business_unit' }, 'R8', 'eos-lite'],
    ['R9 anything else', { kind: 'other' }, 'R9', 'personal-os'],
    ['R9 a client engagement without a parent', { kind: 'client_engagement' }, 'R9', 'personal-os'],
  ];
  it.each(cases)('%s', (_name, overrides, rule, templateId) => {
    const result = one(company(overrides));
    expect(result.firedRules[0]).toBe(rule);
    expect(result.templateId).toBe(templateId);
  });

  it('R6 selects eos, or scaling-up with full weight or teams under leads, once built', () => {
    const templates = p7Templates();
    const pick = (overrides: Partial<WorkstreamAnswers>) =>
      one(company({ headcount: 60, weightPreference: 'standard', ...overrides }), { templates })
        .templateId;
    expect(pick({})).toBe('eos');
    expect(pick({ weightPreference: 'full' })).toBe('scaling-up');
    expect(pick({ hasTeamsUnderLeads: true })).toBe('scaling-up');
  });

  it('R5 a client engagement under a company uses its parent instance, through any depth', () => {
    const parent = company({ key: 'alderwick', businessType: 'services' });
    const engagement = company({
      key: 'retainer-client',
      kind: 'client_engagement',
      parentKey: 'alderwick',
      businessType: 'n_a',
    });
    const project = company({
      key: 'audit',
      kind: 'project',
      parentKey: 'retainer-client',
      businessType: 'n_a',
    });
    const [, child, grandchild] = recommend(profileOf([parent, engagement, project]), TODAY);
    expect(child?.firedRules[0]).toBe('R5');
    expect(child?.templateId).toBe('eos-lite');
    expect(child?.parameterDefaults).toEqual({});
    expect(child?.mergeGroup).toBeUndefined();
    expect(child?.rationale[0]).toMatch(/block in alderwick's weekly meeting/);
    expect(grandchild?.firedRules[0]).toBe('R5');
    expect(grandchild?.rationale[0]).toMatch(/under retainer-client .* alderwick's weekly meeting/);
  });
});

describe('modifiers M1 to M8 (01 §6.3)', () => {
  it('M1 sets the okr goal model under an eos or scaling-up backbone, once built', () => {
    const answers = company({
      headcount: 20,
      weightPreference: 'standard',
      hasTeamsUnderLeads: true,
      businessType: 'product',
      leadershipGroupSize: 4,
    });
    const built = one(answers, { templates: p7Templates() });
    expect(built.templateId).toBe('eos');
    expect(built.firedRules).toContain('M1');
    expect(built.goalModel).toBe('okr');
    const prior = one(answers);
    expect(prior.firedRules).not.toContain('M1');
    expect(prior.goalModel).toBe('rocks');
  });

  it('M2 solo mode for a leadership group of one, team mode otherwise', () => {
    expect(one(company()).mode).toBe('solo');
    const team = one(company({ leadershipGroupSize: 3 }));
    expect(team.mode).toBe('team');
    expect(team.firedRules).not.toContain('M2');
  });

  it('M2 team mode changes the mode-dependent defaults (eos-lite conclude.rating)', () => {
    expect(one(company()).parameterDefaults['conclude.rating']).toBe(false);
    expect(one(company({ leadershipGroupSize: 3 })).parameterDefaults['conclude.rating']).toBe(
      true,
    );
  });

  it('M3 a confidential workstream is sensitive with people redacted', () => {
    const result = one(company({ confidentiality: 'sensitive' }));
    expect(result.firedRules).toContain('M3');
    expect([result.privacy, result.aiDataPolicy]).toEqual(['sensitive', 'redact_people']);
  });

  it('M4 a fractional search gets pack.job-search-fractional, any other pack.job-search', () => {
    const search = (roleType: WorkstreamAnswers['roleType']) =>
      one(company({ kind: 'job_search', businessType: 'n_a', roleType })).packIds;
    expect(search('fractional')).toEqual(['pack.job-search-fractional']);
    expect(search('contract')).toEqual(['pack.job-search']);
    expect(search(undefined)).toEqual(['pack.job-search']);
  });

  it('M4 does not fire when R1 picked 4dx for a job search', () => {
    const result = one(
      company({
        kind: 'job_search',
        businessType: 'n_a',
        existingFramework: '4dx',
        keepExisting: true,
      }),
    );
    expect(result.firedRules).toEqual(['R1', 'M2']);
  });

  it('M5 and M6 add the services and product packs to companies only', () => {
    expect(one(company({ businessType: 'services' })).packIds).toEqual(['pack.client-services']);
    expect(one(company({ businessType: 'product' })).packIds).toEqual(['pack.product']);
    expect(one(company({ businessType: 'ecommerce' })).packIds).toEqual([]);
    expect(one(company({ kind: 'business_unit', businessType: 'services' })).packIds).toEqual([]);
  });

  it('M7 a social, social scheduler or CMS tool adds pack.marketing', () => {
    const tool = (category: ToolAnswer['category']): ToolAnswer => ({
      workstreamKeys: ['acme'],
      category,
      toolName: 'Tool',
      choice: { kind: 'later' },
    });
    const packs = (category: ToolAnswer['category']) =>
      recommend(profileOf([company()], [tool(category)]), TODAY)[0]?.packIds;
    expect(packs('cms')).toEqual(['pack.marketing']);
    expect(packs('social_scheduler')).toEqual(['pack.marketing']);
    expect(packs('email')).toEqual([]);
  });

  it('M8 merges only when two or more workstreams are eos-lite in solo mode', () => {
    const a = company({ key: 'a' });
    const b = company({ key: 'b' });
    const teamB = company({ key: 'b', leadershipGroupSize: 2 });
    expect(recommend(profileOf([a]), TODAY)[0]?.mergeGroup).toBeUndefined();
    expect(recommend(profileOf([a, b]), TODAY).map((r) => r.mergeGroup)).toEqual([
      'weekly-ceo-review',
      'weekly-ceo-review',
    ]);
    expect(recommend(profileOf([a, teamB]), TODAY).map((r) => r.mergeGroup)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe('properties of recommend() (01 §6.6)', () => {
  it('C-01-02 is deterministic, leaves its input unchanged and stamps the recommender version', () => {
    const profile = scenario();
    const copy = structuredClone(profile);
    const first = recommend(profile, TODAY);
    expect(recommend(profile, TODAY)).toEqual(first);
    expect(profile).toEqual(copy);
    expect(first.every((r) => r.recommenderVersion === RECOMMENDER_VERSION)).toBe(true);
  });

  it('is total and explainable: one recommendation per workstream, a rationale line per fired rule, two other alternatives', () => {
    const workstreams = [
      company({ key: 'a' }),
      company({ key: 'b', kind: 'personal', businessType: 'n_a' }),
      company({ key: 'c', kind: 'job_search', businessType: 'n_a' }),
      company({ key: 'd', kind: 'other' }),
      company({ key: 'e', kind: 'project', parentKey: 'a' }),
    ];
    const result = recommend(profileOf(workstreams), TODAY);
    expect(result.map((r) => r.workstreamKey)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const r of result) {
      expect(r.rationale.map((line) => line.split(':')[0])).toEqual(r.firedRules);
      expect(r.alternatives).toHaveLength(2);
      const ids = r.alternatives.map((alternative) => alternative.templateId);
      expect(new Set(ids).size).toBe(2);
      expect(ids).not.toContain(r.templateId);
      expect(ids.every((id) => builtTemplates.some((t) => t.id === id))).toBe(true);
    }
  });

  it('alternatives follow same band, one band lighter, then personal-os', () => {
    const [ald] = recommend(scenario(), TODAY);
    expect(ald?.alternatives.map((a) => a.templateId)).toEqual(['4dx', 'personal-os']);
    const fourDx = one(
      company({ kind: 'personal', goalShape: 'one_dominant_outcome', deadline: '2027-03-31' }),
    );
    expect(fourDx.templateId).toBe('4dx');
    expect(fourDx.alternatives.map((a) => a.templateId)).toEqual(['personal-os', 'eos-lite']);
  });

  it('rejects an invalid profile with E_USAGE naming the JSON pointer', () => {
    const catchError = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error as FrameworkError;
      }
      throw new Error('expected an error');
    };
    const bad = scenario();
    (bad.workstreams[1] as { headcount: number }).headcount = 0;
    const error = catchError(() => recommend(bad, TODAY));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.code).toBe('E_USAGE');
    expect(error.details['pointer']).toBe('/workstreams/1/headcount');

    const orphan = profileOf([company({ kind: 'project', parentKey: 'missing' })]);
    expect(catchError(() => recommend(orphan, TODAY)).details['pointer']).toBe(
      '/workstreams/0/parentKey',
    );
    const cycle = profileOf([
      company({ key: 'x', kind: 'project', parentKey: 'y' }),
      company({ key: 'y', kind: 'project', parentKey: 'x' }),
    ]);
    expect(catchError(() => recommend(cycle, TODAY)).message).toMatch(/cycle/);
    const tool: ToolAnswer = {
      workstreamKeys: ['nope'],
      category: 'cms',
      toolName: 'CMS',
      choice: { kind: 'later' },
    };
    expect(
      catchError(() => recommend(profileOf([company()], [tool]), TODAY)).details['pointer'],
    ).toBe('/tools/0/workstreamKeys/0');
    expect(catchError(() => recommend(scenario(), 'today')).code).toBe('E_USAGE');
  });
});
