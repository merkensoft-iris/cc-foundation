/**
 * Execution plans, performers and runs, docs/design/03-decisions-and-action-items.md §5.8,
 * and action templates (§8.4).
 */
import { z } from 'zod';

import {
  ActionItemId,
  Actor,
  AgentPrincipalId,
  ConnectorBindingId,
  EvidenceId,
  JsonObject,
  PersonId,
  RunId,
  Sha256,
  UtcTimestamp,
} from './common.js';
/** The agent profiles of 04 §6.4. */
export const AgentProfileId = z.enum([
  'drafter',
  'extractor',
  'planner',
  'reviewer',
  'summarize',
  'tailor',
  'discoverer',
]);
export type AgentProfileId = z.infer<typeof AgentProfileId>;

export const AgentBudget = z.strictObject({
  maxUsd: z.number().nonnegative(),
  maxMinutes: z.number().positive(),
  maxToolCalls: z.int().min(0),
});
export type AgentBudget = z.infer<typeof AgentBudget>;

export const Performer = z
  .discriminatedUnion('kind', [
    /** The CC user does it by hand. */
    z.strictObject({ kind: z.literal('user') }),
    /** Someone else (a client contact, a contractor). */
    z.strictObject({ kind: z.literal('person'), personId: PersonId }),
    z.strictObject({
      kind: z.literal('connector'),
      bindingId: ConnectorBindingId,
      action: z.string().min(1),
      input: JsonObject,
    }),
    z.strictObject({
      kind: z.literal('agent'),
      profile: AgentProfileId,
      instructions: z.string().min(1),
      /** The tool allowlist (INV-03-08). */
      tools: z.array(z.string().min(1)),
      budget: AgentBudget,
    }),
    z.strictObject({
      kind: z.literal('external_agent'),
      system: z.enum(['firstmate', 'grok', 'other']),
      principalId: AgentPrincipalId.optional(),
      handoff: z.string().min(1),
    }),
  ])
  .meta({ id: 'Performer', description: 'Who performs an execution step (03 §5.8, §8.1)' });
export type Performer = z.infer<typeof Performer>;

export const StepStatus = z.enum([
  'pending',
  'ready',
  'running',
  'waiting_confirmation',
  'waiting_user',
  'waiting_external',
  'succeeded',
  'failed',
  'skipped',
]);
export type StepStatus = z.infer<typeof StepStatus>;

/** The fields of an execution step that an action template also declares (03 §8.4). */
export const stepShape = {
  /** "s1". */
  id: z.string().min(1),
  order: z.int().min(1),
  title: z.string().min(1),
  performer: Performer,
  dependsOn: z.array(z.string().min(1)),
  /** Evidence requirement IDs this step is expected to produce. */
  satisfies: z.array(z.string().min(1)),
  /** 'always' can only make the Policy Engine stricter. */
  confirmation: z.enum(['policy', 'always']),
};

export const ExecutionStep = z
  .strictObject({
    ...stepShape,
    status: StepStatus,
    runIds: z.array(RunId),
    output: z
      .strictObject({ evidenceIds: z.array(EvidenceId), note: z.string().optional() })
      .optional(),
    failure: z
      .strictObject({
        at: UtcTimestamp,
        code: z.string().min(1),
        detail: z.string(),
        retriable: z.boolean(),
      })
      .optional(),
  })
  .meta({ id: 'ExecutionStep', description: 'One step of an execution plan (03 §5.8)' });
export type ExecutionStep = z.infer<typeof ExecutionStep>;

export const ExecutionPlan = z
  .strictObject({
    /** Derived (03 §8.3), never set by hand. */
    mode: z.enum(['manual', 'connector', 'agent', 'mixed']),
    steps: z.array(ExecutionStep),
  })
  .describe('How an action item gets done (03 §5.8)');
export type ExecutionPlan = z.infer<typeof ExecutionPlan>;

export const Run = z
  .strictObject({
    id: RunId,
    kind: z.enum(['connector_action', 'connector_sync', 'agent', 'verification', 'discovery']),
    actionItemId: ActionItemId.optional(),
    stepId: z.string().min(1).optional(),
    startedAt: UtcTimestamp,
    endedAt: UtcTimestamp.optional(),
    status: z.enum(['running', 'succeeded', 'failed', 'needs_user', 'cancelled']),
    actor: Actor,
    usage: z
      .strictObject({
        provider: z.string().min(1),
        model: z.string().min(1),
        inputTokens: z.int().min(0),
        outputTokens: z.int().min(0),
        usd: z.number().nonnegative(),
      })
      .optional(),
    /** Redacted structured log in the blob store. */
    logSha256: Sha256.optional(),
  })
  .describe('Run (03 §5.8): one execution of a connector action, sync, agent or check');
export type Run = z.infer<typeof Run>;
