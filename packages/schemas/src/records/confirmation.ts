/**
 * The confirmation request of docs/design/04-platform.md §7.3, and the risk classes of §7.1.
 *
 * P1-13 adds the type so that `confirmations.get` and `confirmations.wait` (the
 * `cc_confirmation_status` MCP tool, 07 §7) have a result schema. Nothing creates a
 * confirmation in phase 1: they come from connector actions and calendar writes, with the
 * Policy Engine of P2-01. The store keeps the `confirmations` table in its unspecified
 * envelope until then, so the type is not in the record registry yet (P2-01 adds it there,
 * with the table's migration).
 */
import { z } from 'zod';

import {
  ActionItemId,
  Actor,
  ConnectorBindingId,
  id,
  MeetingSeriesId,
  RunId,
  UtcTimestamp,
} from './common.js';

export const ConfirmationId = id('cfm');
export type ConfirmationId = z.infer<typeof ConfirmationId>;

/** 04 §7.1. */
export const RiskClass = z.enum([
  'read',
  'write_internal',
  'write_external_draft',
  'write_external',
  'send_publish',
  'destructive',
  'credential',
  'financial',
]);
export type RiskClass = z.infer<typeof RiskClass>;

export const ConfirmationStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'consumed']);
export type ConfirmationStatus = z.infer<typeof ConfirmationStatus>;

export const ConfirmationRequest = z.strictObject({
  id: ConfirmationId,
  createdAt: UtcTimestamp,
  /** Default 24 h; for scheduled content, the scheduled time. */
  expiresAt: UtcTimestamp,
  requestedBy: Actor,
  subject: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('connector_action'),
      bindingId: ConnectorBindingId,
      action: z.string().min(1),
      risk: RiskClass,
    }),
    z.strictObject({
      kind: z.literal('discovery_step'),
      runId: RunId,
      description: z.string().min(1),
      risk: RiskClass,
    }),
    z.strictObject({
      kind: z.literal('calendar_batch'),
      seriesIds: z.array(MeetingSeriesId),
      eventCount: z.int().min(0),
      calendarId: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('session_create'), service: z.string().min(1) }),
  ]),
  actionItemId: ActionItemId.optional(),
  /** The exact human-readable preview: full text, recipients, URLs, counts. */
  payloadPreview: z.string(),
  /** sha256 of the canonical JSON payload. */
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: ConfirmationStatus,
  decidedAt: UtcTimestamp.optional(),
  decisionNote: z.string().optional(),
});
export type ConfirmationRequest = z.infer<typeof ConfirmationRequest>;
