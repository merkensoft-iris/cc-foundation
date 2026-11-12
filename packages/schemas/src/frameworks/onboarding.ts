/**
 * The onboarding answers, docs/design/01-onboarding-and-frameworks.md §4: one versioned
 * `OnboardingProfile` that S1 to S9 fill (§3) and that `recommend()` reads (§6). A
 * `profile.json` for `cc-axi onboarding apply --file` is a whole `OnboardingProfile` (C-01-07).
 */
import { z } from 'zod';

import { GoalKind } from '../records/goal.js';
import { Measure } from '../records/measure.js';
import { ConnectorBindingId, IanaTimeZone, LocalDate, LocalTime } from '../records/common.js';
import { RRuleText } from '../records/rrule.js';
import {
  AcceptedFramework,
  AiDataPolicy,
  FrameworkRecommendation,
  ToolCategory,
  Weekday,
} from './framework.js';

export const OnboardingStep = z.enum([
  'workspace',
  'workstreams',
  'profiles',
  'recommendation',
  'tailoring',
  'rhythm',
  'tools',
  'ai',
  'commit',
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

const TimeRange = z.strictObject({ start: LocalTime, end: LocalTime });

/** A time window that rhythm scheduling must respect. Owned by 01; used by 02. */
export const ProtectedBlock = z
  .strictObject({
    id: z.string().min(1),
    /** Shown in the UI; never sent to calendar events. */
    label: z.string().min(1),
    /** RFC 5545 RRULE of the ADR 0001 subset (decision 4), local to timeZone. */
    rrule: RRuleText,
    timeZone: IanaTimeZone,
    durationMinutes: z.int().min(1),
    /** hard: never schedule; soft: warn and require confirmation. */
    policy: z.enum(['hard', 'soft']),
  })
  .describe('ProtectedBlock (01 §4): a time window nothing may be booked into');
export type ProtectedBlock = z.infer<typeof ProtectedBlock>;

/** 04 §9.1. */
export const BackupDestination = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('folder'), label: z.string().min(1), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('google_drive'),
    label: z.string().min(1),
    bindingId: ConnectorBindingId,
    folderName: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('s3'),
    label: z.string().min(1),
    bindingId: ConnectorBindingId,
    bucket: z.string().min(1),
    prefix: z.string(),
    region: z.string().min(1),
  }),
]);
export type BackupDestination = z.infer<typeof BackupDestination>;

export const WorkspaceAnswers = z.strictObject({
  /** e.g. "Main". */
  displayName: z.string().min(1),
  timeZone: IanaTimeZone,
  workweek: z.array(Weekday).min(1),
  workingHours: z.array(TimeRange).min(1),
  protectedBlocks: z.array(ProtectedBlock),
  /** Budget for all meetings and reviews. */
  weeklyManagementMinutes: z.int().min(0),
  quietHours: z.array(TimeRange),
  /** 04 §9.1; the passphrase itself is never stored. */
  backup: z
    .strictObject({ destination: BackupDestination.optional(), passphraseSet: z.boolean() })
    .optional(),
});
export type WorkspaceAnswers = z.infer<typeof WorkspaceAnswers>;

/** The kinds offered at S2; the Workspace pseudo-workstream (`workspace`) is never one. */
export const OnboardingWorkstreamKind = z.enum([
  'company',
  'business_unit',
  'client_engagement',
  'project',
  'job_search',
  'personal',
  'other',
]);
export type OnboardingWorkstreamKind = z.infer<typeof OnboardingWorkstreamKind>;

export const WorkstreamKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe('Workstream slug, unique in the profile');

export const WorkstreamAnswers = z.strictObject({
  /** e.g. "alderwick". */
  key: WorkstreamKey,
  kind: OnboardingWorkstreamKind,
  name: z.string().min(1),
  /** client_engagement or project under a company. */
  parentKey: WorkstreamKey.optional(),
  principal: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('self') }),
    z.strictObject({
      kind: z.literal('other'),
      displayName: z.string().min(1),
      relationship: z.string().min(1),
      timeZone: IanaTimeZone,
      consentNote: z.string().min(1),
    }),
  ]),
  /** Default: principal.timeZone for another person, else the workspace's. */
  timeZone: IanaTimeZone.optional(),
  /** People doing the work, including the user. */
  headcount: z.int().min(1),
  /** People who would attend a weekly leadership meeting. */
  leadershipGroupSize: z.int().min(1),
  hasTeamsUnderLeads: z.boolean(),
  stage: z.enum(['idea', 'pre_revenue', 'early_revenue', 'growth', 'mature', 'n_a']),
  businessType: z.enum([
    'services',
    'product',
    'ecommerce',
    'mixed_services_product',
    'nonprofit',
    'n_a',
  ]),
  primaryGoal: z.enum([
    'launch',
    'grow_revenue',
    'profitability',
    'stabilise',
    'land_role',
    'habit',
    'other',
  ]),
  goalShape: z.enum(['one_dominant_outcome', 'few_priorities', 'many_streams']),
  /** For one dominant outcome. */
  deadline: LocalDate.nullable().optional(),
  /** job_search only. */
  roleType: z.enum(['full_time', 'fractional', 'contract', 'any']).optional(),
  /** job_search only. */
  targetRoles: z.array(z.string().min(1)).optional(),
  existingFramework: z.enum(['none', 'eos', 'okr', '4dx', 'scaling_up', 'other']),
  keepExisting: z.boolean().optional(),
  weightPreference: z.enum(['light', 'standard', 'full']),
  confidentiality: z.enum(['normal', 'sensitive']),
  /** Free text; AI may suggest values from it. */
  notes: z.string().optional(),
});
export type WorkstreamAnswers = z.infer<typeof WorkstreamAnswers>;

export const ToolAnswer = z.strictObject({
  workstreamKeys: z.array(WorkstreamKey).min(1),
  category: ToolCategory,
  /** As the user names it, e.g. "Hostinger". */
  toolName: z.string().min(1),
  /** e.g. "alderwick mailbox". */
  accountLabel: z.string().min(1).optional(),
  choice: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('connector'), connectorId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('manual') }),
    z.strictObject({ kind: z.literal('discover') }),
    z.strictObject({ kind: z.literal('later') }),
  ]),
});
export type ToolAnswer = z.infer<typeof ToolAnswer>;

/** S5 answers (§8), one per workstream with its own framework instance. */
export const TailoringAnswers = z.strictObject({
  workstreamKey: WorkstreamKey,
  /** Q-T01, Q-T05: ParameterSpec keys of the accepted template; checked against bounds (C-01-04). */
  parameters: z.record(z.string(), z.unknown()),
  /** Q-T02: keep the merge group of M8; default true. */
  merge: z.boolean().optional(),
  /** Q-T03; the fields of Measure (03 §5.4). */
  measures: z.array(
    z.strictObject({
      ref: z
        .string()
        .regex(/^K-\d{4,}$/)
        .optional(),
      name: z.string().min(1),
      role: z.enum(['lead', 'lag']),
      unit: Measure.shape.unit,
      currency: Measure.shape.currency,
      cadence: Measure.shape.cadence,
      /** No target: "per plan", set later. */
      target: Measure.shape.target.optional(),
      ownerRole: z.string().min(1),
      /** Connector sources are set once a binding exists. */
      source: z.enum(['manual', 'derived']),
      /** A line shared across a merged review, e.g. K-0006. */
      workstreamKeys: z.array(WorkstreamKey).optional(),
    }),
  ),
  /** Q-T04, created as drafts. */
  goals: z.array(
    z.strictObject({
      title: z.string().min(1),
      kind: GoalKind,
      ownerRole: z.string().min(1),
      doneMeans: z.string().optional(),
      /** by null: "confirm with" the principal. */
      target: z
        .strictObject({
          from: z.number(),
          to: z.number(),
          unit: z.string().min(1),
          by: LocalDate.nullable(),
        })
        .optional(),
    }),
  ),
  /** Q-T06: area to role token; solo: { "*": "self" }. */
  owners: z.record(z.string(), z.string().min(1)),
  /** Q-T07 (03 §9.4). */
  verification: z.strictObject({
    policy: z.enum(['require_review', 'auto_close_on_checks']),
    autoCloseOn: z.array(z.enum(['calendar_event', 'measure_threshold'])),
  }),
  /** Q-T08 (02 §7.2), bounds of §8. */
  escalation: z.strictObject({
    e2CarryCount: z.int().min(1).max(3),
    e3CarryCount: z.int().min(3).max(6),
    e3OverdueDays: z.int().min(14).max(60),
  }),
  /** Q-T09. */
  aiDataPolicy: AiDataPolicy,
  /** Q-T10; path null: to be written. */
  groundingRefs: z
    .array(
      z.strictObject({
        kind: z.enum(['profile', 'rubric', 'writing_style', 'master_resume']),
        path: z.string().min(1).nullable(),
      }),
    )
    .optional(),
  /** Q-T11. */
  informRoles: z.array(z.string().min(1)),
});
export type TailoringAnswers = z.infer<typeof TailoringAnswers>;

/** S6 answers. */
export const RhythmAnswers = z.strictObject({
  /** Portfolio series (02 §4.5). */
  dailyStart: z.boolean(),
  dailyShutdown: z.boolean(),
  acceptedOverlaps: z.array(
    z.strictObject({
      workstreamKey: WorkstreamKey,
      meetingKey: z.string().min(1),
      blockId: z.string().min(1).optional(),
      reason: z.enum(['soft_block', 'outside_working_hours']),
    }),
  ),
  /** Only when T1 fires (§6.4). */
  timeBudgetFix: z.enum(['merge', 'shorten', 'biweekly', 'raise_budget']).optional(),
});
export type RhythmAnswers = z.infer<typeof RhythmAnswers>;

export const AiTaskType = z.enum([
  'draft',
  'extract',
  'plan',
  'review',
  'summarize',
  'discover',
  'tailor',
]);

/** An installed adapter ID (04 §6.2), or 'none': no AI steps run. */
const AiProviderAnswer = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const AiAnswers = z.strictObject({
  provider: AiProviderAnswer,
  /** A provider with no adapter: queue a draft request (06 §3). */
  discover: z.strictObject({ providerName: z.string().min(1) }).optional(),
  /** See 04 §6 for defaults. */
  model: z.string().min(1).optional(),
  perTask: z
    .partialRecord(
      AiTaskType,
      z.strictObject({
        provider: AiProviderAnswer,
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
      }),
    )
    .optional(),
  dailyBudgetUsd: z.number().min(0).optional(),
});
export type AiAnswers = z.infer<typeof AiAnswers>;

export const OnboardingProfile = z
  .strictObject({
    /** Incremented on every committed change. */
    version: z.int().min(1),
    completedSteps: z.array(OnboardingStep),
    workspace: WorkspaceAnswers,
    workstreams: z.array(WorkstreamAnswers),
    tools: z.array(ToolAnswer),
    ai: AiAnswers,
    /** S5 answers. */
    tailoring: z.array(TailoringAnswers).optional(),
    /** S6 answers. */
    rhythm: RhythmAnswers.optional(),
    /** Output of S4, kept for audit. */
    recommendations: z.array(FrameworkRecommendation).optional(),
    /** Output of S4 after the user's choice. */
    accepted: z.array(AcceptedFramework).optional(),
  })
  .describe('OnboardingProfile (01 §4): every onboarding answer, versioned');
export type OnboardingProfile = z.infer<typeof OnboardingProfile>;
