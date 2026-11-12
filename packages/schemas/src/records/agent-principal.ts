/**
 * The AgentPrincipal record and its scopes, docs/design/07-agent-friendly-design.md §5: the
 * identity every local API connection authenticates as (04 §4.2).
 */
import { z } from 'zod';

import { AgentPrincipalId, auditShape, UtcTimestamp, WorkstreamId } from './common.js';

export const Scope = z.enum([
  'read',
  'items:write',
  'items:claim',
  'decisions:propose',
  'meetings:capture',
  'measures:write',
  'connectors:read',
  'connectors:invoke',
  'sessions:read',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
]);
export type Scope = z.infer<typeof Scope>;

/** "cli-default", "claude-code", "firstmate-main", "grok-cc", "orchestrator-drafter". */
export const PrincipalName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe('Principal name, also the token file name');

export const AgentPrincipal = z
  .strictObject({
    id: AgentPrincipalId,
    name: PrincipalName,
    kind: z.enum(['cli', 'mcp_client', 'external_framework', 'internal_orchestrator']),
    scopes: z.array(Scope),
    workstreamFilter: z.union([z.array(WorkstreamId), z.literal('all')]),
    /** May read sensitive workstreams; default false. */
    sensitiveAccess: z.boolean(),
    /** <userData>/run/tokens/<name>.token (04 §4.2). */
    tokenPath: z.string().min(1),
    lastUsedAt: UtcTimestamp.optional(),
    revokedAt: UtcTimestamp.optional(),
    ...auditShape,
  })
  .describe('AgentPrincipal (07 §5): a CLI, MCP or agent caller with its scopes');
export type AgentPrincipal = z.infer<typeof AgentPrincipal>;
