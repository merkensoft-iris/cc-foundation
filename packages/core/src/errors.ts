/**
 * Errors of the local API (04 §4.1 rule 4): every failure a caller sees is a CC error code
 * with a message and help lines (07 §4.4). JSON-RPC carries them in `error.data`.
 */
import { DomainError } from '@cc/domain';
import { StoreError } from '@cc/store';
import type { ApiErrorData, ErrorCode } from '@cc/schemas';

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly help: readonly string[];

  constructor(code: ErrorCode, message: string, help: readonly string[] = []) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.help = help;
  }

  /** The `data` member of the JSON-RPC error object. */
  toData(): ApiErrorData {
    return { code: this.code, message: this.message, help: [...this.help] };
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

/**
 * A domain error (@cc/domain) or a store error (@cc/store) as the local API error it maps
 * to, with its code and help lines (the domain puts the rule ID first, 03 §6); anything else
 * unchanged. Both already use the CC error codes of 07 §4.4.
 */
export function asCoreError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof StoreError) {
    return new CoreError(error.code, error.message, error.help);
  }
  return error;
}

/** Help line for every caller that is missing a scope or a principal (07 §4.4). */
export const AGENT_ACCESS_HELP = 'Ask the user to change this principal in Settings → Agent access';

/** Help line of `E_APP_NOT_RUNNING` (04 §8 rule 2, 07 §4.4). */
export const APP_NOT_RUNNING_HELP = 'Open Command Center, then retry';
