/**
 * The workstream mapped to a directory (07 §8 item 2): through `Workstream.repoPaths`, or a
 * git remote match.
 *
 * A `repoPaths` entry is a local path (absolute, or starting with `~`) or a git remote
 * (`github.com/example/site`, `git@github.com:example/site.git`, an https URL). A directory
 * maps to the workstream with the most specific path entry it lies in; failing that, to a
 * workstream one of whose entries shares a git remote with the directory's repository: a
 * remote entry equal to one of its remotes, or a path entry whose clone has the same remote,
 * so another clone or worktree of a listed repository maps too. Git's config files are read
 * directly; no process is started.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** A workstream and its `repoPaths`, as `workstreams.get` returns them. */
export interface RepoWorkstream {
  readonly slug: string;
  readonly repoPaths: readonly string[];
}

export interface RepoMatch {
  readonly slug: string;
  readonly via: 'path' | 'remote';
}

function isPathEntry(entry: string): boolean {
  return (
    entry === '~' ||
    entry.startsWith('~/') ||
    entry.startsWith('~\\') ||
    path.posix.isAbsolute(entry) ||
    path.win32.isAbsolute(entry)
  );
}

function expandHome(entry: string, home: string): string {
  return entry === '~' ? home : entry.startsWith('~') ? path.join(home, entry.slice(2)) : entry;
}

/** The real path when it exists, so a symlinked temp directory compares equal. */
function real(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function comparable(dir: string, platform: NodeJS.Platform): string {
  const resolved = real(dir);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Whether `dir` is `root` or inside it. */
export function isWithin(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A remote in one comparable form: `host/owner/repo`, lower case, without scheme, user, port
 * or `.git`. `git@github.com:Example/Site.git` and `https://github.com/example/site` are equal.
 */
export function normalizeRemote(remote: string): string {
  let text = remote.trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.replace(/^[^@/]+@/, '');
  // scp-like `host:owner/repo`, or `host:port/owner/repo` after a scheme.
  text = text.replace(/^([^/:]+):(?:\d+\/)?/, '$1/');
  text = text.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return text;
}

/**
 * The config file that holds the remotes of the repository `dir` is in; with `walkUp` false,
 * only of a repository whose top level is `dir` itself.
 */
function gitConfigOf(dir: string, walkUp: boolean): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, '.git');
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (statSync(dotGit).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (pointer?.[1] === undefined) return undefined;
          gitDir = path.resolve(current, pointer[1].trim());
        }
        // A worktree's git directory names the shared one in `commondir`.
        const common = path.join(gitDir, 'commondir');
        if (existsSync(common)) {
          gitDir = path.resolve(gitDir, readFileSync(common, 'utf8').trim());
        }
      } catch {
        return undefined;
      }
      const config = path.join(gitDir, 'config');
      return existsSync(config) ? config : undefined;
    }
    const parent = path.dirname(current);
    if (!walkUp || parent === current) return undefined;
    current = parent;
  }
}

/** The remote URLs of the repository `dir` is in, normalised; empty outside a repository. */
export function gitRemotes(dir: string, walkUp = true): Set<string> {
  const config = gitConfigOf(dir, walkUp);
  const remotes = new Set<string>();
  if (config === undefined) return remotes;
  let inRemote = false;
  let text: string;
  try {
    text = readFileSync(config, 'utf8');
  } catch {
    return remotes;
  }
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (section !== null) {
      inRemote = section[1]?.toLowerCase() === 'remote';
      continue;
    }
    if (!inRemote) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/i.exec(line);
    if (url?.[1] !== undefined) remotes.add(normalizeRemote(url[1].replace(/^"(.*)"$/, '$1')));
  }
  return remotes;
}

/** The workstream mapped to `cwd`, or undefined when none is. */
export function workstreamForDirectory(
  cwd: string,
  workstreams: readonly RepoWorkstream[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): RepoMatch | undefined {
  const here = comparable(cwd, platform);
  let best: { slug: string; length: number } | undefined;
  for (const workstream of workstreams) {
    for (const entry of workstream.repoPaths.filter(isPathEntry)) {
      const root = comparable(expandHome(entry, home), platform);
      if (isWithin(here, root) && (best === undefined || root.length > best.length)) {
        best = { slug: workstream.slug, length: root.length };
      }
    }
  }
  if (best !== undefined) return { slug: best.slug, via: 'path' };

  const remotes = gitRemotes(cwd);
  if (remotes.size === 0) return undefined;
  for (const workstream of workstreams) {
    for (const entry of workstream.repoPaths) {
      const theirs = isPathEntry(entry)
        ? gitRemotes(expandHome(entry, home), false)
        : new Set([normalizeRemote(entry)]);
      for (const remote of theirs) {
        if (remotes.has(remote)) return { slug: workstream.slug, via: 'remote' };
      }
    }
  }
  return undefined;
}
