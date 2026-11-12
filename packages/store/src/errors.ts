/**
 * Store errors in the shape the local API puts in a JSON-RPC error's `data`:
 * `{ code, message, help[] }` (04 §4.1 rule 4). The codes are the CC error codes of
 * 07 §4.4, so the API relays a store error without inventing a parallel format.
 */

/** The CC error codes (07 §4.4) the store itself raises. */
export type StoreErrorCode =
  | 'E_CONFLICT'
  | 'E_NOT_FOUND'
  | 'E_INVARIANT'
  | 'E_USAGE'
  | 'E_GUARD_SYNCED_FOLDER'
  | 'E_GUARD_MIGRATION_CHANGED';

/** The `data` payload of a JSON-RPC error (04 §4.1 rule 4). */
export interface StoreErrorData {
  readonly code: StoreErrorCode;
  readonly message: string;
  readonly help: readonly string[];
}

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** One help line per hint, as 07 §4.4 requires of every error. */
  readonly help: readonly string[];

  constructor(code: StoreErrorCode, message: string, help: readonly string[] = []) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.help = help;
  }

  /** The error as the local API sends it (04 §4.1 rule 4). */
  get data(): StoreErrorData {
    return { code: this.code, message: this.message, help: this.help };
  }
}

/** A write against a stale `version` (03 §12 point 4, 07 §4.4). */
/**
 * A write that lost to the row already there: a stale `version` on an update, or an insert
 * over a record that exists (03 §12 point 4, 07 §4.4). `expected` is 0 for the insert.
 */
export function conflict(table: string, id: string, expected: number, actual: number): StoreError {
  return new StoreError(
    'E_CONFLICT',
    expected === 0
      ? `${table} ${id} already exists at version ${String(actual)}`
      : `${table} ${id} is at version ${String(actual)}, not the expected ${String(expected)}`,
    ['re-read the record and retry the command with its current version'],
  );
}

export function notFound(table: string, id: string): StoreError {
  return new StoreError('E_NOT_FOUND', `no ${table} row with id ${id}`, [
    `list ${table} to find the right ID`,
  ]);
}
