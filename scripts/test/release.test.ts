/**
 * pnpm cc:release (08 §6, 08 §9): one version for every @cc/* package, the changelog, and a
 * local tag only on main. Runs against a synthetic monorepo in a temp git repository; it never
 * pushes and never publishes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import {
  bump,
  changelogSection,
  formatVersion,
  nextVersion,
  parseCommit,
  parseVersion,
  runRelease,
  type Version,
} from '../release.ts';

let dir: ProfileDir;
let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function manifest(path: string, name: string, version: string, isPrivate = false): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, path, 'package.json'),
    `${JSON.stringify({ name, version, ...(isPrivate ? { private: true } : {}), type: 'module' }, null, 2)}\n`,
  );
}

function commit(subject: string, body = ''): void {
  writeFileSync(join(root, 'work.txt'), `${subject}\n${Math.random()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', subject, ...(body === '' ? [] : ['-m', body]));
}

function versions(): string[] {
  return ['apps/cli', 'packages/build', 'packages/schemas', 'packages/third-party'].map(
    (path) =>
      (JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as { version: string })
        .version,
  );
}

beforeEach(() => {
  dir = createProfileDir();
  root = join(dir.path, 'foundation');
  mkdirSync(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture Maintainer');
  git('config', 'user.email', 'maintainer@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  manifest('apps/cli', '@cc/cli', '0.0.0');
  manifest('packages/build', '@cc/build', '0.0.0');
  manifest('packages/schemas', '@cc/schemas', '0.0.0', true);
  manifest('packages/third-party', 'not-cc', '9.9.9');
  commit('feat: scaffold (#1)');
  commit('fix(build): stamp the commit (#2)');
  git('switch', '-q', '-c', 'release/next');
});
afterEach(() => dir.cleanup());

describe('cc:release versions', () => {
  const v = (text: string): Version =>
    parseVersion(text) ?? { major: -1, minor: -1, patch: -1, beta: null };

  it.each([
    ['0.0.0', 'minor', 'beta', '0.1.0-beta.0'],
    ['0.1.0-beta.0', 'patch', 'beta', '0.1.0-beta.1'],
    ['0.1.0-beta.3', 'major', 'stable', '0.1.0'],
    ['0.1.0', 'patch', 'stable', '0.1.1'],
    ['0.4.2', 'major', 'stable', '0.5.0'],
    ['1.4.2', 'major', 'stable', '2.0.0'],
    ['1.4.2', 'minor', 'beta', '1.5.0-beta.0'],
  ] as const)('%s with a %s change on %s is %s', (current, level, channel, expected) => {
    expect(formatVersion(nextVersion(v(current), level, channel))).toBe(expected);
  });

  it('reads breaking changes from ! and from a BREAKING CHANGE footer', () => {
    expect(parseCommit({ sha: 'a', subject: 'feat(ui-sdk)!: drop v1', body: '' })).toMatchObject({
      type: 'feat',
      scope: 'ui-sdk',
      breaking: true,
    });
    expect(
      parseCommit({ sha: 'b', subject: 'refactor: x', body: 'BREAKING CHANGE: y' }).breaking,
    ).toBe(true);
    expect(parseCommit({ sha: 'c', subject: 'Merge branch x', body: '' }).type).toBe('other');
    expect(formatVersion(bump(v('0.0.0'), 'patch'))).toBe('0.0.1');
  });

  it('groups the changelog by kind', () => {
    const commits = [
      parseCommit({ sha: '1111111aaaa', subject: 'feat(build)!: new stamp format', body: '' }),
      parseCommit({ sha: '2222222bbbb', subject: 'feat: cc:upgrade', body: '' }),
      parseCommit({ sha: '3333333cccc', subject: 'fix(store): fts rebuild', body: '' }),
      parseCommit({ sha: '4444444dddd', subject: 'docs: readme', body: '' }),
    ];
    expect(changelogSection('1.0.0', '2026-11-12', commits)).toBe(
      [
        '## v1.0.0 (2026-11-12)',
        '',
        '### Breaking changes',
        '',
        '- build: new stamp format (1111111)',
        '',
        '### Features',
        '',
        '- cc:upgrade (2222222)',
        '',
        '### Fixes',
        '',
        '- store: fts rebuild (3333333)',
        '',
        '### Other changes',
        '',
        '- docs: readme (4444444)',
        '',
      ].join('\n'),
    );
  });
});

describe('pnpm cc:release', () => {
  it('--channel beta bumps every @cc/* package to one version, writes the changelog and commits', () => {
    const result = runRelease(root, ['--channel', 'beta', '--date', '2026-11-12']);
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    expect(result.lines[0]).toBe(
      'cc:release: 0.0.0 -> 0.1.0-beta.0 (beta, minor; 2 commits since the first commit; 3 packages)',
    );
    expect(versions()).toEqual(['0.1.0-beta.0', '0.1.0-beta.0', '0.1.0-beta.0', '9.9.9']);
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^# Changelog\n/);
    expect(changelog).toContain(
      '## v0.1.0-beta.0 (2026-11-12)\n\n### Features\n\n- scaffold (#1) (',
    );
    expect(changelog).toContain('### Fixes\n\n- build: stamp the commit (#2) (');
    expect(git('log', '-1', '--format=%s')).toBe('chore(release): v0.1.0-beta.0');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('tag')).toBe('');
  });

  it('--dry-run prints the plan and writes nothing', () => {
    const result = runRelease(root, ['--channel', 'stable', '--dry-run', '--date', '2026-11-12']);
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe(
      'cc:release: 0.0.0 -> 0.1.0 (stable, minor; 2 commits since the first commit; 3 packages)',
    );
    expect(versions()).toEqual(['0.0.0', '0.0.0', '0.0.0', '9.9.9']);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('refuses main, a dirty tree, and packages at different versions', () => {
    git('switch', '-q', 'main');
    expect(runRelease(root, ['--channel', 'beta']).lines).toEqual([
      'cc:release: main is protected (08 §9 rule 1); run this on a release branch and open a PR',
    ]);
    git('switch', '-q', 'release/next');
    writeFileSync(join(root, 'stray.txt'), 'x');
    expect(runRelease(root, ['--channel', 'beta']).lines).toEqual([
      'cc:release: the working tree is not clean; commit or stash first',
    ]);
    manifest('packages/build', '@cc/build', '0.2.0');
    expect(runRelease(root, ['--channel', 'beta', '--dry-run']).lines).toEqual([
      'cc:release: the @cc/* packages are not at one version: 0.0.0, 0.2.0',
    ]);
  });

  it('--tag tags the merged release on main locally, and --verify-tag is what release.yml checks', () => {
    expect(runRelease(root, ['--channel', 'beta', '--date', '2026-11-12']).exitCode).toBe(0);
    expect(runRelease(root, ['--tag']).lines).toEqual([
      'cc:release: tag only on main, after the release PR merged (08 §9 rule 3)',
    ]);
    git('switch', '-q', 'main');
    git('merge', '-q', '--ff-only', 'release/next');
    expect(runRelease(root, ['--tag'])).toEqual({
      exitCode: 0,
      lines: [
        'cc:release: tagged v0.1.0-beta.0 locally',
        'next: git push origin v0.1.0-beta.0 (release.yml publishes it, 08 §9)',
      ],
    });
    expect(git('tag')).toBe('v0.1.0-beta.0');
    expect(runRelease(root, ['--tag']).lines).toEqual([
      'cc:release: tag v0.1.0-beta.0 already exists',
    ]);
    expect(runRelease(root, ['--verify-tag', 'v0.1.0-beta.0'])).toEqual({
      exitCode: 0,
      lines: ['cc:release: v0.1.0-beta.0 verified (2 packages to publish)'],
    });
    expect(runRelease(root, ['--verify-tag', 'v0.2.0']).exitCode).toBe(1);

    // The next beta counts only the commits since the tag.
    git('switch', '-q', '-c', 'release/again');
    commit('fix: a fix (#3)');
    const again = runRelease(root, ['--channel', 'beta', '--date', '2026-11-13']);
    expect(again.lines[0]).toBe(
      'cc:release: 0.1.0-beta.0 -> 0.1.0-beta.1 (beta, patch; 1 commits since v0.1.0-beta.0; 3 packages)',
    );
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog.indexOf('## v0.1.0-beta.1')).toBeLessThan(
      changelog.indexOf('## v0.1.0-beta.0'),
    );
  });

  it('--verify-tag refuses while every @cc/* package is private (OQ-08-07, OQ-08-01)', () => {
    manifest('apps/cli', '@cc/cli', '0.0.0', true);
    manifest('packages/build', '@cc/build', '0.0.0', true);
    commit('chore: keep private');
    expect(runRelease(root, ['--channel', 'beta', '--date', '2026-11-12']).exitCode).toBe(0);
    expect(runRelease(root, ['--verify-tag', 'v0.1.0-beta.0'])).toEqual({
      exitCode: 1,
      lines: [
        'cc:release: every @cc/* package is private, so nothing would be published; the registry and licence are open (OQ-08-07, OQ-08-01)',
      ],
    });
  });

  it('nothing to release is exit 0, and a bad command line is exit 2', () => {
    expect(runRelease(root, []).exitCode).toBe(2);
    expect(runRelease(root, ['--channel', 'nightly']).exitCode).toBe(2);
    expect(runRelease(root, ['--channel', 'beta', '--tag']).exitCode).toBe(2);
    expect(runRelease(root, ['--channel', 'beta', '--date', '2026-11-12']).exitCode).toBe(0);
    git('tag', 'v0.1.0-beta.0');
    expect(runRelease(root, ['--channel', 'beta'])).toEqual({
      exitCode: 0,
      lines: ['cc:release: nothing to release since v0.1.0-beta.0'],
    });
  });
});
