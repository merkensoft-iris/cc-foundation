/**
 * The clean-tree start check, `decide` of ADR 0004 decision 3, and stale-build detection
 * (04 §10 rules 2 and 4, owner decisions `s7-stale-build` and C1, 10 Nov 2026).
 *
 * The desktop shell runs `checkStart(stamp)` asynchronously at every start, in parallel with
 * creating the window, and again when the app is idle. The mode is **normal** only when the
 * build was made from a clean tree that matched its install, HEAD is still the build commit
 * (or moved only by runtime-read files such as `connectors.lock`), and the checkout is still
 * clean. Anything else is **developer** mode with the reasons attached. A clean checkout
 * whose build is behind HEAD, or whose install is out of date, is "build out of date" and
 * gets the Rebuild now offer; a dirty checkout never does.
 *
 * The check only reads: git runs with `--no-optional-locks` and the hardening of `git.ts`.
 */
import { existsSync } from 'node:fs';

import {
  gitLayout,
  localExcludes,
  operationInProgress,
  readHead,
  runGit,
  splitNul,
  statusEntryPath,
  type GitLayout,
} from './git.js';
import { installDrift, type BuildStamp } from './stamps.js';

/** The start mode, the same shape as `@cc/desktop`'s `StartMode` (P1-10). */
export type StartMode =
  { readonly kind: 'normal' } | { readonly kind: 'developer'; readonly reasons: readonly string[] };

/** Files CC reads from the checkout at run time; a commit touching only these needs no rebuild (04 §10 rule 3). */
export const RUNTIME_READ_FILES: readonly string[] = ['connectors.lock'];

export const REASON_STALE = 'build out of date';

export interface StartCheckResult {
  readonly mode: StartMode;
  /** True when Rebuild now is offered: the checkout is clean and the build is out of date. */
  readonly offerRebuild: boolean;
  /** The checkout's HEAD, when it could be read. */
  readonly head: string | null;
}

export interface TreeInspection {
  readonly layout: GitLayout | null;
  readonly head: string | null;
  /** Reasons the checkout is not clean; empty when it is. */
  readonly dirty: readonly string[];
}

/**
 * Inspects the checkout's working tree: everything of ADR 0004 decision 3 except the
 * comparison with a build. Used at start and by `cc-build build` for the stamp's `clean`.
 */
export async function inspectTree(checkout: string, git: string | null): Promise<TreeInspection> {
  const layout = gitLayout(checkout);
  if (layout === null) return { layout, head: null, dirty: ['not a git checkout'] };
  const head = readHead(layout);
  if (git === null || !existsSync(git)) {
    return { layout, head, dirty: ['cannot verify tree: git not found'] };
  }
  const dirty: string[] = [];
  const operation = operationInProgress(layout);
  if (operation !== null) dirty.push(`${operation} in progress`);
  if (head === null) dirty.push('cannot verify tree: HEAD does not name a commit');

  let status, flags;
  try {
    [status, flags] = await Promise.all([
      runGit(git, layout, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      runGit(git, layout, ['ls-files', '-v', '-z']),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { layout, head, dirty: [...dirty, `cannot verify tree: ${detail}`] };
  }
  if (status.code !== 0) {
    dirty.push(`cannot verify tree: git status failed (${status.stderr.trim()})`);
  } else {
    // A rename's original path is a separate NUL-terminated field; keep only entry lines.
    const changed = splitNul(status.stdout).filter((entry) => /^[12u?] /.test(entry));
    if (changed.length > 0) {
      const first = statusEntryPath(changed[0] ?? '');
      const more = changed.length > 1 ? ` and ${changed.length - 1} more` : '';
      dirty.push(`uncommitted changes: ${first}${more}`);
    }
  }
  if (flags.code === 0) {
    // `ls-files -v`: a lower-case tag is assume-unchanged; S or s is skip-worktree.
    const hidden = splitNul(flags.stdout).filter((entry) => /^(?:[a-z]|S) /.test(entry));
    if (hidden.length > 0) {
      dirty.push(`index flags hide changes: ${hidden[0]?.slice(2) ?? ''}`);
    }
  } else {
    dirty.push(`cannot verify tree: git ls-files failed (${flags.stderr.trim()})`);
  }
  const excludes = localExcludes(layout);
  if (excludes.length > 0) {
    dirty.push(`.git/info/exclude has active patterns: ${excludes[0] ?? ''}`);
  }
  return { layout, head, dirty };
}

/** The files changed between two commits, or null when git cannot tell (a missing commit). */
async function changedFiles(
  git: string,
  layout: GitLayout,
  from: string,
  to: string,
): Promise<string[] | null> {
  const result = await runGit(git, layout, [
    'diff',
    '--no-ext-diff',
    '--name-only',
    '-z',
    from,
    to,
  ]);
  return result.code === 0 ? splitNul(result.stdout) : null;
}

/**
 * The start check (ADR 0004 `decide`) for the running build. A missing stamp, or one that
 * cannot be read, is developer mode ("no build stamp"), never normal.
 */
export async function checkStart(stamp: BuildStamp | null): Promise<StartCheckResult> {
  if (stamp === null) {
    return developer(['no build stamp: not a packaged build'], false, null);
  }
  const tree = await inspectTree(stamp.checkout, stamp.git);
  const dirty = [...tree.dirty];
  const stale: string[] = [];
  if (!stamp.clean) {
    // The checkout may be clean now; a rebuild from it is what makes the build trustworthy.
    stale.push(
      `${REASON_STALE}: built from a tree that was not clean (${stamp.dirtyReasons[0] ?? 'unknown'})`,
    );
  }
  if (tree.layout !== null && tree.head !== null && stamp.git !== null && tree.dirty.length === 0) {
    if (stamp.commit === null) {
      stale.push(`${REASON_STALE}: the build has no commit`);
    } else if (tree.head !== stamp.commit) {
      const files = await changedFiles(stamp.git, tree.layout, stamp.commit, tree.head);
      const unexpected = files?.filter((file) => !RUNTIME_READ_FILES.includes(file));
      if (unexpected === undefined || unexpected.length > 0) {
        stale.push(
          `${REASON_STALE}: the checkout is at ${tree.head.slice(0, 12)}, the build at ${stamp.commit.slice(0, 12)}`,
        );
      }
    }
    if (stamp.install.kind === 'checkout') {
      const drift = installDrift(stamp.checkout);
      if (drift !== null) stale.push(`${REASON_STALE}: ${drift}`);
    }
  }

  if (dirty.length === 0 && stale.length === 0) {
    return { mode: { kind: 'normal' }, offerRebuild: false, head: tree.head };
  }
  return developer([...stale, ...dirty], dirty.length === 0, tree.head);
}

function developer(
  reasons: readonly string[],
  offerRebuild: boolean,
  head: string | null,
): StartCheckResult {
  return { mode: { kind: 'developer', reasons }, offerRebuild, head };
}
