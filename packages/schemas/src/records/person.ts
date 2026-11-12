/** The Person record and its consents, docs/design/03-decisions-and-action-items.md §5.1. */
import { z } from 'zod';

import { Actor, auditShape, IanaTimeZone, PersonId, UtcTimestamp } from './common.js';

/** The consent scopes 03 §5.1 names; other scopes are free text. */
export const KNOWN_CONSENT_SCOPES = [
  'track_my_search',
  'draft_on_my_behalf',
  'read_my_alert_mailbox',
  'contact_me',
] as const;

export const Consent = z
  .strictObject({
    scope: z.union([z.enum(KNOWN_CONSENT_SCOPES), z.string().min(1)]),
    grantedAt: UtcTimestamp,
    /** The user, recording what the person said. */
    recordedBy: Actor,
    /** e.g. "Asked in a WhatsApp message on 2026-11-02". */
    evidenceNote: z.string().min(1),
    revokedAt: UtcTimestamp.optional(),
  })
  .describe('What a person agreed the user may do on their behalf (03 §5.1)');
export type Consent = z.infer<typeof Consent>;

export const Person = z
  .strictObject({
    id: PersonId,
    displayName: z.string().min(1),
    /** self = the user; collaborator = a contractor or partner; external = client contact. */
    role: z.enum(['self', 'collaborator', 'external']),
    emails: z.array(z.email()),
    timeZone: IanaTimeZone.optional(),
    consents: z.array(Consent),
    ...auditShape,
  })
  .describe('Person (03 §5.1): the user or someone the user works with; never a CC user');
export type Person = z.infer<typeof Person>;
