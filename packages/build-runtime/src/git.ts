/**
 * Git access for the clean-tree check, the build stamp and Rebuild now (ADR 0004).
 *
 * Every spawn is hardened as ADR 0004 decision 3 sets out: `--git-dir` and `--work-tree`
 * are passed explicitly (so a checkout without `.git` never reports on an enclosing
 * repository), `--no-optional-locks` keeps the user's index untouched, and fsmonitor, the
 * untracked cache and the user's global excludes file are switched off, so a hostile
 * `.git/config` cannot run a hook or hide a file. `GIT_*` variables of the caller's
 * environment are dropped for the same reason. HEAD is read from `.git` without a spawn.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** The repository layout of one checkout: a plain clone, or a linked worktree. */
export interface GitLayout {
  /** The checkout's working tree. */
  readonly workTree: string;
  /** The per-checkout git directory (HEAD, index, in-progress markers). */
  readonly gitDir: string;
  /** The shared git directory (objects, refs, `info/exclude`). Equal to gitDir in a clone. */
  readonly commonDir: string;
}

/** Finds the git directories of `workTree`, or null when it is not a git checkout. */
export function gitLayout(workTree: string): GitLayout | null {
  const dotGit = join(workTree, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return { workTree, gitDir: dotGit, commonDir: dotGit };
  if (!stat.isFile()) return null;
  // A linked worktree or submodule: `.git` is a file `gitdir: <path>`.
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (match?.[1] === undefined) return null;
  const gitDir = resolve(workTree, match[1]);
  if (!existsSync(gitDir)) return null;
  const commonFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
    : gitDir;
  return { workTree, gitDir, commonDir };
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Reads the commit HEAD points to, from the files in `.git`, without spawning git
 * (ADR 0004 method H: about 0.2 ms in process). Returns null when HEAD cannot be resolved,
 * for example on an unborn branch.
 */
export function readHead(layout: GitLayout): string | null {
  let head: string;
  try {
    head = readFileSync(join(layout.gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (ref === undefined || ref.includes('..')) return null;
  for (const dir of [layout.gitDir, layout.commonDir]) {
    const file = join(dir, ref);
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim();
      return SHA.test(value) ? value : null;
    }
  }
  const packed = join(layout.commonDir, 'packed-refs');
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, 'utf8').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
  }
  return null;
}

/** The marker files of an operation in progress (ADR 0004 decision 3). */
const IN_PROGRESS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
] as const;

/** Names the git operation in progress in this checkout, or null. */
export function operationInProgress(layout: GitLayout): string | null {
  for (const [file, name] of IN_PROGRESS) {
    if (existsSync(join(layout.gitDir, file))) return name;
  }
  return null;
}

/** The active patterns of `.git/info/exclude`: they can hide an untracked file. */
export function localExcludes(layout: GitLayout): string[] {
  const file = join(layout.commonDir, 'info', 'exclude');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Finds an executable on PATH (with PATHEXT on Windows), as an absolute path. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? '';
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension.toLowerCase());
      const upper = join(dir, name + extension);
      for (const file of new Set([candidate, upper])) {
        try {
          accessSync(file, constants.X_OK);
          if (statSync(file).isFile()) return file;
        } catch {
          // not here
        }
      }
    }
  }
  return null;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The environment for every git spawn: the caller's, without GIT_* variables. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('GIT_')) clean[key] = value;
  }
  clean.GIT_OPTIONAL_LOCKS = '0';
  clean.LC_ALL = 'C';
  return clean;
}

/**
 * An empty file for git's config paths. Git for Windows maps the literal `/dev/null` to `nul`
 * itself and cannot open `\\.\nul` (Node's `os.devNull` there), so it is `/dev/null` on every OS.
 */
export const NULL_FILE = '/dev/null';

/** The hardened prefix of every git command (ADR 0004 decision 3). */
export function hardenedArgs(layout: GitLayout): string[] {
  return [
    `--git-dir=${layout.gitDir}`,
    `--work-tree=${layout.workTree}`,
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    `core.excludesFile=${NULL_FILE}`,
  ];
}

/** Runs git with the hardened prefix. Never throws for a non-zero exit. */
export function runGit(
  git: string,
  layout: GitLayout,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      git,
      [...hardenedArgs(layout), ...args],
      {
        cwd: layout.workTree,
        env: { ...gitEnv(), ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolvePromise({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

/** Splits NUL-terminated git output. */
export function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** The path of one `git status --porcelain=v2 -z` entry (the first path of a rename). */
export function statusEntryPath(entry: string): string {
  const fields: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1, '!': 1 };
  const skip = fields[entry[0] ?? ''] ?? 0;
  return entry.split(' ').slice(skip).join(' ');
}

/**
 * The files of git's view of the tree: tracked files that still exist, plus untracked files
 * that are not ignored (ADR 0004 decision 4). An ignored file never reaches a build.
 */
export async function gitViewFiles(git: string, layout: GitLayout): Promise<string[]> {
  const result = await runGit(git, layout, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  if (result.code !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  const files = new Set(splitNul(result.stdout));
  return [...files].filter((file) => existsSync(join(layout.workTree, file))).sort();
}
