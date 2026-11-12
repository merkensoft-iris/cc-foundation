/**
 * Flag parsing for one command (07 §4.1 rule 6): unknown flags and stray arguments fail loud
 * with `E_UNKNOWN_FLAG` (exit 2) and list every valid flag of that command inline; renamed
 * flags get a targeted hint; missing or invalid values fail with `E_USAGE` (exit 2) and the
 * exact format. Nothing prompts.
 */
import { CliError, usageError } from './errors.js';
import { flagsOf, FORMATS, type CommandSpec, type FlagSpec } from './spec.js';

export interface Globals {
  readonly format: (typeof FORMATS)[number];
  /** Absent when `--principal` was not given. */
  readonly principal?: string;
}

export interface Parsed {
  readonly positionals: readonly string[];
  /** Flag name (with `--`) to its values; a boolean flag holds `['true']`. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly help: boolean;
  readonly globals: Globals;
}

/** The inline list of 07 §4.4: "valid flags for `items list`: --workstream, ... (--help always allowed)". */
export function validFlagsLine(command: CommandSpec): string {
  const names = flagsOf(command).map((flag) => flag.name);
  return `valid flags for \`${command.path}\`: ${names.length > 0 ? names.join(', ') : 'none'} (--help always allowed)`;
}

function unknownFlag(command: CommandSpec, flag: string): CliError {
  const renamed = command.renamed?.[flag];
  const help = [validFlagsLine(command)];
  if (renamed !== undefined) help.unshift(`Use ${renamed} instead of ${flag}`);
  return new CliError('E_UNKNOWN_FLAG', `unknown flag ${flag} for \`${command.path}\``, help);
}

function flagFormat(flag: FlagSpec): string {
  return flag.choices !== undefined
    ? `${flag.name} takes one of: ${flag.choices.join(', ')}`
    : `${flag.name} takes ${flag.value ?? 'no value'}`;
}

/** Splits `--name=value`; returns the flag name and the inline value, if any. */
function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  return equals === -1 ? [token, undefined] : [token.slice(0, equals), token.slice(equals + 1)];
}

export function parseArgs(command: CommandSpec, argv: readonly string[]): Parsed {
  const flags = new Map(flagsOf(command).map((flag) => [flag.name, flag]));
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  let help = false;
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (onlyPositionals || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    const [name, inline] = splitFlag(token);
    if (name === '--help' || name === '-h') {
      help = true;
      continue;
    }
    const flag = flags.get(name);
    if (flag === undefined) throw unknownFlag(command, name);
    let value: string;
    if (flag.value === undefined) {
      if (inline !== undefined)
        throw usageError(`${name} takes no value`, [validFlagsLine(command)]);
      value = 'true';
    } else if (inline !== undefined) {
      value = inline;
    } else {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw usageError(`${name} needs a value: ${flag.value}`, [
          `Run \`cc-axi ${command.path} --help\` for the format`,
        ]);
      }
      value = next;
      index += 1;
    }
    if (flag.choices !== undefined && !flag.choices.includes(value)) {
      throw usageError(`invalid value "${value}" for ${name}`, [flagFormat(flag)]);
    }
    const existing = values.get(name);
    if (existing !== undefined && flag.repeat !== true) {
      throw usageError(`${name} given more than once`, [`Give ${name} once`]);
    }
    values.set(name, [...(existing ?? []), value]);
  }

  const format = (values.get('--format')?.[0] ?? 'toon') as Globals['format'];
  const principal = values.get('--principal')?.[0];
  const globals: Globals = principal === undefined ? { format } : { format, principal };
  if (help) return { positionals, values, help, globals };

  if (positionals.length > command.args.length) {
    const extra = positionals[command.args.length] ?? '';
    throw new CliError('E_UNKNOWN_FLAG', `unexpected argument "${extra}" for \`${command.path}\``, [
      command.args.length === 0
        ? `\`${command.path}\` takes no arguments; ${validFlagsLine(command)}`
        : `\`${command.path}\` takes ${command.args.map((arg) => arg.placeholder).join(' ')}; quote text that has spaces`,
    ]);
  }
  if (positionals.length < command.args.length) {
    const missing = command.args[positionals.length];
    throw usageError(`missing ${missing?.placeholder ?? 'argument'} for \`${command.path}\``, [
      `Run \`${command.examples[0] ?? `cc-axi ${command.path}`}\``,
    ]);
  }
  for (const flag of command.flags) {
    if (flag.required === true && !values.has(flag.name)) {
      throw usageError(`missing ${flag.name} for \`${command.path}\``, [
        `${flag.name} ${flag.value ?? ''}`.trim() + `: ${flag.description}`,
      ]);
    }
  }
  return { positionals, values, help, globals };
}

/** Peeks at `--format json` before parsing, so even a usage error can print as JSON. */
export function peekFormat(argv: readonly string[]): Globals['format'] {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--format=json' || (token === '--format' && argv[index + 1] === 'json')) {
      return 'json';
    }
  }
  return 'toon';
}

export function single(parsed: Parsed, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

export function many(parsed: Parsed, name: string): readonly string[] {
  return parsed.values.get(name) ?? [];
}

export function flag(parsed: Parsed, name: string): boolean {
  return parsed.values.has(name);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD flag value that names a real calendar date. */
export function dateValue(parsed: Parsed, name: string): string | undefined {
  const value = single(parsed, name);
  if (value === undefined) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !DATE.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw usageError(`invalid date "${value}" for ${name}`, [`${name} takes a date as YYYY-MM-DD`]);
  }
  return value;
}

/** A positive integer flag value, such as `--limit`. */
export function positiveInt(parsed: Parsed, name: string): number | undefined {
  const value = single(parsed, name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw usageError(`invalid value "${value}" for ${name}`, [
      `${name} takes a whole number of 1 or more`,
    ]);
  }
  return Number(value);
}

/** A comma-separated list whose entries must come from `allowed`. */
export function listValue(
  parsed: Parsed,
  name: string,
  allowed: readonly string[],
): string[] | undefined {
  const value = single(parsed, name);
  if (value === undefined) return undefined;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const wrong = entries.filter((entry) => !allowed.includes(entry));
  if (entries.length === 0 || wrong.length > 0) {
    throw usageError(`invalid value "${value}" for ${name}`, [
      `${name} takes a comma-separated list of: ${allowed.join(', ')}`,
    ]);
  }
  return [...new Set(entries)];
}
