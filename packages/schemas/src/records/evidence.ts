/**
 * Evidence, evidence requirements, verification checks and verification records,
 * docs/design/03-decisions-and-action-items.md §5.9.
 */
import { z } from 'zod';

import {
  ActionItemId,
  Actor,
  ConnectorBindingId,
  EvidenceId,
  JsonObject,
  LocalDate,
  MeasureId,
  RunId,
  Sha256,
  UtcTimestamp,
} from './common.js';

export const EvidenceKind = z.enum([
  'url',
  'file',
  'note',
  'connector_record',
  'measure_value',
  'meeting_record',
  'external_task',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** Dot path into a JSON value: `posts[0].status`, `messages.length`. */
export type Predicate =
  | {
      path: string;
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'matches' | 'exists';
      value?: unknown;
    }
  | { all: Predicate[] }
  | { any: Predicate[] };

export const Predicate: z.ZodType<Predicate> = z
  .union([
    z.strictObject({
      path: z.string().min(1),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'exists']),
      value: z.unknown().optional(),
    }),
    z.strictObject({
      get all() {
        return z.array(Predicate).min(1);
      },
    }),
    z.strictObject({
      get any() {
        return z.array(Predicate).min(1);
      },
    }),
  ])
  .meta({
    id: 'Predicate',
    description: 'A test on a JSON value: a comparison at a dot path, or all/any of predicates',
  });

export const VerificationCheck = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('connector_query'),
      bindingId: ConnectorBindingId,
      action: z.string().min(1),
      input: JsonObject,
      expect: Predicate,
      notBefore: UtcTimestamp.optional(),
      retry: z.strictObject({ attempts: z.int().min(1), intervalMinutes: z.number().positive() }),
    }),
    z.strictObject({
      type: z.literal('url_reachable'),
      url: z.url(),
      expectStatus: z.array(z.int().min(100).max(599)).min(1),
      expectText: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal('measure_threshold'),
      measureId: MeasureId,
      periodStart: LocalDate,
      expect: Predicate,
    }),
    z.strictObject({
      type: z.literal('external_task_state'),
      system: z.literal('firstmate'),
      taskId: z.string().min(1),
      expect: z.enum(['pr_ready', 'merged']),
    }),
    z.strictObject({ type: z.literal('child_items'), expect: z.literal('all_verified') }),
  ])
  .meta({
    id: 'VerificationCheck',
    description: 'A deterministic check that can pass an evidence requirement (03 §5.9)',
  });
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const EvidenceRequirement = z
  .strictObject({
    /** "er1". */
    id: z.string().min(1),
    /** "Blog post is live at a public URL". */
    description: z.string().min(1),
    required: z.boolean(),
    acceptedKinds: z.array(EvidenceKind).min(1),
    /** Deterministic and optional. */
    check: VerificationCheck.optional(),
  })
  .meta({ id: 'EvidenceRequirement', description: 'What must be shown for an item (03 §5.9)' });
export type EvidenceRequirement = z.infer<typeof EvidenceRequirement>;

export const Evidence = z
  .strictObject({
    id: EvidenceId,
    actionItemId: ActionItemId,
    requirementId: z.string().min(1).optional(),
    kind: EvidenceKind,
    /** At most 200 characters. */
    summary: z.string().min(1).max(200),
    url: z.url().optional(),
    /** Files and screenshots, content-addressed. */
    blobSha256: Sha256.optional(),
    record: z
      .strictObject({
        bindingId: ConnectorBindingId,
        recordType: z.string().min(1),
        externalId: z.string().min(1),
      })
      .optional(),
    externalTask: z
      .strictObject({
        system: z.literal('firstmate'),
        home: z.string().min(1),
        taskId: z.string().min(1),
        pr: z.string().min(1).optional(),
      })
      .optional(),
    capturedAt: UtcTimestamp,
    capturedBy: Actor,
  })
  .describe('Evidence (03 §5.9): something that shows an action item was done');
export type Evidence = z.infer<typeof Evidence>;

export const CheckResult = z
  .strictObject({
    requirementId: z.string().min(1),
    status: z.enum(['pass', 'fail', 'inconclusive', 'pending']),
    at: UtcTimestamp,
    /** e.g. "1 sent message matched". */
    detail: z.string(),
    runId: RunId.optional(),
    evidenceId: EvidenceId.optional(),
  })
  .meta({ id: 'CheckResult', description: 'The outcome of one verification check (03 §5.9)' });
export type CheckResult = z.infer<typeof CheckResult>;

export const VerificationMethod = z.enum(['auto', 'confirmed', 'attested']);
export type VerificationMethod = z.infer<typeof VerificationMethod>;

/**
 * The verification record exists from the first claim: it holds the queued and finished check
 * results while the item waits for review, and the rejected claims. `method`, `decidedBy` and
 * `decidedAt` are set together when the item is verified, and only then (INV-03-06).
 */
export const VerificationRecord = z
  .strictObject({
    /** Set at verification only. */
    method: VerificationMethod.optional(),
    checks: z.array(CheckResult),
    /** Advisory only. */
    aiReview: z
      .strictObject({
        runId: RunId,
        verdict: z.enum(['consistent', 'inconsistent', 'unclear']),
        notes: z.string(),
      })
      .optional(),
    /** system:review for auto; user for confirmed/attested (INV-03-06). Set at verification. */
    decidedBy: Actor.optional(),
    /** Set at verification only. */
    decidedAt: UtcTimestamp.optional(),
    /** Required for attested (INV-03-06), enforced in the domain. */
    attestationNote: z.string().optional(),
    rejectedClaims: z.array(
      z.strictObject({ at: UtcTimestamp, by: Actor, reason: z.string().min(1) }),
    ),
  })
  .meta({
    id: 'VerificationRecord',
    description: 'How a claimed item was verified, or why its claims were rejected (03 §5.9)',
  });
export type VerificationRecord = z.infer<typeof VerificationRecord>;
