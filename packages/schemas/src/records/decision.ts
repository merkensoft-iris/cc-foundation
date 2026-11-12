/** The Decision record, docs/design/03-decisions-and-action-items.md §5.5 and §10. */
import { z } from 'zod';

import { ItemSource } from './action-item.js';
import {
  ActionItemId,
  Actor,
  auditShape,
  DecisionId,
  humanRef,
  LocalDate,
  PersonId,
  Sha256,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';

export const DecisionStatus = z.enum([
  'proposed',
  'open',
  'decided',
  'superseded',
  'reversed',
  'dropped',
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const Decision = z
  .strictObject({
    id: DecisionId,
    ref: humanRef('D'),
    workstreamId: WorkstreamId,
    /** Phrased as a question. */
    question: z.string().min(1),
    /** Exactly one, always a person (INV-03-02). */
    deciderId: PersonId,
    /** Recommends and drives. */
    driverId: PersonId.optional(),
    /** Voice, no veto. */
    inputFromIds: z.array(PersonId),
    informIds: z.array(PersonId),
    reversibility: z.enum(['two_way', 'one_way']),
    dueBy: LocalDate.optional(),
    options: z.array(
      z.strictObject({ id: z.string().min(1), text: z.string().min(1), proposedBy: Actor }),
    ),
    /** Agents may recommend. */
    recommendation: z
      .strictObject({ optionId: z.string().min(1), rationale: z.string().min(1), by: Actor })
      .optional(),
    outcome: z
      .strictObject({
        optionId: z.string().min(1).optional(),
        text: z.string().min(1),
        why: z.string().min(1),
        decidedAt: UtcTimestamp,
        resourcesCommitted: z.string().optional(),
      })
      .optional(),
    actionItemIds: z.array(ActionItemId),
    reviewOn: z
      .strictObject({ date: LocalDate.optional(), trigger: z.string().min(1).optional() })
      .optional(),
    supersedesId: DecisionId.optional(),
    /** One- or two-page memo for one-way doors (blob store). */
    memoSha256: Sha256.optional(),
    source: ItemSource,
    status: DecisionStatus,
    /** Required for dropped (03 §10 rule 1), enforced in the domain. */
    dropReason: z.string().min(1).optional(),
    ...auditShape,
  })
  .describe('Decision (03 §5.5): a question, its one decider, options and outcome');
export type Decision = z.infer<typeof Decision>;
