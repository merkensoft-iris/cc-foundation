/**
 * Domain errors. Each carries a CC error code of 07 §4.4 and help lines; the first help line
 * names the rule that refused the write (03 §6: "A violation returns `E_INVARIANT` with the
 * ID"). The core service maps a DomainError to the local API error data (04 §4.1 rule 4).
 */
import type { ErrorCode } from '@cc/schemas';

/** A rule a write can break: an invariant of 03 §6 or a numbered rule of another section. */
export type RuleId =
  | `INV-03-${string}`
  | `C-${string}`
  | `01 §${string}`
  | `02 §${string}`
  | `03 §${string}`
  | `04 §${string}`
  | `ADR ${string}`;

export interface Violation {
  readonly rule: RuleId;
  readonly message: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly rule: RuleId;
  readonly help: readonly string[];

  constructor(code: ErrorCode, rule: RuleId, message: string, help: readonly string[] = []) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.rule = rule;
    this.help = [rule, ...help];
  }
}

/** `E_INVARIANT` for a model rule (03 §6). */
export function invariantError(violation: Violation, help: readonly string[] = []): DomainError {
  return new DomainError('E_INVARIANT', violation.rule, violation.message, help);
}

/** Throws the first violation as `E_INVARIANT`; the others go to the help lines. */
export function assertNoViolations(violations: readonly Violation[]): void {
  const [first, ...rest] = violations;
  if (first === undefined) return;
  throw invariantError(
    first,
    rest.map((violation) => `${violation.rule}: ${violation.message}`),
  );
}

/** The deep link that opens an action item in the app (04 §4.3 rule 3). */
export function itemLink(ref: string): string {
  return `commandcenter://items/${ref}`;
}

/** `E_HUMAN_REQUIRED` for a human-only operation (04 §4.3, INV-03-07). */
export function humanRequired(operation: string, deepLink?: string): DomainError {
  return new DomainError(
    'E_HUMAN_REQUIRED',
    'INV-03-07',
    `${operation} is a human-only operation; only the user can do it, in the app`,
    deepLink === undefined ? [] : [deepLink],
  );
}

/** `E_FORBIDDEN` for an actor that may never do this, or an agent without the scope (07 §5). */
export function forbidden(rule: RuleId, message: string): DomainError {
  return new DomainError('E_FORBIDDEN', rule, message, ['Settings → Agent access']);
}
