/**
 * Shared record conventions of docs/design/03-decisions-and-action-items.md §3: IDs, human
 * references, timestamps, dates, actors, the audit fields every record carries, health and
 * privacy.
 */
import { z } from 'zod';

/**
 * `<prefix>_<ULID>`. Examples and fixtures use readable placeholders such as `ws_ald` or
 * `bnd_gmail_ald` (03 §13), so the part after the prefix may hold underscores.
 */
export function id<P extends string>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`))
    .describe(`ID with the prefix ${prefix}_ (03 §3)`) as z.ZodType<`${P}_${string}`>;
}

/** The prefixes of 03 §3, one per ID type. */
export const ID_PREFIXES = {
  workspace: 'wsp',
  person: 'per',
  workstream: 'ws',
  frameworkInstance: 'fwi',
  goal: 'goal',
  measure: 'msr',
  decision: 'dec',
  actionItem: 'act',
  issue: 'iss',
  risk: 'rsk',
  evidence: 'evd',
  meetingSeries: 'ser',
  meetingInstance: 'mtg',
  connectorBinding: 'bnd',
  run: 'run',
  agentPrincipal: 'agt',
  event: 'evt',
  secretRef: 'sec',
} as const;

export const WorkspaceId = id('wsp');
export const PersonId = id('per');
export const WorkstreamId = id('ws');
export const FrameworkInstanceId = id('fwi');
export const GoalId = id('goal');
export const MeasureId = id('msr');
export const DecisionId = id('dec');
export const ActionItemId = id('act');
export const IssueId = id('iss');
export const RiskId = id('rsk');
export const EvidenceId = id('evd');
export const MeetingSeriesId = id('ser');
export const MeetingInstanceId = id('mtg');
export const ConnectorBindingId = id('bnd');
export const RunId = id('run');
export const AgentPrincipalId = id('agt');
export const EventId = id('evt');
export const SecretRef = id('sec');

/** The HumanRef letter of each counted kind (03 §3, the Workspace counters of 03 §5.1). */
export const HUMAN_REF_KINDS = ['A', 'D', 'I', 'R', 'M', 'G', 'K'] as const;
export type HumanRefKind = (typeof HUMAN_REF_KINDS)[number];

/** A per-workspace reference such as `A-0142`; `kind` limits it to one letter. */
export function humanRef(kind?: HumanRefKind) {
  const letter = kind ?? `[${HUMAN_REF_KINDS.join('')}]`;
  return z
    .string()
    .regex(new RegExp(`^${letter}-[0-9]{4,}$`))
    .describe(
      kind === undefined
        ? 'HumanRef such as A-0142 or D-0008 (03 §3)'
        : `HumanRef ${kind}-NNNN (03 §3)`,
    );
}
export const HumanRef = humanRef();

/** RFC 3339 in UTC, e.g. "2026-11-13T09:30:00Z". */
export const UtcTimestamp = z.iso
  .datetime()
  .meta({ id: 'UtcTimestamp', description: 'RFC 3339 timestamp in UTC' });

/** "2026-11-13", read in the owning workstream's time zone. */
export const LocalDate = z.iso.date().meta({
  id: 'LocalDate',
  description: "Local date YYYY-MM-DD, read in the owning workstream's time zone",
});

/** A local wall-clock time "HH:MM", read in the accompanying time zone. */
export const LocalTime = z
  .string()
  .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
  .describe('Local time HH:MM');

/** An IANA time zone name such as "Asia/Kolkata". */
export const IanaTimeZone = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/)
  .describe('IANA time zone name');

/** Lower-case hex SHA-256 of a blob in the content-addressed store (03 §12). */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('SHA-256, lower-case hex');

export const Actor = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user') }),
    z.strictObject({
      kind: z.literal('agent'),
      principalId: AgentPrincipalId,
      runId: RunId.optional(),
    }),
    z.strictObject({ kind: z.literal('connector'), bindingId: ConnectorBindingId, runId: RunId }),
    z.strictObject({
      kind: z.literal('system'),
      component: z.enum(['rhythm', 'review', 'escalation', 'ingest', 'scheduler', 'migration']),
    }),
  ])
  .meta({
    id: 'Actor',
    description:
      'Who did something: the user, an agent principal, a connector run or a system component',
  });
export type Actor = z.infer<typeof Actor>;

/** Audit fields of every record (03 §3). `version` is the optimistic-concurrency counter. */
export const auditShape = {
  createdAt: UtcTimestamp,
  createdBy: Actor,
  updatedAt: UtcTimestamp,
  updatedBy: Actor,
  version: z.int().min(1),
};

export const Health = z.enum(['on_track', 'at_risk', 'off_track']);
export type Health = z.infer<typeof Health>;

export const Privacy = z.enum(['normal', 'sensitive']);
export type Privacy = z.infer<typeof Privacy>;

/** An open JSON object, such as a connector action's input. */
export const JsonObject = z.record(z.string(), z.unknown());
