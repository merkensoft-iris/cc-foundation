/**
 * pnpm cc:release (08 §6, 08 §9): releases every `@cc/*` package at one version (08 §3).
 *
 * `main` is protected (08 §9 rule 1) and release artifacts come only from CI on a tag of
 * `main` (C-08-06), so a release is two steps, and this script never pushes:
 *
 * 1. `pnpm cc:release --channel beta|stable [--dry-run]`, on a release branch: computes the
 *    next version from the conventional commits since the last `v*` tag, writes it into every
 *    `@cc/*` package.json, prepends the CHANGELOG.md section and commits
 *    `chore(release): v<version>`. The maintainer opens the release PR.
 * 2. `pnpm cc:release --tag`, on `main` after the release PR merged: checks that every
 *    `@cc/*` package has the one version and the changelog has its section, and creates the
 *    annotated tag `v<version>` locally. The owner pushes the tag; `release.yml` publishes.
 *
 * `--verify-tag <tag>` is the check `release.yml` runs before publishing.
 *
 * Versions: a breaking change bumps the major (the minor while the major is 0, as semver
 * allows for 0.y.z), a `feat` the minor, anything else the patch. `beta` releases
 * `<next>-beta.0`, then `-beta.1` and so on within a beta series; `stable` after a beta
 * series releases the series' version.
 *
 * Exit codes follow 08 §6: 0 done or nothing to release, 1 refused, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const USAGE = [
  'usage: pnpm cc:release --channel beta|stable [--dry-run]',
  '       pnpm cc:release --tag',
  '       pnpm cc:release --verify-tag <tag>',
].join('\n');

export const CHANGELOG = 'CHANGELOG.md';
const CHANGELOG_HEADER =
  '# Changelog\n\nEvery `@cc/*` package is released at one version (08 §3). Written by ' +
  '`pnpm cc:release`; the sections come from conventional commit subjects.\n';

export type Channel = 'beta' | 'stable';
export type Level = 'major' | 'minor' | 'patch';

export interface Result {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The beta number, for `X.Y.Z-beta.N`. */
  readonly beta: number | null;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.beta === null ? core : `${core}-beta.${version.beta}`;
}

export function bump(version: Version, level: Level): Version {
  if (level === 'major' && version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0, beta: null };
  }
  if (level === 'major' || level === 'minor') {
    return { major: version.major, minor: version.minor + 1, patch: 0, beta: null };
  }
  return { ...version, patch: version.patch + 1, beta: null };
}

export function nextVersion(current: Version, level: Level, channel: Channel): Version {
  if (current.beta !== null) {
    return channel === 'beta' ? { ...current, beta: current.beta + 1 } : { ...current, beta: null };
  }
  const next = bump(current, level);
  return channel === 'beta' ? { ...next, beta: 0 } : next;
}

export interface Commit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

export interface ParsedCommit extends Commit {
  readonly type: string;
  readonly scope: string | null;
  readonly description: string;
  readonly breaking: boolean;
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommit(commit: Commit): ParsedCommit {
  const match = CONVENTIONAL.exec(commit.subject);
  const breakingBody = /^BREAKING[ -]CHANGE:/m.test(commit.body);
  if (match === null) {
    return {
      ...commit,
      type: 'other',
      scope: null,
      description: commit.subject,
      breaking: breakingBody,
    };
  }
  return {
    ...commit,
    type: match[1] ?? 'other',
    scope: match[2] ?? null,
    description: match[4] ?? commit.subject,
    breaking: match[3] === '!' || breakingBody,
  };
}

export function releaseLevel(commits: readonly ParsedCommit[]): Level {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

/** The CHANGELOG.md section for one release. */
export function changelogSection(
  version: string,
  date: string,
  commits: readonly ParsedCommit[],
): string {
  const groups: [string, (commit: ParsedCommit) => boolean][] = [
    ['Breaking changes', (commit) => commit.breaking],
    ['Features', (commit) => !commit.breaking && commit.type === 'feat'],
    ['Fixes', (commit) => !commit.breaking && commit.type === 'fix'],
    [
      'Other changes',
      (commit) => !commit.breaking && commit.type !== 'feat' && commit.type !== 'fix',
    ],
  ];
  const lines = [`## v${version} (${date})`, ''];
  for (const [title, belongs] of groups) {
    const entries = commits.filter(belongs);
    if (entries.length === 0) continue;
    lines.push(`### ${title}`, '');
    for (const commit of entries) {
      const scope = commit.scope === null ? '' : commit.scope;
      // Other changes keep their type, so "docs" and "chore" stay visible.
      const prefix =
        title === 'Other changes' && commit.type !== 'other'
          ? `${commit.type}${scope === '' ? '' : `(${scope})`}: `
          : scope === ''
            ? ''
            : `${scope}: `;
      lines.push(`- ${prefix}${commit.description} (${commit.sha.slice(0, 7)})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function insertSection(existing: string | null, section: string): string {
  const base = existing ?? CHANGELOG_HEADER;
  const at = base.search(/^## /m);
  if (at < 0) return `${base.trimEnd()}\n\n${section}`;
  return `${base.slice(0, at)}${section}\n${base.slice(at)}`;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(root: string, ...args: string[]): string | null {
  try {
    return git(root, ...args);
  } catch {
    return null;
  }
}

interface Manifest {
  readonly path: string;
  readonly json: Record<string, unknown> & { name: string; version: string; private?: boolean };
}

/** Every `@cc/*` package.json under apps/ and packages/. */
export function ccManifests(root: string): Manifest[] {
  const manifests: Manifest[] = [];
  for (const group of ['apps', 'packages']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(path)) continue;
      const json = JSON.parse(readFileSync(path, 'utf8')) as Manifest['json'];
      if (json.name.startsWith('@cc/')) manifests.push({ path, json });
    }
  }
  return manifests.sort((a, b) => a.json.name.localeCompare(b.json.name));
}

/** The one version every `@cc/*` package has, or the reason there is not one. */
export function lockstepVersion(
  manifests: readonly Manifest[],
): { version: string } | { error: string } {
  const versions = new Set(manifests.map((manifest) => manifest.json.version));
  if (manifests.length === 0) return { error: 'no @cc/* packages found' };
  if (versions.size > 1) {
    return {
      error: `the @cc/* packages are not at one version: ${[...versions].sort().join(', ')}`,
    };
  }
  return { version: [...versions][0] ?? '' };
}

function commitsSince(root: string, tag: string | null): Commit[] {
  const range = tag === null ? ['HEAD'] : [`${tag}..HEAD`];
  const output = git(root, 'log', '--format=%H%x1f%s%x1f%b%x1e', ...range);
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f');
      return { sha, subject, body };
    });
}

export interface PrepareOptions {
  readonly root: string;
  readonly channel: Channel;
  readonly dryRun?: boolean;
  /** The release date, YYYY-MM-DD; default today (UTC). */
  readonly date?: string;
}

export function prepareRelease(options: PrepareOptions): Result {
  const { root } = options;
  const manifests = ccManifests(root);
  const lockstep = lockstepVersion(manifests);
  if ('error' in lockstep) return { exitCode: 1, lines: [`cc:release: ${lockstep.error}`] };
  const current = parseVersion(lockstep.version);
  if (current === null)
    return { exitCode: 1, lines: [`cc:release: ${lockstep.version} is not X.Y.Z or X.Y.Z-beta.N`] };
  if (options.dryRun !== true) {
    if (git(root, 'status', '--porcelain') !== '') {
      return {
        exitCode: 1,
        lines: ['cc:release: the working tree is not clean; commit or stash first'],
      };
    }
    if (git(root, 'branch', '--show-current') === 'main') {
      return {
        exitCode: 1,
        lines: [
          'cc:release: main is protected (08 §9 rule 1); run this on a release branch and open a PR',
        ],
      };
    }
  }
  const lastTag = tryGit(root, 'describe', '--tags', '--abbrev=0', '--match', 'v*');
  const commits = commitsSince(root, lastTag)
    .map(parseCommit)
    .filter((commit) => !(commit.type === 'chore' && commit.scope === 'release'));
  if (commits.length === 0) {
    return {
      exitCode: 0,
      lines: [`cc:release: nothing to release since ${lastTag ?? 'the first commit'}`],
    };
  }
  const level = releaseLevel(commits);
  const next = formatVersion(nextVersion(current, level, options.channel));
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const section = changelogSection(next, date, commits);
  const summary = `cc:release: ${lockstep.version} -> ${next} (${options.channel}, ${level}; ${commits.length} commits since ${lastTag ?? 'the first commit'}; ${manifests.length} packages)`;
  if (options.dryRun === true) return { exitCode: 0, lines: [summary, '', section] };

  for (const manifest of manifests) {
    writeFileSync(
      manifest.path,
      `${JSON.stringify({ ...manifest.json, version: next }, null, 2)}\n`,
    );
  }
  const changelogPath = join(root, CHANGELOG);
  writeFileSync(
    changelogPath,
    insertSection(existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null, section),
  );
  git(root, 'add', CHANGELOG, ...manifests.map((manifest) => manifest.path));
  git(root, 'commit', '-q', '-m', `chore(release): v${next}`);
  return {
    exitCode: 0,
    lines: [
      summary,
      `cc:release: committed chore(release): v${next}`,
      'next: push this branch and open the release PR; after it merges, run pnpm cc:release --tag on main',
    ],
  };
}

/** The checks shared by `--tag` and `--verify-tag`. */
export function verifyRelease(root: string, tag: string | null): Result {
  const lockstep = lockstepVersion(ccManifests(root));
  if ('error' in lockstep) return { exitCode: 1, lines: [`cc:release: ${lockstep.error}`] };
  const expected = `v${lockstep.version}`;
  if (tag !== null && tag !== expected) {
    return {
      exitCode: 1,
      lines: [`cc:release: tag ${tag} does not match the @cc/* version ${lockstep.version}`],
    };
  }
  const changelog = existsSync(join(root, CHANGELOG))
    ? readFileSync(join(root, CHANGELOG), 'utf8')
    : '';
  if (!changelog.includes(`## ${expected} (`)) {
    return {
      exitCode: 1,
      lines: [
        `cc:release: ${CHANGELOG} has no section for ${expected}; run pnpm cc:release --channel first`,
      ],
    };
  }
  const publishable = ccManifests(root).filter((manifest) => manifest.json.private !== true);
  if (publishable.length === 0) {
    return {
      exitCode: 1,
      lines: [
        'cc:release: every @cc/* package is private, so nothing would be published; the registry and licence are open (OQ-08-07, OQ-08-01)',
      ],
    };
  }
  return {
    exitCode: 0,
    lines: [`cc:release: ${expected} verified (${publishable.length} packages to publish)`],
  };
}

export function tagRelease(root: string): Result {
  if (git(root, 'branch', '--show-current') !== 'main') {
    return {
      exitCode: 1,
      lines: ['cc:release: tag only on main, after the release PR merged (08 §9 rule 3)'],
    };
  }
  if (git(root, 'status', '--porcelain') !== '') {
    return { exitCode: 1, lines: ['cc:release: the working tree is not clean'] };
  }
  const verified = verifyRelease(root, null);
  if (verified.exitCode !== 0) return verified;
  const lockstep = lockstepVersion(ccManifests(root));
  const tag = 'version' in lockstep ? `v${lockstep.version}` : '';
  if (tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`) !== null) {
    return { exitCode: 1, lines: [`cc:release: tag ${tag} already exists`] };
  }
  git(root, 'tag', '-a', tag, '-m', tag);
  return {
    exitCode: 0,
    lines: [
      `cc:release: tagged ${tag} locally`,
      `next: git push origin ${tag} (release.yml publishes it, 08 §9)`,
    ],
  };
}

export function runRelease(root: string, args: readonly string[]): Result {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        channel: { type: 'string' },
        'dry-run': { type: 'boolean' },
        tag: { type: 'boolean' },
        'verify-tag': { type: 'string' },
        date: { type: 'string' },
      },
    }));
  } catch (error) {
    return { exitCode: 2, lines: [error instanceof Error ? error.message : String(error), USAGE] };
  }
  const modes = [
    values.channel !== undefined,
    values.tag === true,
    values['verify-tag'] !== undefined,
  ];
  if (modes.filter(Boolean).length !== 1) return { exitCode: 2, lines: [USAGE] };
  if (values.tag === true) return tagRelease(root);
  if (values['verify-tag'] !== undefined) return verifyRelease(root, values['verify-tag']);
  if (values.channel !== 'beta' && values.channel !== 'stable')
    return { exitCode: 2, lines: [USAGE] };
  return prepareRelease({
    root,
    channel: values.channel,
    ...(values['dry-run'] === true ? { dryRun: true } : {}),
    ...(values.date === undefined ? {} : { date: values.date }),
  });
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = runRelease(root, process.argv.slice(2));
  for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
  process.exitCode = result.exitCode;
}
