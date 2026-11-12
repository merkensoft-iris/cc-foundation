/**
 * `cc-start` (and `cc-build start`): the engine's `pnpm start` runs the app that `pnpm build`
 * packaged (AC-08-11). It runs the packaged app, not a loose folder, because only the packaged
 * app carries the fuses, the asar and the build stamp the start check reads.
 *
 * `cc-start [--out <dir>] [--] [app args...]`: everything after `--out` goes to the app, so
 * `pnpm start --profile-dir <dir>` reaches the shell. The app's own exit code is passed on.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { findPackagedApp } from '@cc/build-runtime';

import type { CommandResult } from './build.js';

export const CC_START_USAGE =
  'usage: cc-start [--out <dir>] [--] [app args...]   run the packaged app (pnpm start)';

export type StartArgs =
  { readonly outDir?: string; readonly args: readonly string[] } | { readonly error: string };

/**
 * Splits `cc-start`'s arguments: a leading `--out <dir>` is ours, an optional `--` ends ours,
 * and the rest is the app's (`--profile-dir`, `--smoke`, a deep link).
 */
export function parseStartArgs(argv: readonly string[]): StartArgs {
  let outDir: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      index += 1;
      break;
    }
    let value: string | undefined;
    if (arg === '--out') {
      value = argv[index + 1];
      index += 2;
    } else if (arg.startsWith('--out=')) {
      value = arg.slice('--out='.length);
      index += 1;
    } else {
      break;
    }
    if (value === undefined || value === '' || value.startsWith('-')) {
      return { error: 'cc-start: --out needs a directory' };
    }
    outDir = value;
  }
  return { ...(outDir === undefined ? {} : { outDir }), args: argv.slice(index) };
}

/** Runs the packaged app in the foreground and returns when it exits. */
export async function runStart(options: {
  readonly root: string;
  readonly outDir?: string;
  readonly args?: readonly string[];
  /** The command name for messages; default `cc-start`. */
  readonly name?: string;
}): Promise<CommandResult> {
  const name = options.name ?? 'cc-start';
  const outDir = resolve(options.root, options.outDir ?? 'dist');
  const app = findPackagedApp(outDir);
  if (app === null) {
    return { exitCode: 1, lines: [`${name}: no packaged app in ${outDir}; run pnpm build first`] };
  }
  const code = await new Promise<number>((done) => {
    const child = spawn(app, [...(options.args ?? [])], { stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('exit', (exitCode) => done(exitCode ?? 1));
  });
  return code === 0
    ? { exitCode: 0, lines: [] }
    : { exitCode: 1, lines: [`${name}: the app exited with code ${code}`] };
}
