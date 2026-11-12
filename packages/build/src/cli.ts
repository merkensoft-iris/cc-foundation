/**
 * The engine-facing commands of `@cc/build` (08 §6: "the engine's scripts come from
 * `@cc/build`, so the engine holds no script code"). Each prints a short summary, never
 * prompts, and exits 0 (success or no-op), 1 (failure) or 2 (usage error).
 *
 * One bin per engine script, so an engine script names its bin and passes the user's
 * arguments straight through (the cc-engine template's `tools/cc.ts` does exactly that):
 * `cc-build` (pnpm build; with no command it builds), `cc-start` (pnpm start),
 * `cc-install-stamp` (postinstall) and `cc-upgrade` (pnpm cc:upgrade). `cc-build` also keeps
 * the subcommands `check`, `start`, `install-stamp` and `start-check`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BUILD_STAMP, checkStart, readBuildStamp, writeInstallStamp } from '@cc/build-runtime';

import { runBuild, STAGE_DIR, type CommandResult } from './build.js';
import { CC_START_USAGE, parseStartArgs, runStart } from './start.js';
import { runUpgrade } from './upgrade.js';

export const CC_BUILD_USAGE = [
  'usage: cc-build [<command>]',
  '  [build] [--out <dir>] [--no-package] [--installer] build the app from this engine (pnpm build)',
  '  start [--out <dir>] [--] [app args...]            run the packaged app (pnpm start; also cc-start)',
  '  check                                             validate cc.config.ts and type-check (engine CI)',
  '  install-stamp                                     record the install (postinstall; also cc-install-stamp)',
  '  start-check [--stamp <file>]                      print the start mode a build would get',
].join('\n');

export const CC_UPGRADE_USAGE = 'usage: cc-upgrade [--to <version>] [--check]';

const usage = (text: string, message?: string): CommandResult => ({
  exitCode: 2,
  lines: [...(message === undefined ? [] : [message]), text],
});

/** Splits `<checkout>@<commit>` at the last @, so a path may contain one. */
function parseRebuildOf(value: string): { checkout: string; commit: string } | null {
  const at = value.lastIndexOf('@');
  const checkout = value.slice(0, at);
  const commit = value.slice(at + 1);
  return at > 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) ? { checkout, commit } : null;
}

const writeStamp = (cwd: string, name: string): CommandResult => {
  const stamp = writeInstallStamp(cwd);
  return { exitCode: 0, lines: [`${name}: install stamp ${stamp.digest.slice(0, 12)}`] };
};

/** `cc-start`: the engine's `pnpm start`. */
export async function ccStart(
  argv: readonly string[],
  cwd: string,
  name = 'cc-start',
): Promise<CommandResult> {
  if (argv[0] === '--help' || argv[0] === '-h') return { exitCode: 0, lines: [CC_START_USAGE] };
  const parsed = parseStartArgs(argv);
  if ('error' in parsed) return usage(CC_START_USAGE, parsed.error.replace('cc-start', name));
  return runStart({
    root: cwd,
    ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
    args: parsed.args,
    name,
  });
}

/** `cc-install-stamp`: the engine's root `postinstall` (ADR 0004 decision 2). */
export function ccInstallStamp(argv: readonly string[], cwd: string): CommandResult {
  if (argv.length > 0)
    return usage('usage: cc-install-stamp', 'cc-install-stamp takes no arguments');
  return writeStamp(cwd, 'cc-install-stamp');
}

const COMMANDS = new Set(['build', 'check', 'start', 'install-stamp', 'start-check']);

export async function ccBuild(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const first = argv[0] ?? '';
  if (first === '-h' || first === '--help') return { exitCode: 0, lines: [CC_BUILD_USAGE] };
  // No command, or a leading option, is `build`: the engine's `pnpm build [--installer]`.
  const [command = 'build', ...rest] =
    first === '' || first.startsWith('-') ? ['build', ...argv] : argv;
  if (command === 'start') return ccStart(rest, cwd, 'cc-build start');
  if (!COMMANDS.has(command)) return usage(CC_BUILD_USAGE, `cc-build: unknown command ${command}`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        out: { type: 'string' },
        'no-package': { type: 'boolean' },
        installer: { type: 'boolean' },
        'rebuild-of': { type: 'string' },
        stamp: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return usage(
      CC_BUILD_USAGE,
      `cc-build: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { values } = parsed;
  if (values.help === true) return { exitCode: 0, lines: [CC_BUILD_USAGE] };
  const out = values.out;
  switch (command) {
    case 'build': {
      let rebuildOf;
      if (values['rebuild-of'] !== undefined) {
        rebuildOf = parseRebuildOf(values['rebuild-of']);
        if (rebuildOf === null)
          return usage(CC_BUILD_USAGE, 'cc-build: --rebuild-of takes <checkout>@<commit>');
      }
      return runBuild({
        root: cwd,
        ...(out === undefined ? {} : { outDir: out }),
        package: values['no-package'] !== true,
        installer: values.installer === true,
        ...(rebuildOf === undefined ? {} : { rebuildOf }),
      });
    }
    case 'check':
      return runBuild({ root: cwd, checkOnly: true });
    case 'install-stamp':
      return writeStamp(cwd, 'cc-build');
    case 'start-check': {
      const path = resolve(cwd, values.stamp ?? `${out ?? 'dist'}/${STAGE_DIR}/${BUILD_STAMP}`);
      const result = await checkStart(readBuildStamp(path));
      const lines =
        result.mode.kind === 'normal'
          ? ['mode: normal']
          : [
              `mode: developer (${result.mode.reasons[0] ?? ''})`,
              ...result.mode.reasons.slice(1).map((r) => `  also: ${r}`),
            ];
      if (result.offerRebuild) lines.push('rebuild: offered (Rebuild now)');
      return { exitCode: 0, lines };
    }
    default:
      return usage(CC_BUILD_USAGE);
  }
}

export async function ccUpgrade(argv: readonly string[], cwd: string): Promise<CommandResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        to: { type: 'string' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return usage(
      CC_UPGRADE_USAGE,
      `cc-upgrade: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (values.help === true) return { exitCode: 0, lines: [CC_UPGRADE_USAGE] };
  return runUpgrade({
    root: cwd,
    check: values.check === true,
    ...(values.to === undefined ? {} : { to: values.to }),
  });
}

/** Prints a result and sets the exit code. */
export function finish(result: CommandResult): void {
  const text = result.lines.join('\n');
  if (text !== '') (result.exitCode === 0 ? console.log : console.error)(text);
  process.exitCode = result.exitCode;
}
