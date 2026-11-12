/**
 * Rebuild now and the idle restart (04 §10 rule 2, owner decisions C1 and "Rebuild now",
 * 10 Nov 2026, C-01-09), on a synthetic engine checkout. The install step is a stand-in for
 * `pnpm install --frozen-lockfile` (the fixture has no dependencies to fetch, and tests make
 * no network calls): it links the workspace's TypeScript and runs the real postinstall,
 * `cc-build install-stamp`. The build step is the real `cc-build build --rebuild-of`, without
 * packaging (Electron packaging is checked by hand on macOS and Windows, 09 P1-16).
 *
 * The UI half of AC-04-14 (the offer in the app, the relaunch) arrives with the desktop
 * shell (P1-10); these tests cover the decisions and the build.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILD_STAMP,
  checkStart,
  currentToolchain,
  pnpmCommand,
  readBuildStamp,
  rebuildNow,
  restartWhenIdle,
  type BuildStamp,
  type RebuildCommand,
} from '@cc/build-runtime';

import { runBuild } from '../src/build.js';
import { createEngine, hashTree, write, type EngineFixture } from './engine-fixture.js';

/** These tests run the real tsc, which takes seconds when the whole suite runs at once. */
const TSC_TIMEOUT = 60_000;
const ccBuildBin = fileURLToPath(new URL('../dist/bin/cc-build.js', import.meta.url));
const typescriptDir = dirname(
  dirname(createRequire(import.meta.url).resolve('typescript/bin/tsc')),
);
const passingTypecheck = () => Promise.resolve({ ok: true, output: '', ms: 0 });

/** The install stand-in: link TypeScript into node_modules, then the engine's postinstall. */
function installStub(dir: string): RebuildCommand {
  const script = join(dir, 'install-stub.mjs');
  writeFileSync(
    script,
    [
      "import { mkdirSync, symlinkSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "mkdirSync('node_modules', { recursive: true });",
      `symlinkSync(${JSON.stringify(typescriptDir)}, 'node_modules/typescript', 'junction');`,
      `execFileSync(process.execPath, [${JSON.stringify(ccBuildBin)}, 'install-stamp'], { stdio: 'inherit' });`,
    ].join('\n'),
  );
  return { command: process.execPath, args: [script] };
}

function realBuild(outDir: string, checkout: string, commit: string): RebuildCommand {
  return {
    command: process.execPath,
    args: [
      ccBuildBin,
      'build',
      '--no-package',
      '--out',
      outDir,
      '--rebuild-of',
      `${checkout}@${commit}`,
    ],
  };
}

async function runningStamp(root: string): Promise<BuildStamp> {
  const result = await runBuild({ root, package: false, typecheck: passingTypecheck });
  expect(result.exitCode, result.lines.join('\n')).toBe(0);
  const stamp = readBuildStamp(join(root, 'dist', '.stage', BUILD_STAMP));
  if (stamp === null) throw new Error('no build stamp');
  return stamp;
}

describe('Rebuild now (04 §10 rule 2)', { timeout: TSC_TIMEOUT }, () => {
  let engine: EngineFixture;
  let stamp: BuildStamp;
  let buildsDir: string;

  beforeEach(async () => {
    engine = createEngine();
    stamp = await runningStamp(engine.root);
    buildsDir = join(engine.path, 'userData', 'builds');
    // Ignored files exist in a real checkout; AC-04-14 hashes them too.
    write(engine.root, 'node_modules/some-dep/index.js', 'module.exports = 1;\n');
  });
  afterEach(() => engine.cleanup());

  it('AC-04-14 Rebuild now takes a pre-update backup, builds outside the checkout, restarts when idle, and leaves every file under the checkout unchanged', async () => {
    write(engine.root, 'ui/header.ts', 'export const title = "Pulled";\n');
    const head = engine.commit('feat: pulled foundation update');
    const offer = await checkStart(stamp);
    expect(offer.offerRebuild).toBe(true);

    const before = hashTree(engine.root);
    const events: string[] = [];
    const result = await rebuildNow({
      stamp,
      buildsDir,
      backup: () => {
        events.push(
          `backup (build directories: ${existsSync(buildsDir) ? readdirSync(buildsDir).length : 0})`,
        );
        return Promise.resolve();
      },
      install: installStub(engine.path),
      build: realBuild,
    });
    expect(
      result.ok,
      JSON.stringify(result) + (result.log === null ? '' : readFileSync(result.log, 'utf8')),
    ).toBe(true);
    if (!result.ok) return;
    expect(events).toEqual(['backup (build directories: 0)']);
    expect(result.commit).toBe(head);
    expect(dirname(result.buildDir)).toBe(buildsDir);

    // The build is of the committed tree, stamped with the user's checkout and commit.
    expect(readFileSync(join(result.buildDir, 'source', 'ui', 'header.ts'), 'utf8')).toContain(
      'Pulled',
    );
    const rebuilt = readBuildStamp(join(result.outDir, '.stage', BUILD_STAMP));
    expect(rebuilt).toMatchObject({
      commit: head,
      checkout: engine.root,
      clean: true,
      install: { kind: 'rebuild' },
    });
    expect(readFileSync(result.log, 'utf8')).toContain('cc-build: type-check passed');

    // Nothing under the checkout changed: source, .git and ignored files included (C-01-09).
    expect(hashTree(engine.root)).toEqual(before);

    // The new build starts normally, and the app restarts on it at the first idle moment.
    expect((await checkStart(rebuilt)).mode).toEqual({ kind: 'normal' });
    const idle = [false, false, true];
    const restarted: string[] = [];
    const outcome = await restartWhenIdle({
      isIdle: () => idle.shift() ?? true,
      restart: () => {
        restarted.push(result.outDir);
      },
      wait: () => Promise.resolve(),
    });
    expect(outcome).toBe('restarted');
    expect(idle).toEqual([]);
    expect(restarted).toEqual([result.outDir]);
  });

  it('AC-04-14 a dirty checkout gets no rebuild, and no backup is taken', async () => {
    write(engine.root, 'ui/header.ts', 'export const title = "Pulled";\n');
    engine.commit('feat: pulled');
    write(engine.root, 'ui/header.ts', 'export const title = "Editing";\n');
    let backups = 0;
    const result = await rebuildNow({
      stamp,
      buildsDir,
      backup: () => {
        backups += 1;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ ok: false, reason: 'uncommitted changes: ui/header.ts', log: null });
    expect(backups).toBe(0);
    expect(existsSync(buildsDir)).toBe(false);
  });

  it('a build that is up to date is not rebuilt', async () => {
    const result = await rebuildNow({ stamp, buildsDir, backup: () => Promise.resolve() });
    expect(result).toEqual({ ok: false, reason: 'the build is up to date', log: null });
  });

  it('a build directory inside the checkout is refused (C-01-09)', async () => {
    write(engine.root, 'ui/header.ts', 'export const title = "Pulled";\n');
    engine.commit('feat: pulled');
    const result = await rebuildNow({
      stamp,
      buildsDir: join(engine.root, 'dist', 'builds'),
      backup: () => Promise.resolve(),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'the build directory is inside the checkout',
      log: null,
    });
  });

  it('a failed build changes nothing and returns its log', async () => {
    write(engine.root, 'cc.config.ts', 'export default {\n  extensionApi: 9,\n};\n');
    engine.commit('feat: an engine from the future');
    const before = hashTree(engine.root);
    const result = await rebuildNow({
      stamp,
      buildsDir,
      backup: () => Promise.resolve(),
      install: installStub(engine.path),
      build: realBuild,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.log === null) throw new Error('expected a failure with a log');
    expect(result.reason).toBe('build failed; see the build log');
    expect(readFileSync(result.log, 'utf8')).toContain('extension API 9 is newer than foundation');
    expect(hashTree(engine.root)).toEqual(before);
  });
});

describe('idle restart (04 §10 rule 2)', () => {
  it('waits while a meeting is in progress or a run is in flight', async () => {
    const waits: number[] = [];
    let checks = 0;
    let restarts = 0;
    const outcome = await restartWhenIdle({
      isIdle: () => (checks += 1) > 3,
      restart: () => {
        restarts += 1;
      },
      intervalMs: 5_000,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(outcome).toBe('restarted');
    expect(waits).toEqual([5_000, 5_000, 5_000]);
    expect(restarts).toBe(1);
  });

  it('gives up when aborted (the user chose Later, or the app is quitting)', async () => {
    const controller = new AbortController();
    let restarts = 0;
    const outcome = await restartWhenIdle({
      isIdle: () => false,
      restart: () => {
        restarts += 1;
      },
      wait: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(outcome).toBe('aborted');
    expect(restarts).toBe(0);
  });
});

describe('the toolchain Rebuild now runs (an app started from the Dock or the Start menu)', () => {
  it('runs the pnpm the build recorded with the Node that ran it, not pnpm on PATH', () => {
    const node = '/opt/node-26/bin/node';
    expect(pnpmCommand({ node, pnpm: '/opt/pnpm/bin/pnpm.cjs' }, ['install'])).toEqual({
      command: node,
      args: ['/opt/pnpm/bin/pnpm.cjs', 'install'],
    });
    expect(pnpmCommand({ node, pnpm: 'C:\\pnpm\\pnpm.exe' }, ['install'])).toEqual({
      command: 'C:\\pnpm\\pnpm.exe',
      args: ['install'],
    });
    // A stamp without a recorded pnpm falls back to pnpm on PATH.
    expect(pnpmCommand({ node, pnpm: null }, ['install']).command).toMatch(/^pnpm(?:\.cmd)?$/);
    expect(pnpmCommand(undefined, ['install']).command).toMatch(/^pnpm(?:\.cmd)?$/);
  });

  it('records pnpm only when pnpm ran the build', () => {
    expect(currentToolchain({ npm_execpath: '/x/pnpm/bin/pnpm.cjs' })).toEqual({
      node: process.execPath,
      pnpm: '/x/pnpm/bin/pnpm.cjs',
    });
    expect(currentToolchain({ npm_execpath: 'C:\\tools\\pnpm.exe' }).pnpm).toBe(
      'C:\\tools\\pnpm.exe',
    );
    expect(currentToolchain({ npm_execpath: '/x/npm/bin/npm-cli.js' }).pnpm).toBeNull();
    expect(currentToolchain({}).pnpm).toBeNull();
  });
});
