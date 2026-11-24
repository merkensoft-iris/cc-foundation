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

import { expectedUi, fileSpec, flagsOn, main, USAGE } from '../engine-template.ts';

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
        '@cc/ui': 'cc-ui-0.0.0.tgz',
        '@cc/ui-sdk': 'cc-ui-sdk-0.0.0.tgz',
      }),
    );
    return { engine, tarballs };
  }

  it('pins the app, the UI packages ui/ imports and the build tooling, overrides every @cc/* package and turns the shell flags on', () => {
    const { engine, tarballs } = template();
    const result = main(['pin', '--engine', engine, '--tarballs', tarballs], dir.path);
    expect(result.exitCode, result.lines.join('\n')).toBe(0);

    const manifest = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@cc/desktop': fileSpec(join(tarballs, 'cc-desktop-0.0.0.tgz')),
      '@cc/ui': fileSpec(join(tarballs, 'cc-ui-0.0.0.tgz')),
      '@cc/ui-sdk': fileSpec(join(tarballs, 'cc-ui-sdk-0.0.0.tgz')),
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
      '@cc/ui',
      '@cc/ui-sdk',
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

describe('cc:engine-template smoke', () => {
  let dir: ProfileDir;
  beforeEach(() => (dir = createProfileDir()));
  afterEach(() => dir.cleanup());

  /** A synthetic engine copy, with `ui/app.ts` or an empty `ui/`. */
  function engine(ownUi: boolean): string {
    const root = join(dir.path, ownUi ? 'engine-ui' : 'engine-empty');
    mkdirSync(join(root, 'ui'), { recursive: true });
    if (ownUi) {
      writeFileSync(
        join(root, 'ui', 'app.ts'),
        "import { createApp } from '@cc/ui/v1';\n\nvoid createApp().start();\n",
      );
    }
    return root;
  }

  /** A smoke report as the packaged app writes it (apps/desktop shell.ts). */
  function report(fields: Record<string, unknown>): string {
    const path = join(dir.path, `smoke-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        ok: true,
        packaged: true,
        mode: { kind: 'normal' },
        offerRebuild: false,
        firstScreen: 'onboarding',
        ui: 'default',
        uiCall: 'home.get: ok',
        ms: 900,
        ...fields,
      }),
    );
    return path;
  }

  it('AC-08-11 an engine copy with an empty ui/ passes on the default UI and fails on the engine UI', () => {
    const root = engine(false);
    expect(expectedUi(root)).toBe('default');
    const ok = main(['smoke', '--engine', root, '--report', report({})], dir.path);
    expect(ok.exitCode, ok.lines.join('\n')).toBe(0);
    expect(ok.lines[0]).toContain('default UI');

    const wrong = main(['smoke', '--engine', root, '--report', report({ ui: 'engine' })], dir.path);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.lines.join('\n')).toContain('expected the default UI');
  });

  it('AC-08-11 an engine copy with its own ui/app.ts passes on the engine UI and fails on the default UI', () => {
    const root = engine(true);
    expect(expectedUi(root)).toBe('engine');
    const ok = main(['smoke', '--engine', root, '--report', report({ ui: 'engine' })], dir.path);
    expect(ok.exitCode, ok.lines.join('\n')).toBe(0);
    expect(ok.lines[0]).toContain('engine UI');

    const wrong = main(['smoke', '--engine', root, '--report', report({})], dir.path);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.lines.join('\n')).toContain('expected the engine UI');
  });

  it('AC-08-11 fails a failed, unpackaged, developer-mode or non-onboarding start, and a missing report', () => {
    const root = engine(false);
    const run = (fields: Record<string, unknown>) =>
      main(['smoke', '--engine', root, '--report', report(fields)], dir.path);
    expect(run({ ok: false, reason: 'core: boom' }).lines).toEqual([
      'cc:engine-template: smoke failed: core: boom',
    ]);
    expect(run({ packaged: false }).exitCode).toBe(1);
    expect(run({ mode: { kind: 'developer' } }).exitCode).toBe(1);
    expect(run({ offerRebuild: true }).exitCode).toBe(1);
    expect(run({ firstScreen: 'home' }).lines.join('\n')).toContain('expected onboarding');
    expect(
      main(['smoke', '--engine', root, '--report', join(dir.path, 'none.json')], dir.path).exitCode,
    ).toBe(1);
    expect(main(['smoke', '--engine', root], dir.path).exitCode).toBe(2);
  });
});
