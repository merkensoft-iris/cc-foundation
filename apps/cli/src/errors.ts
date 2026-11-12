/**
 * Structured errors of `cc-axi` (07 §4.4). Every failure prints `error:`, `code:` and
 * `help[n]:` on stdout (AXI principle 6) and exits 1, or 2 for a usage error.
 */

/** Usage errors exit 2 (07 §4.4); `VALIDATION_ERROR` is what axi-sdk-js uses for its own. */
const EXIT_2 = new Set(['E_USAGE', 'E_UNKNOWN_FLAG', 'VALIDATION_ERROR']);

/** A CC error code (07 §4.4) with its message and help lines. */
export class CliError extends Error {
  readonly code: string;
  readonly help: readonly string[];

  constructor(code: string, message: string, help: readonly string[] = []) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.help = help;
  }
}

export function usageError(message: string, help: readonly string[] = []): CliError {
  return new CliError('E_USAGE', message, help);
}

export function exitCodeOf(code: string): 1 | 2 {
  return EXIT_2.has(code) ? 2 : 1;
}

/**
 * Reads the code, message and help of any error: a `CliError`, an error from the local API
 * client (`code` and `help`), or an `AxiError` from the SDK (`code` and `suggestions`).
 * Anything else is `E_INTERNAL`.
 */
export function describeError(error: unknown): { code: string; message: string; help: string[] } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; help?: unknown };
    const suggestions = (error as { suggestions?: unknown }).suggestions;
    if (
      typeof candidate.code === 'string' &&
      /^(?:E_[A-Z0-9_]+|VALIDATION_ERROR)$/.test(candidate.code)
    ) {
      const help = Array.isArray(candidate.help)
        ? candidate.help
        : Array.isArray(suggestions)
          ? suggestions
          : [];
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : String(error),
        help: help.filter((line): line is string => typeof line === 'string'),
      };
    }
  }
  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    help: ['Retry, and report it if it repeats'],
  };
}
