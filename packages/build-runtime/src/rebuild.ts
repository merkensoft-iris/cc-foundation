/**
 * Rebuild now (04 §10 rule 2; owner decisions C1 and "Rebuild now", 10 Nov 2026; C-01-09;
 * AC-04-14).
 *
 * The desktop shell offers Rebuild now when `checkStart` says `offerRebuild` (a clean
 * checkout whose build is out of date). `rebuildNow`:
 *
 * 1. re-checks that the checkout is clean, and refuses otherwise;
 * 2. takes the pre-update backup (P1-17 supplies it; the shell passes it in);
 * 3. writes the committed tree at HEAD into a new build directory under `<userData>`, through
 *    a temporary index in that directory, so nothing in the checkout is written: not the
 *    source, not `.git`, not the index;
 * 4. installs there from the checked-in lockfiles (`pnpm install --frozen-lockfile`) and
 *    runs the engine's build there (`cc-build build --rebuild-of <checkout>@<commit>`),
 *    logging both to `build.log` in the build directory.
 *
 * A failed step changes nothing: the running app stays, and the result carries the log for
 * the shell to show. When the build succeeds the shell restarts on it when idle
 * (`idle-restart.ts`).
 *
 * TODO(P1-10): the shell's Rebuild now and Later offer, the backup hook and the relaunch on
 * `result.app`. Whether the CLI or MCP may start a rebuild is OQ-04-11; nothing here exposes it.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { findOnPath, gitLayout, runGit, type GitLayout } from './git.js';
import { checkStart, inspectTree } from './start-check.js';
import { findPackagedApp } from './packaged-app.js';
import type { BuildStamp, BuildToolchain } from './stamps.js';

export interface RebuildCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RebuildOptions {
  /** The running build's stamp: names the checkout and git. */
  readonly stamp: BuildStamp;
  /** Where build directories go: `<userData>/builds`. Must be outside the checkout. */
  readonly buildsDir: string;
  /** The pre-update backup (04 §9.1, P1-17). Rebuild does not start if it throws. */
  readonly backup: () => Promise<void>;
  /** The install command; default `pnpm install --frozen-lockfile` with the stamp's pnpm. */
  readonly install?: RebuildCommand;
  /** The build command for an output directory; default `pnpm exec cc-build build ...`. */
  readonly build?: (outDir: string, checkout: string, commit: string) => RebuildCommand;
  readonly now?: () => Date;
}

export type RebuildResult =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly buildDir: string;
      readonly outDir: string;
      /** The packaged app's executable, when the build packaged one. */
      readonly app: string | null;
      readonly log: string;
    }
  | { readonly ok: false; readonly reason: string; readonly log: string | null };

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * A pnpm command with the toolchain the build recorded: pnpm's script run by the recorded
 * Node (no PATH lookup, no `.cmd` shim), or pnpm on PATH for a stamp without one.
 */
export function pnpmCommand(
  toolchain: BuildToolchain | undefined,
  args: readonly string[],
): RebuildCommand {
  const pnpm = toolchain?.pnpm ?? null;
  if (toolchain === undefined || pnpm === null) return { command: PNPM, args };
  return /\.[cm]?js$/i.test(pnpm)
    ? { command: toolchain.node, args: [pnpm, ...args] }
    : { command: pnpm, args };
}

export const DEFAULT_INSTALL: RebuildCommand = pnpmCommand(undefined, [
  'install',
  '--frozen-lockfile',
]);

export function defaultBuild(
  outDir: string,
  checkout: string,
  commit: string,
  toolchain?: BuildToolchain,
): RebuildCommand {
  return pnpmCommand(toolchain, [
    'exec',
    'cc-build',
    'build',
    '--out',
    outDir,
    '--rebuild-of',
    `${checkout}@${commit}`,
  ]);
}

/** PATH for the steps: the recorded Node and git first, so bins and the build find them. */
function stepEnv(stamp: BuildStamp): NodeJS.ProcessEnv {
  const dirs = [stamp.toolchain?.node, stamp.git ?? undefined]
    .filter((path): path is string => path !== undefined)
    .map((path) => dirname(path));
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const path = [...new Set(dirs), process.env[key] ?? ''].filter((part) => part !== '');
  return { ...process.env, [key]: path.join(delimiter) };
}

/** Appends to the build log; a log that cannot be written never fails the build. */
function append(log: string, text: string | Buffer): void {
  try {
    appendFileSync(log, text);
  } catch {
    // the build directory was removed under us; the exit code still reports the outcome
  }
}

function run(
  step: RebuildCommand,
  cwd: string,
  log: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  append(log, `$ ${step.command} ${step.args.join(' ')}\n`);
  return new Promise((done) => {
    const child = spawn(step.command, [...step.args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // pnpm is a .cmd shim on Windows, which only a shell runs.
      shell: process.platform === 'win32' && step.command.endsWith('.cmd'),
    });
    child.stdout.on('data', (chunk: Buffer) => append(log, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(log, chunk));
    child.on('error', (error) => {
      append(log, `${error.message}\n`);
      done(1);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

/** Writes the tree of `commit` into `dest` without touching the checkout's index or files. */
async function materialise(
  git: string,
  layout: GitLayout,
  commit: string,
  dest: string,
  index: string,
): Promise<string | null> {
  const target: GitLayout = { ...layout, workTree: dest };
  const env = { GIT_INDEX_FILE: index };
  const read = await runGit(git, target, ['read-tree', commit], env);
  if (read.code !== 0) return `git read-tree failed: ${read.stderr.trim()}`;
  const checkout = await runGit(git, target, ['checkout-index', '--all', '--force'], env);
  if (checkout.code !== 0) return `git checkout-index failed: ${checkout.stderr.trim()}`;
  return null;
}

export async function rebuildNow(options: RebuildOptions): Promise<RebuildResult> {
  const checkout = resolve(options.stamp.checkout);
  const buildsDir = resolve(options.buildsDir);
  const fromCheckout = relative(checkout, buildsDir);
  if (fromCheckout === '' || (!fromCheckout.startsWith('..') && !isAbsolute(fromCheckout))) {
    // C-01-09: Rebuild now writes nothing inside the checkout, build output included.
    return { ok: false, reason: 'the build directory is inside the checkout', log: null };
  }
  const git = options.stamp.git ?? findOnPath('git');
  if (git === null) return { ok: false, reason: 'cannot verify tree: git not found', log: null };

  // 1. Only a clean checkout whose build is out of date is rebuilt.
  const check = await checkStart(options.stamp);
  if (!check.offerRebuild) {
    const reason =
      check.mode.kind === 'normal'
        ? 'the build is up to date'
        : (check.mode.reasons[0] ?? 'cannot verify tree');
    return { ok: false, reason, log: null };
  }
  const tree = await inspectTree(checkout, git);
  const layout = gitLayout(checkout);
  if (tree.dirty.length > 0 || tree.head === null || layout === null) {
    return { ok: false, reason: tree.dirty[0] ?? 'cannot verify tree', log: null };
  }
  const commit = tree.head;

  // 2. The pre-update backup.
  try {
    await options.backup();
  } catch (error) {
    return {
      ok: false,
      reason: `backup failed: ${error instanceof Error ? error.message : String(error)}`,
      log: null,
    };
  }

  // 3. The committed tree, in a new build directory.
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const buildDir = join(buildsDir, `${commit.slice(0, 12)}-${stamp}`);
  const sourceDir = join(buildDir, 'source');
  const outDir = join(buildDir, 'out');
  mkdirSync(sourceDir, { recursive: true });
  const log = join(buildDir, 'build.log');
  writeFileSync(log, `Rebuild now: ${checkout} at ${commit}\n`);
  const failed = await materialise(git, layout, commit, sourceDir, join(buildDir, 'index'));
  if (failed !== null) {
    append(log, `${failed}\n`);
    return { ok: false, reason: failed, log };
  }

  // 4. Frozen install and build, in the build directory.
  const env = stepEnv(options.stamp);
  const install =
    options.install ?? pnpmCommand(options.stamp.toolchain, ['install', '--frozen-lockfile']);
  if ((await run(install, sourceDir, log, env)) !== 0) {
    return { ok: false, reason: 'install failed; see the build log', log };
  }
  const build =
    options.build?.(outDir, checkout, commit) ??
    defaultBuild(outDir, checkout, commit, options.stamp.toolchain);
  if ((await run(build, sourceDir, log, env)) !== 0) {
    return { ok: false, reason: 'build failed; see the build log', log };
  }
  return { ok: true, commit, buildDir, outDir, app: findPackagedApp(outDir), log };
}
