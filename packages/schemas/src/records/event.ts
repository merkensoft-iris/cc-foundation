/** The DomainEvent record, docs/design/03-decisions-and-action-items.md §5.10. */
import { z } from 'zod';

import { Actor, EventId, HumanRef, UtcTimestamp } from './common.js';

export const DomainEvent = z
  .strictObject({
    /** ULID, so event order equals ID order. */
    id: EventId,
    at: UtcTimestamp,
    actor: Actor,
    /** "<entity>.<verb>", e.g. "action_item.claimed", "decision.decided". */
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
      .describe('<entity>.<verb>'),
    entity: z.strictObject({
      kind: z.string().min(1),
      id: z.string().min(1),
      ref: HumanRef.optional(),
    }),
    /** Changed fields only. */
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    /** Meeting instance, run, or confirmation that caused it. */
    correlationId: z.string().min(1).optional(),
  })
  .describe('DomainEvent (03 §5.10): one append-only change, written with its state change');
export type DomainEvent = z.infer<typeof DomainEvent>;
