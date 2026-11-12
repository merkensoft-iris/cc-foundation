/**
 * Agenda templates, docs/design/02-rhythm-and-calendar.md §3 and §5 (added by P1-08): the
 * ordered sections of a meeting, each with its timebox, the typed input queries its pre-read
 * resolves (02 §6.1) and the outputs it may capture (02 §6.3).
 *
 * Beyond the 02 §3 fields, a section carries `variants`: the timeboxes of 02 §5.1's other
 * columns. `timeboxMinutes` is the solo, single-workstream default; `variants.team` is the team
 * column and `variants.soloMerged` the solo column of a merged meeting of two workstreams (per
 * workstream for a `perWorkstream` section). Composition picks the column by the series' mode
 * and workstream count, then fits the result to the duration (02 §4.4 rule 4). Every column
 * keeps `minMinutes` ≤ timebox ≤ `maxMinutes` (owner decision, key p1-08-agenda-data).
 */
import { z } from 'zod';

import { ConnectorBindingId, PersonId, WorkstreamId } from '../records/common.js';
import { DecisionStatus } from '../records/decision.js';
import { Lifecycle } from '../records/action-item.js';

export const AgendaSectionType = z.enum([
  'attention',
  'check_in',
  'scorecard',
  'goals_review',
  'action_review',
  'headlines',
  'issues',
  'decision_queue',
  'plan_commitments',
  'pipeline_review',
  'content_review',
  'money_ops',
  'register_health',
  'risk_review',
  'rhythm_health',
  'top_three',
  'day_close',
  'planning',
  'retrospective',
  'conclude',
]);
export type AgendaSectionType = z.infer<typeof AgendaSectionType>;

export const OutputKind = z.enum([
  'decision',
  'action_item',
  'issue',
  'risk',
  'measure_value',
  'goal',
  'goal_grade',
  'status_update',
  'verification',
  'note',
]);
export type OutputKind = z.infer<typeof OutputKind>;

/** 02 §3: a time relative to the instance being prepared. */
export const RelativeTime = z
  .string()
  .regex(
    /^(?:instance\.start|instance\.end|previous_instance\.end|next_instance\.start|instance\.start[+-][0-9]+d)$/,
  )
  .describe('Relative time resolved against the instance being prepared (02 §3)');
export type RelativeTime = z.infer<typeof RelativeTime>;

/** 'meeting': the series' workstreams. */
export const WorkstreamScope = z.union([z.literal('meeting'), z.array(WorkstreamId).min(1)]);
export type WorkstreamScope = z.infer<typeof WorkstreamScope>;

const queryId = z.string().min(1);

/** 02 §3: one typed input of a section, resolved at pre-read time (02 §6.1). */
export const InputQuery = z.discriminatedUnion('source', [
  z.strictObject({
    id: queryId,
    source: z.literal('action_items'),
    filter: z.strictObject({
      scope: WorkstreamScope,
      lifecycle: z.array(Lifecycle).optional(),
      dueBefore: RelativeTime.optional(),
      claimedSince: RelativeTime.optional(),
      escalationAtLeast: z.int().min(0).max(4).optional(),
      ownerIds: z.array(PersonId).optional(),
      sourceMeetingSeries: z.boolean().optional(),
    }),
    limit: z.int().min(1).optional(),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('measures'),
    filter: z.strictObject({ scope: WorkstreamScope, role: z.enum(['lead', 'lag']).optional() }),
    periods: z.int().min(1),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('goals'),
    filter: z.strictObject({
      scope: WorkstreamScope,
      period: z.enum(['current', 'previous', 'next']),
    }),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('decisions'),
    filter: z.strictObject({
      scope: WorkstreamScope,
      status: z.array(DecisionStatus).min(1),
      dueBefore: RelativeTime.optional(),
    }),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('issues'),
    filter: z.strictObject({ scope: WorkstreamScope, status: z.array(z.literal('open')).min(1) }),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('risks'),
    filter: z.strictObject({
      scope: WorkstreamScope,
      status: z.array(z.enum(['watching', 'triggered'])).min(1),
    }),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('register_health'),
    filter: z.strictObject({ scope: WorkstreamScope, window: z.enum(['month', 'quarter']) }),
  }),
  z.strictObject({
    id: queryId,
    source: z.literal('rhythm_health'),
    filter: z.strictObject({ window: z.enum(['month', 'quarter']) }),
  }),
  z.strictObject({ id: queryId, source: z.literal('attention') }),
  z.strictObject({
    id: queryId,
    source: z.literal('connector'),
    /** Absent in a template: the pack or engine names the binding when it binds the section. */
    bindingId: ConnectorBindingId.optional(),
    /** Only actions with manifest risk `read` (05). */
    action: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
]);
export type InputQuery = z.infer<typeof InputQuery>;

export const AgendaSectionTemplate = z
  .strictObject({
    /** Unique in the agenda template, e.g. "scorecard". */
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: AgendaSectionType,
    title: z.string().min(1),
    /** Solo mode, one workstream (02 §5.1 "Solo, single workstream"). */
    timeboxMinutes: z.int().min(1),
    /** The other columns of 02 §5.1, where they differ. */
    variants: z
      .strictObject({
        team: z.int().min(1).optional(),
        /** Solo, merged meeting of two workstreams; per workstream when perWorkstream. */
        soloMerged: z.int().min(1).optional(),
      })
      .optional(),
    minMinutes: z.int().min(1),
    maxMinutes: z.int().min(1),
    /** Required by the framework invariant; backbone sections cannot be removed. */
    backbone: z.boolean(),
    /** Repeated once per workstream in a merged meeting (02 §4.4). */
    perWorkstream: z.boolean(),
    inputs: z.array(InputQuery),
    allowedOutputs: z.array(OutputKind),
    /** Human-readable; enforced by the section validators of 02 §6.3. */
    rules: z.array(z.string().min(1)),
  })
  .superRefine((section, ctx) => {
    const columns = [
      section.timeboxMinutes,
      section.variants?.team,
      section.variants?.soloMerged,
    ].filter((value): value is number => value !== undefined);
    for (const value of columns) {
      if (value < section.minMinutes || value > section.maxMinutes) {
        ctx.addIssue({
          code: 'custom',
          message: `${section.id}: timebox ${String(value)} is outside ${String(section.minMinutes)}-${String(section.maxMinutes)} (02 §5)`,
        });
      }
    }
    const ids = new Set<string>();
    for (const input of section.inputs) {
      if (ids.has(input.id)) {
        ctx.addIssue({ code: 'custom', message: `${section.id}: input ${input.id} repeats` });
      }
      ids.add(input.id);
    }
  });
export type AgendaSectionTemplate = z.infer<typeof AgendaSectionTemplate>;

export const AgendaTemplate = z
  .strictObject({
    /** "agenda.eos-lite.weekly@1". */
    id: z.string().regex(/^agenda\.[a-z0-9.-]+@\d+$/),
    /** Ordered; the order of backbone sections is an invariant. */
    sections: z.array(AgendaSectionTemplate).min(1),
    /** Extension slots for packs, e.g. "after:headlines". */
    slots: z.array(z.string().regex(/^(?:before|after):[a-z][a-z0-9_]*$/)),
  })
  .superRefine((template, ctx) => {
    const ids = new Set<string>();
    for (const section of template.sections) {
      if (ids.has(section.id)) {
        ctx.addIssue({ code: 'custom', message: `section ${section.id} repeats` });
      }
      ids.add(section.id);
    }
    for (const slot of template.slots) {
      const anchor = slot.slice(slot.indexOf(':') + 1);
      if (!ids.has(anchor)) {
        ctx.addIssue({ code: 'custom', message: `slot ${slot} names no section` });
      }
    }
  })
  .describe('AgendaTemplate (02 §3, §5): the ordered sections of a meeting');
export type AgendaTemplate = z.infer<typeof AgendaTemplate>;
