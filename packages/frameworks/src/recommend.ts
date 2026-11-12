/**
 * The recommender (01 §6): a pure, deterministic function of the onboarding answers that
 * returns one FrameworkRecommendation per workstream. The base rules R1 to R9 pick a
 * template (first match wins), the availability rule swaps a template that is not built in
 * this release for the closest built one, and the modifiers M1 to M8 apply in order. No AI is
 * involved (C-01-02).
 *
 * Reading of §6.3 used here: the modifiers that shape the instance (M1's goal model, M8's
 * merged meeting) test the template the instance will use, after the availability rule; M4
 * tests the rule that chose the base. Before P7, M1 therefore never fires: eos and
 * scaling-up become eos-lite, whose goal model is rocks.
 */
import {
  OnboardingProfile as OnboardingProfileSchema,
  type CatalogueTemplateId,
  type FrameworkId,
  type FrameworkMode,
  type FrameworkRecommendation,
  type FrameworkTemplate,
  type GoalModel,
  type OnboardingProfile,
  type PackId,
  type WorkstreamAnswers,
} from '@cc/schemas';

import { builtTemplates, findTemplate } from './catalogue.js';
import { FrameworkError } from './errors.js';
import { defaultParameters } from './parameters.js';

/** The version of the rule tables of 01 §6.2 and §6.3; changing them bumps it (C-01-02). */
export const RECOMMENDER_VERSION = '1.0.0';

export interface RecommendOptions {
  /**
   * The templates built in the running release, for the availability rule. Default: this
   * release's catalogue (personal-os, 4dx and eos-lite before P7).
   */
  readonly templates?: readonly FrameworkTemplate[];
}

/** 01 §6.2 availability rule: the closest built template for one that is not built yet. */
const CLOSEST: Readonly<Record<string, FrameworkId>> = {
  eos: 'eos-lite',
  'scaling-up': 'eos-lite',
  okr: '4dx',
};

const EXISTING: Readonly<Record<string, CatalogueTemplateId>> = {
  eos: 'eos',
  okr: 'okr',
  '4dx': '4dx',
  scaling_up: 'scaling-up',
};

/** 01 §6.5: the size band beside each template, then one band lighter. */
const SAME_BAND: Readonly<Record<string, FrameworkId>> = {
  'scaling-up': 'eos',
  eos: 'eos-lite',
  'eos-lite': '4dx',
  okr: '4dx',
  '4dx': 'okr',
  'personal-os': '4dx',
};
const LIGHTER: Readonly<Record<string, FrameworkId>> = {
  'scaling-up': 'eos',
  eos: 'eos-lite',
  'eos-lite': 'personal-os',
  okr: '4dx',
  '4dx': 'personal-os',
};
/** Fills the alternatives when the band order yields fewer than two built templates. */
const FALLBACK_ORDER: readonly FrameworkId[] = ['eos-lite', '4dx', 'personal-os'];

const WHY_NOT: Readonly<Record<string, string>> = {
  'personal-os': 'a light weekly personal review, with no leadership meeting or scorecard backbone',
  '4dx': 'one or two goals from X to Y by a date, moved by lead measures in a weekly WIG session',
  'eos-lite':
    'a weekly leadership meeting with a scorecard, quarterly priorities and monthly, quarterly and yearly reviews',
  eos: 'the full EOS system, sized for 10 to 250 people',
  okr: 'objectives and key results on a quarterly cycle',
  'scaling-up': 'the full Scaling Up rhythm, for growth companies of about 50 people and up',
};

const MARKETING_CATEGORIES = new Set(['social', 'social_scheduler', 'cms']);

interface Base {
  readonly rule: string;
  /** The template the rule selected, built or not. */
  readonly selected: FrameworkId;
  readonly line: string;
  /** R5: the root workstream whose instance this one uses. */
  readonly inheritsFrom?: string;
}

function usage(message: string, pointer: string): FrameworkError {
  return new FrameworkError({
    code: 'E_USAGE',
    message: `${pointer}: ${message}`,
    help: [`Fix the answer at ${pointer} (01 §4 OnboardingProfile).`],
    details: { pointer },
  });
}

function parseDate(date: string): number {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Validates the profile shape and the references between answers. */
function checkProfile(value: unknown, today: string): OnboardingProfile {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw usage('today is not a date YYYY-MM-DD', 'today');
  const parsed = OnboardingProfileSchema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const pointer = `/${(issue?.path ?? []).map(String).join('/')}`;
    throw usage(issue?.message ?? 'invalid answer', pointer);
  }
  const profile = parsed.data;
  const keys = new Map<string, number>();
  profile.workstreams.forEach((workstream, index) => {
    if (keys.has(workstream.key)) {
      throw usage(`duplicate workstream key ${workstream.key}`, `/workstreams/${index}/key`);
    }
    keys.set(workstream.key, index);
  });
  profile.workstreams.forEach((workstream, index) => {
    const seen = new Set<string>([workstream.key]);
    let parentKey = workstream.parentKey;
    while (parentKey !== undefined) {
      const parentIndex = keys.get(parentKey);
      if (parentIndex === undefined) {
        throw usage(`no workstream ${parentKey}`, `/workstreams/${index}/parentKey`);
      }
      if (seen.has(parentKey)) {
        throw usage(
          `parentKey forms a cycle through ${parentKey}`,
          `/workstreams/${index}/parentKey`,
        );
      }
      seen.add(parentKey);
      parentKey = profile.workstreams[parentIndex]?.parentKey;
    }
  });
  profile.tools.forEach((tool, index) => {
    tool.workstreamKeys.forEach((key, keyIndex) => {
      if (!keys.has(key)) {
        throw usage(`no workstream ${key}`, `/tools/${index}/workstreamKeys/${keyIndex}`);
      }
    });
  });
  return profile;
}

/** 01 §6.2: the first matching base rule. */
function baseRule(
  workstream: WorkstreamAnswers,
  today: string,
  byKey: ReadonlyMap<string, WorkstreamAnswers>,
): Base {
  const h = Math.max(1, workstream.headcount);
  const deadline = workstream.deadline ?? null;
  const deadlineDays =
    deadline === null ? null : Math.round((parseDate(deadline) - parseDate(today)) / 86_400_000);
  const isCompany = workstream.kind === 'company' || workstream.kind === 'business_unit';

  const existing = EXISTING[workstream.existingFramework];
  if (workstream.keepExisting === true && existing !== undefined) {
    return {
      rule: 'R1',
      selected: existing,
      line: `R1: keep the existing framework (${workstream.existingFramework}) → ${existing}`,
    };
  }
  if (workstream.kind === 'job_search') {
    return { rule: 'R2', selected: '4dx', line: 'R2: a job search → 4dx' };
  }
  if (
    workstream.goalShape === 'one_dominant_outcome' &&
    deadlineDays !== null &&
    deadlineDays <= 365
  ) {
    return {
      rule: 'R3',
      selected: '4dx',
      line: `R3: one dominant outcome due in ${deadlineDays} days (365 or fewer) → 4dx`,
    };
  }
  if (workstream.kind === 'personal') {
    return { rule: 'R4', selected: 'personal-os', line: 'R4: a personal goal area → personal-os' };
  }
  if (
    (workstream.kind === 'client_engagement' || workstream.kind === 'project') &&
    workstream.parentKey !== undefined
  ) {
    let root = workstream;
    for (let parent = byKey.get(root.parentKey ?? ''); parent !== undefined;) {
      root = parent;
      parent = root.parentKey === undefined ? undefined : byKey.get(root.parentKey);
    }
    const rootBase = baseRule(root, today, byKey);
    return {
      rule: 'R5',
      selected: rootBase.selected,
      inheritsFrom: root.key,
      line: `R5: a ${workstream.kind.replace('_', ' ')} under ${workstream.parentKey} → no own meetings; a block in ${root.key}'s weekly meeting`,
    };
  }
  if (isCompany && h >= 50) {
    const full = workstream.weightPreference === 'full' || workstream.hasTeamsUnderLeads;
    return {
      rule: 'R6',
      selected: full ? 'scaling-up' : 'eos',
      line: `R6: a ${workstream.kind.replace('_', ' ')} of ${h} people (50 or more)${full ? ', full weight or teams under leads' : ''} → ${full ? 'scaling-up' : 'eos'}`,
    };
  }
  if (isCompany && h >= 10) {
    const light = workstream.weightPreference === 'light';
    return {
      rule: 'R7',
      selected: light ? 'eos-lite' : 'eos',
      line: `R7: a ${workstream.kind.replace('_', ' ')} of ${h} people (10 to 49), ${workstream.weightPreference} weight → ${light ? 'eos-lite' : 'eos'}`,
    };
  }
  if (isCompany) {
    return {
      rule: 'R8',
      selected: 'eos-lite',
      line: `R8: a ${workstream.kind.replace('_', ' ')} of ${h} ${h === 1 ? 'person' : 'people'} (fewer than 10) → eos-lite`,
    };
  }
  return { rule: 'R9', selected: 'personal-os', line: 'R9: no other rule matched → personal-os' };
}

function availableTemplate(
  id: FrameworkId,
  templates: readonly FrameworkTemplate[],
): FrameworkTemplate | undefined {
  return findTemplate(id, undefined, templates);
}

interface Draft {
  readonly workstream: WorkstreamAnswers;
  readonly base: Base;
  readonly template: FrameworkTemplate;
  readonly mode: FrameworkMode;
  readonly firedRules: string[];
  readonly rationale: string[];
  readonly warnings: { code: string; text: string }[];
  readonly packIds: PackId[];
  goalModel: GoalModel;
  sensitive: boolean;
}

function alternatives(
  chosen: FrameworkId,
  baseLine: string,
  templates: readonly FrameworkTemplate[],
): FrameworkRecommendation['alternatives'] {
  const order: (FrameworkId | undefined)[] = [
    SAME_BAND[chosen],
    LIGHTER[chosen],
    'personal-os',
    ...FALLBACK_ORDER,
  ];
  const picked: FrameworkId[] = [];
  for (const id of order) {
    if (id === undefined || id === chosen || picked.includes(id)) continue;
    if (availableTemplate(id, templates) === undefined) continue;
    picked.push(id);
    if (picked.length === 2) break;
  }
  for (const template of templates) {
    if (picked.length === 2) break;
    if (template.id !== chosen && !picked.includes(template.id)) picked.push(template.id);
  }
  const rule = baseLine.split(':')[0] ?? '';
  return picked.map((id) => ({
    templateId: id,
    whyNot: `${id}: ${WHY_NOT[id] ?? availableTemplate(id, templates)?.summary ?? id}; ${rule} chose ${chosen} for these answers`,
  }));
}

/**
 * Recommends one framework per workstream (01 §6). `today` is the commit date in the
 * workspace time zone, "YYYY-MM-DD". Throws FrameworkError E_USAGE, naming the JSON pointer,
 * for a profile that is not a valid OnboardingProfile.
 */
export function recommend(
  profile: OnboardingProfile,
  today: string,
  options: RecommendOptions = {},
): FrameworkRecommendation[] {
  const answers = checkProfile(profile, today);
  const templates = options.templates ?? builtTemplates;
  const byKey = new Map(answers.workstreams.map((workstream) => [workstream.key, workstream]));

  const drafts: Draft[] = answers.workstreams.map((workstream) => {
    const base = baseRule(workstream, today, byKey);
    const warnings: { code: string; text: string }[] = [];
    let template = availableTemplate(base.selected, templates);
    if (template === undefined) {
      const closest = CLOSEST[base.selected] ?? 'personal-os';
      template =
        availableTemplate(closest, templates) ?? availableTemplate('personal-os', templates);
      if (template === undefined) {
        throw usage(`no built template can stand in for ${base.selected}`, '/workstreams');
      }
      warnings.push({
        code: 'W-NOT-BUILT',
        text: `${base.rule} selected ${base.selected}, which is not built in this release; using ${template.id}, the closest built template.`,
      });
    }

    const firedRules = [base.rule];
    const rationale = [base.line];
    const packIds: PackId[] = [...template.defaultPacks];
    const addPack = (id: PackId) => {
      if (!packIds.includes(id)) packIds.push(id);
    };
    let goalModel = template.backbone.goalModel;
    const l = Math.max(1, workstream.leadershipGroupSize);

    // M1
    if (
      (template.id === 'eos' || template.id === 'scaling-up') &&
      workstream.hasTeamsUnderLeads &&
      (workstream.businessType === 'product' || workstream.existingFramework === 'okr')
    ) {
      goalModel = 'okr';
      firedRules.push('M1');
      rationale.push(
        `M1: teams under leads in a ${workstream.businessType === 'product' ? 'product business' : 'company already on OKRs'} → OKRs per team under the ${template.id} backbone`,
      );
    }
    // M2
    const mode: FrameworkMode = l <= 1 ? 'solo' : 'team';
    if (mode === 'solo') {
      firedRules.push('M2');
      rationale.push(`M2: a leadership group of ${l} → solo mode`);
    }
    // M3
    const other = workstream.principal.kind === 'other';
    const sensitive = other || workstream.confidentiality === 'sensitive';
    if (sensitive) {
      firedRules.push('M3');
      rationale.push(
        `M3: ${other ? "another person's outcome" : 'a confidential workstream'} → privacy sensitive, AI sees people redacted, and outward steps on the principal's behalf need a recorded consent`,
      );
    }
    // M4
    if (base.rule === 'R2') {
      const pack =
        workstream.roleType === 'fractional' ? 'pack.job-search-fractional' : 'pack.job-search';
      addPack(pack);
      firedRules.push('M4');
      rationale.push(
        `M4: a ${workstream.roleType === 'fractional' ? 'fractional ' : ''}job search → ${pack}`,
      );
    }
    // M5
    if (
      workstream.kind === 'company' &&
      (workstream.businessType === 'services' ||
        workstream.businessType === 'mixed_services_product')
    ) {
      addPack('pack.client-services');
      firedRules.push('M5');
      rationale.push('M5: a company that sells services → pack.client-services');
    }
    // M6
    if (
      workstream.kind === 'company' &&
      (workstream.businessType === 'product' ||
        workstream.businessType === 'mixed_services_product')
    ) {
      addPack('pack.product');
      firedRules.push('M6');
      rationale.push('M6: a company that builds a product → pack.product');
    }
    // M7
    const marketingTools = answers.tools
      .filter(
        (tool) =>
          tool.workstreamKeys.includes(workstream.key) && MARKETING_CATEGORIES.has(tool.category),
      )
      .map((tool) => `${tool.toolName} (${tool.category})`);
    if (marketingTools.length > 0) {
      addPack('pack.marketing');
      firedRules.push('M7');
      rationale.push(`M7: uses ${[...new Set(marketingTools)].join(', ')} → pack.marketing`);
    }
    return {
      workstream,
      base,
      template,
      mode,
      firedRules,
      rationale,
      warnings,
      packIds,
      goalModel,
      sensitive,
    };
  });

  // M8: eos-lite solo workstreams of the same steward (the user, in single-user CC) merge.
  const mergeable = drafts.filter(
    (draft) =>
      draft.base.rule !== 'R5' && draft.template.id === 'eos-lite' && draft.mode === 'solo',
  );
  return drafts.map((draft): FrameworkRecommendation => {
    let mergeGroup: string | undefined;
    if (mergeable.length > 1 && mergeable.includes(draft)) {
      mergeGroup = 'weekly-ceo-review';
      const others = mergeable
        .filter((other) => other !== draft)
        .map((other) => other.workstream.key);
      draft.firedRules.push('M8');
      draft.rationale.push(
        `M8: eos-lite in solo mode, as ${others.join(', ')} → one merged weekly meeting (mergeGroup weekly-ceo-review)`,
      );
    }
    const templateId = draft.template.id;
    return {
      workstreamKey: draft.workstream.key,
      templateId,
      mode: draft.mode,
      goalModel: draft.goalModel,
      packIds: draft.packIds,
      firedRules: draft.firedRules,
      rationale: draft.rationale,
      alternatives: alternatives(templateId, draft.base.line, templates),
      warnings: draft.warnings,
      parameterDefaults:
        draft.base.rule === 'R5' ? {} : defaultParameters(draft.template, draft.mode),
      ...(mergeGroup !== undefined ? { mergeGroup } : {}),
      privacy: draft.sensitive ? 'sensitive' : 'normal',
      aiDataPolicy: draft.sensitive ? 'redact_people' : 'allow',
      recommenderVersion: RECOMMENDER_VERSION,
    };
  });
}
