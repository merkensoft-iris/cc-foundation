/**
 * Flag parsing (07 §4.1 rule 6, §4.4) and the `--version` fast path (AC-07-02).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args.js';
import { CliError, exitCodeOf } from '../src/errors.js';
import { findCommand, type CommandSpec } from '../src/spec.js';

function command(path: string): CommandSpec {
  const found = findCommand(path);
  if (found === undefined) throw new Error(`no command ${path}`);
  return found;
}

function failure(path: string, argv: string[]): CliError {
  try {
    parseArgs(command(path), argv);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error(`${path} ${argv.join(' ')} parsed`);
}

describe('cc-axi flag parsing', () => {
  it('AC-07-01 an unknown flag is E_UNKNOWN_FLAG (exit 2) listing every valid flag of the command', () => {
    const error = failure('items list', ['--stat']);
    expect(error.code).toBe('E_UNKNOWN_FLAG');
    expect(exitCodeOf(error.code)).toBe(2);
    expect(error.message).toBe('unknown flag --stat for `items list`');
    expect(error.help).toEqual([
      'valid flags for `items list`: --workstream, --owner, --state, --health, --due-before, --fields, --limit, --format, --principal (--help always allowed)',
    ]);
  });

  it('AC-07-01 a renamed flag gets a targeted hint', () => {
    expect(failure('items list', ['--status', 'open']).help[0]).toBe(
      'Use --state instead of --status',
    );
  });

  it('AC-07-01 stray arguments are E_UNKNOWN_FLAG; missing and invalid values are E_USAGE', () => {
    expect(failure('items list', ['extra']).code).toBe('E_UNKNOWN_FLAG');
    expect(failure('items view', []).code).toBe('E_USAGE');
    expect(failure('items list', ['--state', 'finished']).help).toEqual([
      '--state takes one of: draft, open, in_progress, waiting, claimed_done, verified_done, dropped, active',
    ]);
    expect(failure('items list', ['--workstream']).code).toBe('E_USAGE');
    expect(failure('items create', ['--title', 'x']).message).toBe(
      'missing --workstream for `items create`',
    );
    expect(failure('items list', ['--limit', '5', '--limit', '6']).code).toBe('E_USAGE');
    expect(exitCodeOf('E_USAGE')).toBe(2);
    expect(exitCodeOf('E_NOT_FOUND')).toBe(1);
  });

  it('accepts --flag=value, repeated flags, the global flags and --help anywhere', () => {
    const parsed = parseArgs(command('items create'), [
      '--workstream=alderwick',
      '--title',
      'Send it',
      '--due',
      '2026-11-20',
      '--done-means',
      'Sent',
      '--evidence',
      'a',
      '--evidence',
      'b',
      '--format',
      'json',
      '--principal',
      'claude-code',
    ]);
    expect(parsed.values.get('--workstream')).toEqual(['alderwick']);
    expect(parsed.values.get('--evidence')).toEqual(['a', 'b']);
    expect(parsed.globals).toEqual({ format: 'json', principal: 'claude-code' });
    expect(parseArgs(command('items view'), ['--help']).help).toBe(true);
  });
});

describe('cc-axi --version fast path', () => {
  it('AC-07-02 the bin answers --version from the leaf version module before loading the CLI', () => {
    const bin = readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf8');
    const version = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
    const staticImports = [...bin.matchAll(/^import .* from '([^']+)';$/gm)].map(
      (match) => match[1],
    );
    expect(staticImports).toEqual(['axi-sdk-js/fast-path', './version.js']);
    expect(bin).toMatch(
      /if \(!tryFastPath\(process\.argv\.slice\(2\), \{ version: VERSION \}\)\) \{\n\s+const \{ main \} = await import\('\.\/cli\.js'\);/,
    );
    expect(version).not.toMatch(/^import /m);
  });
});
