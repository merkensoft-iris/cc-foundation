/**
 * Framework templates, packs, recommendations and accepted frameworks,
 * docs/design/01-onboarding-and-frameworks.md §4. Templates and packs are YAML files in
 * packages/frameworks/templates/ and packs/; `pnpm cc:gen` writes the JSON Schemas of these
 * types to packages/schemas/frameworks/ and validates the YAML files against them.
 *
 * P1-06 added to §4 what the prose and contracts of 01 need: `ParameterSpec.defaultByMode` and
 * `BackboneMeeting.durationMinutes.defaultByMode` (mode-dependent defaults, §5.3),
 * `FrameworkTemplate.forkedFrom` (so a fork's instances show "custom (based on eos-lite
 * 1.0.0)", §9), `FrameworkRecommendation.recommenderVersion` (C-01-02), and `PackId` as the
 * pattern pack.<name>, since engines add custom packs (08).
 */
import { z } from 'zod';

import { ActionTemplate } from '../records/template.js';
import { IanaTimeZone, UtcTimestamp } from '../records/common.js';
import { WorkstreamKind } from '../records/workstream.js';

/** The templates of 01 §5, built or not. */
export const CATALOGUE_TEMPLATE_IDS = [
  'personal-os',
  '4dx',
  'eos-lite',
  'eos',
  'okr',
  'scaling-up',
] as const;
export type CatalogueTemplateId = (typeof CATALOGUE_TEMPLATE_IDS)[number];

/** A fork's name after `custom:`, e.g. "ald-weekly". */
export const CUSTOM_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const FrameworkId = z
  .union([
    z.enum(CATALOGUE_TEMPLATE_IDS),
    z.string().regex(/^custom:[a-z0-9][a-z0-9-]*$/) as z.ZodType<`custom:${string}`>,
  ])
  .describe('A framework template ID (01 §4): a catalogue template or custom:<name>');
export type FrameworkId = z.infer<typeof FrameworkId>;

export const GoalModel = z.enum(['personal_goals', 'wig', 'rocks', 'okr', 'priorities']);
export type GoalModel = z.infer<typeof GoalModel>;

export const Cadence = z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);
export type Cadence = z.infer<typeof Cadence>;

export const Weekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type Weekday = z.infer<typeof Weekday>;

export const FrameworkMode = z.enum(['solo', 'team']);
export type FrameworkMode = z.infer<typeof FrameworkMode>;

/** The six packs of v1 (01 §5.5). */
export const V1_PACK_IDS = [
  'pack.marketing',
  'pack.client-services',
  'pack.product',
  'pack.job-search',
  'pack.job-search-fractional',
  'pack.personal',
] as const;

export const PackId = z
  .string()
  .regex(/^pack\.[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe('A pack ID such as pack.marketing (01 §5.5)');
export type PackId = z.infer<typeof PackId>;

export const ToolCategory = z.enum([
  'calendar',
  'email',
  'chat',
  'social',
  'social_scheduler',
  'cms',
  'crm',
  'hosting',
  'code',
  'docs',
  'time_tracking',
  'analytics',
  'job_board',
  'accounting',
  'task_tracker',
  'other',
]);
export type ToolCategory = z.infer<typeof ToolCategory>;

/** Semantic version, which instances pin. */
export const SemVer = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)
  .describe('Semantic version MAJOR.MINOR.PATCH');

const modeDefaults = <T extends z.ZodType>(value: T) =>
  z.strictObject({ solo: value.optional(), team: value.optional() });

export const BackboneMeeting = z
  .strictObject({
    /** e.g. "weekly". */
    key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    cadence: Cadence,
    /** An agenda template of 02 §5, e.g. "agenda.eos-lite.weekly@1". */
    agendaTemplateId: z.string().regex(/^agenda\.[a-z0-9.-]+@\d+$/),
    required: z.boolean(),
    /** Modes in which this meeting exists. */
    modes: z.array(FrameworkMode).min(1),
    durationMinutes: z.strictObject({
      min: z.int().min(1),
      default: z.int().min(1),
      max: z.int().min(1),
      /** A mode whose default differs, e.g. the eos-lite yearly review: solo 240 (01 §5.3). */
      defaultByMode: modeDefaults(z.int().min(1)).optional(),
    }),
  })
  .describe('BackboneMeeting (01 §4): a meeting the framework requires or offers');
export type BackboneMeeting = z.infer<typeof BackboneMeeting>;

export const Invariant = z
  .strictObject({
    /** e.g. "E-3". */
    id: z.string().regex(/^[A-Z]{1,3}-\d+$/),
    /** The human-readable rule. */
    text: z.string().min(1),
    /** Name of a function in packages/frameworks/validators. */
    validator: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    appliesWhen: z.strictObject({ mode: FrameworkMode.optional() }).optional(),
  })
  .describe('Invariant (01 §4): a machine-checked backbone rule');
export type Invariant = z.infer<typeof Invariant>;

export const ParameterType = z.enum([
  'int',
  'duration_minutes',
  'weekday',
  'time_of_day',
  'enum',
  'bool',
  'string',
]);
export type ParameterType = z.infer<typeof ParameterType>;

export const ParameterSpec = z
  .strictObject({
    /** e.g. "weekly.weekday". */
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/),
    type: ParameterType,
    default: z.unknown(),
    /** A mode whose default differs, e.g. eos-lite `conclude.rating` (01 §5.3). */
    defaultByMode: modeDefaults(z.unknown()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    enum: z.array(z.string().min(1)).min(1).optional(),
    description: z.string().min(1),
  })
  .describe('ParameterSpec (01 §4): a bounded, user-set parameter');
export type ParameterSpec = z.infer<typeof ParameterSpec>;

export const VocabularyKey = z.enum(['goal', 'action', 'issue', 'measure', 'meeting']);
export type VocabularyKey = z.infer<typeof VocabularyKey>;

export const Vocabulary = z.strictObject({
  goal: z.string().min(1),
  action: z.string().min(1),
  issue: z.string().min(1),
  measure: z.string().min(1),
  meeting: z.string().min(1),
});
export type Vocabulary = z.infer<typeof Vocabulary>;

/** The template a `custom:` template, or an instance of one, was forked from (01 §9 level 5). */
export const ForkedFrom = z.strictObject({ templateId: FrameworkId, version: SemVer });
export type ForkedFrom = z.infer<typeof ForkedFrom>;

export const FrameworkTemplate = z
  .strictObject({
    id: FrameworkId,
    /** Instances pin it. */
    version: SemVer,
    name: z.string().min(1),
    summary: z.string().min(1),
    appliesTo: z.array(WorkstreamKind).min(1),
    /** Where the backbone comes from. */
    sources: z.array(z.strictObject({ label: z.string().min(1), ref: z.string().min(1) })).min(1),
    backbone: z.strictObject({
      goalModel: GoalModel,
      meetings: z.array(BackboneMeeting).min(1),
      invariants: z.array(Invariant),
    }),
    parameters: z.array(ParameterSpec),
    /** Agenda positions where packs may add sections, e.g. "weekly:after:headlines". */
    extensionSlots: z.array(z.string().min(1)),
    defaultPacks: z.array(PackId),
    vocabulary: Vocabulary,
    /** Set on custom:* only. */
    forkedFrom: ForkedFrom.optional(),
  })
  .describe('FrameworkTemplate (01 §4): a fixed backbone plus bounded parameters');
export type FrameworkTemplate = z.infer<typeof FrameworkTemplate>;

const MeasureUnit = z.enum(['count', 'percent', 'currency', 'hours', 'boolean', 'days']);

export const Pack = z
  .strictObject({
    id: PackId,
    version: SemVer,
    title: z.string().min(1),
    measureTemplates: z.array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
        name: z.string().min(1),
        unit: MeasureUnit,
        role: z.enum(['lead', 'lag']),
        cadence: Cadence,
        defaultTarget: z
          .strictObject({ op: z.enum(['gte', 'lte', 'eq']), value: z.number() })
          .optional(),
      }),
    ),
    /** Added into extension slots (02). */
    agendaSections: z.array(
      z.strictObject({ slot: z.string().min(1), sectionTemplateId: z.string().min(1) }),
    ),
    /** 03 §8.4. */
    actionTemplates: z.array(ActionTemplate),
    recurringItems: z.array(
      z.strictObject({
        templateId: z.string().min(1),
        rrule: z.string().min(1),
        timeZone: IanaTimeZone.optional(),
      }),
    ),
    connectorSuggestions: z.array(
      z.strictObject({ category: ToolCategory, connectorIds: z.array(z.string().min(1)) }),
    ),
    /** e.g. the job-search trust rules (02 §5.5); also pipeline stages (01 §4). */
    rules: z.array(z.string().min(1)),
  })
  .describe('Pack (01 §4, §5.5): domain content added to a framework instance');
export type Pack = z.infer<typeof Pack>;

export const AiDataPolicy = z.enum(['allow', 'redact_people', 'deny']);
export type AiDataPolicy = z.infer<typeof AiDataPolicy>;

export const FrameworkRecommendation = z
  .strictObject({
    workstreamKey: z.string().min(1),
    templateId: FrameworkId,
    mode: FrameworkMode,
    goalModel: GoalModel,
    packIds: z.array(PackId),
    /** e.g. ["R8", "M2", "M5", "M6", "M7", "M8"]. */
    firedRules: z.array(z.string().regex(/^[RMT]\d+$/)).min(1),
    /** One line per fired rule, generated from the rule text. */
    rationale: z.array(z.string().min(1)).min(1),
    alternatives: z
      .array(z.strictObject({ templateId: FrameworkId, whyNot: z.string().min(1) }))
      .length(2),
    warnings: z.array(z.strictObject({ code: z.string().regex(/^W-[A-Z-]+$/), text: z.string() })),
    parameterDefaults: z.record(z.string(), z.unknown()),
    /** See M8 and 02 §4.4. */
    mergeGroup: z.string().min(1).optional(),
    privacy: z.enum(['normal', 'sensitive']),
    aiDataPolicy: AiDataPolicy,
    /** The version of the rule tables that produced this recommendation (C-01-02). */
    recommenderVersion: SemVer,
  })
  .describe('FrameworkRecommendation (01 §4, §6.5): the recommender output for one workstream');
export type FrameworkRecommendation = z.infer<typeof FrameworkRecommendation>;

export const AcceptedFramework = z
  .strictObject({
    workstreamKey: z.string().min(1),
    /** Recommended, or an alternative the user chose. */
    templateId: FrameworkId,
    acceptedAt: UtcTimestamp,
    overrodeRecommendation: z.boolean(),
  })
  .describe('AcceptedFramework (01 §4): the S4 choice for one workstream');
export type AcceptedFramework = z.infer<typeof AcceptedFramework>;
