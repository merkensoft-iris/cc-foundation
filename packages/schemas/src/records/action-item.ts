/** The ActionItem record, docs/design/03-decisions-and-action-items.md §5.7. */
import { z } from 'zod';

import {
  ActionItemId,
  Actor,
  auditShape,
  ConnectorBindingId,
  DecisionId,
  GoalId,
  Health,
  humanRef,
  IanaTimeZone,
  IssueId,
  LocalDate,
  LocalTime,
  MeasureId,
  MeetingInstanceId,
  PersonId,
  Privacy,
  RunId,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';
import { EvidenceRequirement, VerificationRecord } from './evidence.js';
import { ExecutionPlan } from './execution.js';

/** follow_up = find something out and report back. */
export const ActionKind = z.enum(['todo', 'follow_up']);
export type ActionKind = z.infer<typeof ActionKind>;

export const Lifecycle = z.enum([
  'draft',
  'open',
  'in_progress',
  'waiting',
  'claimed_done',
  'verified_done',
  'dropped',
]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const VerificationPolicy = z.enum(['require_review', 'auto_close_on_checks']);
export type VerificationPolicy = z.infer<typeof VerificationPolicy>;

export const ItemSource = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('meeting'),
      meetingId: MeetingInstanceId,
      sectionId: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('decision'), decisionId: DecisionId }),
    z.strictObject({ kind: z.literal('issue'), issueId: IssueId }),
    /** Pack recurring items; recurrenceKey such as "2026-W47". */
    z.strictObject({
      kind: z.literal('template'),
      templateId: z.string().min(1),
      recurrenceKey: z.string().min(1),
    }),
    /** Always starts as draft. */
    z.strictObject({ kind: z.literal('agent_suggestion'), runId: RunId }),
    /** Always starts as draft. */
    z.strictObject({
      kind: z.literal('ingest_rule'),
      bindingId: ConnectorBindingId,
      recordId: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('manual') }),
  ])
  .meta({ id: 'ItemSource', description: 'Where an action item or decision came from (03 §5.7)' });
export type ItemSource = z.infer<typeof ItemSource>;

export const ExternalRef = z
  .discriminatedUnion('system', [
    z.strictObject({
      system: z.literal('firstmate'),
      home: z.string().min(1),
      taskId: z.string().min(1),
    }),
    z.strictObject({ system: z.literal('github'), url: z.url() }),
    z.strictObject({
      system: z.literal('calendar'),
      bindingId: ConnectorBindingId,
      eventId: z.string().min(1),
    }),
    z.strictObject({
      system: z.literal('other'),
      label: z.string().min(1),
      url: z.url().optional(),
    }),
  ])
  .meta({ id: 'ExternalRef', description: 'A pointer to the item in another system (03 §5.7)' });
export type ExternalRef = z.infer<typeof ExternalRef>;

export const ActionItem = z
  .strictObject({
    id: ActionItemId,
    ref: humanRef('A'),
    workstreamId: WorkstreamId,
    kind: ActionKind,
    /** Verb + deliverable, at most 120 characters. Non-empty outside draft (INV-03-04). */
    title: z.string().max(120),
    /** What a stranger could check. Non-empty outside draft (INV-03-04). */
    doneMeans: z.string(),
    evidenceRequirements: z.array(EvidenceRequirement),
    verificationPolicy: VerificationPolicy,
    /** Exactly one accountable person (INV-03-01). */
    ownerId: PersonId,
    /** Who confirms; default the user. */
    reviewerId: PersonId,
    /** "Tell when done". */
    informIds: z.array(PersonId),
    due: z.strictObject({ date: LocalDate, time: LocalTime.optional(), timeZone: IanaTimeZone }),
    lifecycle: Lifecycle,
    health: Health,
    /** Required when health is not on_track (INV-03-03), enforced in the domain. */
    healthNote: z.string().optional(),
    waitingOn: z
      .strictObject({
        kind: z.enum(['person', 'confirmation', 'external_agent', 'dependency', 'date']),
        ref: z.string().min(1).optional(),
        since: UtcTimestamp,
      })
      .optional(),
    execution: ExecutionPlan,
    source: ItemSource,
    links: z.strictObject({
      goalIds: z.array(GoalId),
      measureIds: z.array(MeasureId),
      decisionIds: z.array(DecisionId),
      issueIds: z.array(IssueId),
      parentActionId: ActionItemId.optional(),
    }),
    /** See 02 §7.1. */
    carryCount: z.int().min(0),
    replannedCount: z.int().min(0),
    escalationLevel: z.int().min(0).max(4),
    claim: z.strictObject({ at: UtcTimestamp, by: Actor, note: z.string().optional() }).optional(),
    verification: VerificationRecord.optional(),
    /** Required for dropped (INV-03-05), enforced in the domain. */
    dropReason: z.string().optional(),
    closedAt: UtcTimestamp.optional(),
    closedBy: Actor.optional(),
    /** Inherits from the workstream; may only be raised. */
    privacy: Privacy,
    externalRefs: z.array(ExternalRef),
    ...auditShape,
  })
  .describe('ActionItem (03 §5.7): one commitment with one owner, a due date and evidence');
export type ActionItem = z.infer<typeof ActionItem>;
