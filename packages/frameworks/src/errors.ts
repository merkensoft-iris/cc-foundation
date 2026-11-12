/**
 * Framework errors (01 §10, 07 §4.4). Each carries the CC error code, a message, the help
 * lines the CLI prints (the rule ID and the allowed values) and the offending values, so the
 * local API can return it as its error data unchanged.
 */
export type FrameworkErrorCode = 'E_INVARIANT' | 'E_PARAM_BOUNDS' | 'E_USAGE';

export interface FrameworkErrorData {
  readonly code: FrameworkErrorCode;
  readonly message: string;
  readonly help: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export class FrameworkError extends Error {
  readonly code: FrameworkErrorCode;
  readonly help: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;

  constructor(data: FrameworkErrorData) {
    super(data.message);
    this.name = 'FrameworkError';
    this.code = data.code;
    this.help = data.help;
    this.details = data.details;
  }

  toData(): FrameworkErrorData {
    return { code: this.code, message: this.message, help: this.help, details: this.details };
  }
}

/** The outcome of a checked change: the new value, or the error and nothing written. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FrameworkErrorData };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T>(error: FrameworkErrorData): Result<T> => ({ ok: false, error });
