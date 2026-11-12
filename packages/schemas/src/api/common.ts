/**
 * Shared parts of the local API (docs/design/04-platform.md §4.1): the error data of every
 * JSON-RPC error, and the parameter shapes the methods share.
 */
import { z } from 'zod';

import { HumanRef, humanRef, type HumanRefKind } from '../records/common.js';

/**
 * The CC error codes of 07 §4.4. `E_GUARD_*` codes come from the browser guards (04 §5.5).
 * `E_ALREADY_RUNNING` and `E_ENDPOINT_UNSAFE` come from ADR 0002 (local API endpoint);
 * `E_INTERNAL` is an unexpected failure inside a core handler.
 */
export const ERROR_CODES = [
  'E_USAGE',
  'E_UNKNOWN_FLAG',
  'E_NOT_FOUND',
  'E_INVARIANT',
  'E_PARAM_BOUNDS',
  'E_CONFLICT',
  'E_FORBIDDEN',
  'E_PERMISSION',
  'E_HUMAN_REQUIRED',
  'E_EVIDENCE_MISSING',
  'E_PAYLOAD_CHANGED',
  'E_RATE_LIMIT',
  'E_BUDGET',
  'E_APP_NOT_RUNNING',
  'E_ALREADY_RUNNING',
  'E_ENDPOINT_UNSAFE',
  'E_CRASH',
  'E_INTERNAL',
  'E_SIGNATURE',
  'E_AGENDA_FIT',
] as const;

export const ErrorCode = z
  .union([z.enum(ERROR_CODES), z.string().regex(/^E_GUARD_[A-Z0-9_]+$/)])
  .describe('A CC error code (07 §4.4)');
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The `data` member of every JSON-RPC error object the local API returns (04 §4.1 rule 4). */
export const ApiErrorData = z
  .strictObject({
    code: ErrorCode,
    message: z.string().min(1),
    /** Help lines: the rule ID, the valid values, the deep link or the next command (07 §4.4). */
    help: z.array(z.string()),
  })
  .describe('The data of a local API error (04 §4.1 rule 4, 07 §4.4)');
export type ApiErrorData = z.infer<typeof ApiErrorData>;

/** A record addressed by its HumanRef (`A-0142`) or its ID (`act_...`), as `cc_get` allows. */
export function recordRef(kind: HumanRefKind, prefix: string) {
  return z
    .union([humanRef(kind), z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`))])
    .describe(`${kind}-NNNN HumanRef or ${prefix}_ ID`);
}

/** Any HumanRef, as search hits and history entries carry. */
export const AnyRef = HumanRef;

/** A workstream addressed by slug (the CLI's --workstream) or ID. */
export const WorkstreamRef = z
  .string()
  .regex(/^(?:[a-z0-9][a-z0-9-]*|ws_[A-Za-z0-9_]+)$/)
  .describe('Workstream slug or ws_ ID');

/** A person: `me` (the user), a person ID, or a display name the core resolves. */
export const PersonRef = z.string().min(1).describe('me, a per_ ID, or a person display name');

/** Lists default to 50 entries (07 §4.1 rule 2). */
export const Limit = z.int().min(1).describe('Maximum number of entries; default 50');

/**
 * The outcome of a mutation: `ok` changed something, `no-op` found the desired state already
 * holding (07 §4.4; C-03-01 for claims).
 */
export const MutationStatus = z.enum(['ok', 'no-op']);
export type MutationStatus = z.infer<typeof MutationStatus>;
