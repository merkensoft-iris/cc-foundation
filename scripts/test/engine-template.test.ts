/**
 * pnpm cc:engine-template (09 P1-16): pins packed @cc/* tarballs into a scratch copy of the
 * cc-engine template, as the template's "Pinning the foundation" steps describe a release PR.
 * The copy here is a synthetic cut-down template; CI runs it on a fresh clone of the real one.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';
import { parse } from 'yaml';

import { fileSpec, flagsOn, main, USAGE } from '../engine-template.ts';

const FLAGS = `export const BUILD_FLAGS = {
  build: {
    on: false,
    what: 'building the app',
    arrives: 'the first cc:release',
  },
  upgrade: {
    on: false,
    what: 'cc:upgrade',
    arrives: 'the first cc:release',
  },
  start: {
    on: false,
    what: 'starting the desktop shell',
    arrives: 'the desktop shell',
  },
  include: {
    on: false,
    what: 'cc:include',
    arrives: 'the lock loader (P5)',
  },
} as const;
`;

describe('cc:engine-template pin', () => {
  let dir: ProfileDir;
  beforeEach(() => (dir = createProfileDir()));
  afterEach(() => dir.cleanup());

  function template(): { engine: string; tarballs: string } {
    const engine = join(dir.path, 'engine');
    const tarballs = join(dir.path, 'tarballs');
    mkdirSync(join(engine, 'tools'), { recursive: true });
    mkdirSync(tarballs, { recursive: true });
    writeFileSync(
      join(engine, 'package.json'),
      JSON.stringify({ name: 'cc-engine', devDependencies: { typescript: '~6.0.3' } }),
    );
    writeFileSync(
      join(engine, 'pnpm-workspace.yaml'),
      '# Single-package workspace.\nallowBuilds:\n  esbuild: true\n',
    );
    writeFileSync(join(engine, 'tools', 'build-flags.ts'), FLAGS);
    writeFileSync(
      join(tarballs, 'tarballs.json'),
      JSON.stringify({
        '@cc/build': 'cc-build-0.0.0.tgz',
        '@cc/build-runtime': 'cc-build-runtime-0.0.0.tgz',
        '@cc/core': 'cc-core-0.0.0.tgz',
        '@cc/desktop': 'cc-desktop-0.0.0.tgz',
      }),
    );
    return { engine, tarballs };
  }

  it('pins the app and the build tooling, overrides every @cc/* package and turns the shell flags on', () => {
    const { engine, tarballs } = template();
    const result = main(['pin', '--engine', engine, '--tarballs', tarballs], dir.path);
    expect(result.exitCode, result.lines.join('\n')).toBe(0);

    const manifest = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@cc/desktop': fileSpec(join(tarballs, 'cc-desktop-0.0.0.tgz')),
    });
    expect(manifest.devDependencies).toEqual({
      typescript: '~6.0.3',
      '@cc/build': fileSpec(join(tarballs, 'cc-build-0.0.0.tgz')),
    });

    const workspaceText = readFileSync(join(engine, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspaceText).toMatch(/^# Single-package workspace\./);
    const workspace = parse(workspaceText) as {
      allowBuilds: Record<string, boolean>;
      overrides: Record<string, string>;
    };
    expect(workspace.allowBuilds).toEqual({ esbuild: true, 'electron-winstaller': false });
    expect(Object.keys(workspace.overrides)).toEqual([
      '@cc/build',
      '@cc/build-runtime',
      '@cc/core',
      '@cc/desktop',
    ]);
    expect(workspace.overrides['@cc/core']).toMatch(/^file:.*\/cc-core-0\.0\.0\.tgz$/);

    const flags = readFileSync(join(engine, 'tools', 'build-flags.ts'), 'utf8');
    expect(flags.match(/on: true/g)).toHaveLength(3);
    expect(flags).toMatch(/include: \{\n {4}on: false/);
  });

  it('fails without packed tarballs, on a template without the flag, and on bad usage', () => {
    const { engine } = template();
    expect(main(['pin', '--engine', engine, '--tarballs', dir.path], dir.path).exitCode).toBe(1);
    expect(() => flagsOn('export const BUILD_FLAGS = {};\n', ['start'])).toThrow(
      'tools/build-flags.ts has no start flag',
    );
    expect(flagsOn(flagsOn(FLAGS, ['start']).source, ['start']).changed).toEqual([]);
    expect(main(['publish'], dir.path)).toEqual({ exitCode: 2, lines: [USAGE] });
    expect(fileSpec('C:\\a\\b.tgz')).toMatch(/^file:.*C:\/a\/b\.tgz$|^file:C:\/a\/b\.tgz$/);
  });
});
