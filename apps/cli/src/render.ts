/**
 * Output at the boundary (07 §4.1 rule 1): handlers build plain objects; they print as TOON
 * through axi-sdk-js, or as JSON with `--format json`.
 */
import { encode } from '@toon-format/toon';

import type { Globals } from './args.js';
import { describeError, exitCodeOf } from './errors.js';

export type Output = Record<string, unknown>;

/** Long text is cut at 1,000 characters with its total size (07 §4.1 rule 3). */
export const TRUNCATE_AT = 1000;

export interface Truncation {
  readonly text: string;
  readonly truncated: boolean;
}

export function truncate(text: string, full: boolean): Truncation {
  if (full || text.length <= TRUNCATE_AT) return { text, truncated: false };
  return {
    text: `${text.slice(0, TRUNCATE_AT)}… (truncated: ${TRUNCATE_AT} of ${text.length} chars)`,
    truncated: true,
  };
}

/** What a command handler returns to the SDK: TOON is rendered by the SDK, JSON here. */
export function emit(output: Output, globals: Pick<Globals, 'format'>): Output | string {
  return globals.format === 'json' ? JSON.stringify(output, null, 2) : output;
}

/** The error output on stdout (07 §4.4): `error:`, `code:`, `help[n]:`, or the same as JSON. */
export function formatError(
  error: unknown,
  format: Globals['format'] = 'toon',
): {
  output: string;
  exitCode: number;
} {
  const { code, message, help } = describeError(error);
  const body: Output = { error: message, code };
  if (help.length > 0) body['help'] = help;
  return {
    output: `${format === 'json' ? JSON.stringify(body, null, 2) : encode(body)}\n`,
    exitCode: exitCodeOf(code),
  };
}

/** `2026-11-13` plus `days`, in calendar days. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Rows of one table: every row gets every column, missing values as null, so TOON stays tabular. */
export function table(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): Output[] {
  return rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
  );
}

/** `count: 3 of 23 items ...` (07 §4.1 rule 4). */
export function countLine(shown: number, total: number, noun: string): string {
  return `${shown} of ${total} ${noun}`;
}

/** Shell-quotes an argument for a help line when it needs it. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_.,:/@=+-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}
