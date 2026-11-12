/**
 * `cc-build build` and the electron-builder configuration (04 §10 rules 1 and 5, ADR 0003
 * decisions 1 and 7, ADR 0004 decisions 1 and 4), on a synthetic engine checkout. Packaging
 * itself is replaced by a packager that records the configuration it was given: Electron
 * packaging for macOS and Windows is a manual check (09 P1-16).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_STAMP, findPackagedApp, INSTALL_STAMP, readBuildStamp } from '@cc/build-runtime';
import { createProfileDir } from '@cc/test-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  builderConfig,
  DESKTOP_MAIN,
  ELECTRON_VERSION,
  electronFuses,
} from '../src/builder-config.js';
import { runBuild, type Packager } from '../src/build.js';
import { ccBuild, ccInstallStamp, ccStart, ccUpgrade, CC_BUILD_USAGE } from '../src/cli.js';
import { readExtensionApi } from '../src/engine-config.js';
import { CC_START_USAGE, parseStartArgs } from '../src/start.js';
import { createEngine, git, write, type EngineFixture } from './engine-fixture.js';

const passingTypecheck = () => Promise.resolve({ ok: true, output: '', ms: 3 });

describe('electron-builder configuration (04 §10 rule 5)', () => {
  const config = builderConfig({
    projectDir: '/engine',
    outDir: '/engine/dist',
    stageDir: '/engine/dist/.stage',
    files: ['cc.config.ts', 'ui/[draft] header.ts', 'package.json'],
  });

  it('flips the five fuses of the design in every build, and packs an asar', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    expect(electronFuses()).toEqual(config.electronFuses);
    expect(config.asar).toBe(true);
  });

  it('packs only the files it is given, each matching only itself, plus the stage', () => {
    expect(config.files).toEqual([
      'package.json',
      'cc.config.ts',
      'ui/\\[draft\\] header.ts',
      { from: '/engine/dist/.stage', to: '.', filter: ['**/*'] },
    ]);
  });

  it('starts the desktop shell, needs no signing certificate, and builds the unpacked app by default', () => {
    expect(config.extraMetadata).toEqual({ main: DESKTOP_MAIN });
    expect(config.publish).toBeNull();
    expect(config.protocols).toEqual([{ name: 'Command Center', schemes: ['commandcenter'] }]);
    expect(config.mac?.target).toEqual(['dir']);
    expect(config.win?.target).toEqual(['dir']);
    const installers = builderConfig({
      projectDir: '/e',
      outDir: '/e/dist',
      stageDir: '/e/s',
      files: [],
      installer: true,
    });
    expect(installers.mac?.target).toEqual(['dmg', 'zip']);
    expect(installers.win?.target).toEqual(['nsis']);
  });

  it('packages the same Electron as @cc/desktop pins, once the shell pins one (P1-10)', () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../apps/desktop/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    const pinned = manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
    if (pinned !== undefined) expect(pinned).toBe(ELECTRON_VERSION);
    expect(ELECTRON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts the app on @cc/desktop's main, which never pulls the build tooling into the app", () => {
    const desktop = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../apps/desktop/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { main: string; dependencies?: Record<string, string> };
    expect(DESKTOP_MAIN).toBe(`node_modules/@cc/desktop/${desktop.main}`);
    // The engine packs @cc/desktop's dependencies into the app; @cc/build stays a dev tool.
    expect(Object.keys(desktop.dependencies ?? {})).not.toContain('@cc/build');
    const runtime = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../build-runtime/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    expect(runtime.dependencies ?? {}).toEqual({});
  });
});

describe('cc-build build', () => {
  let engine: EngineFixture;
  let packaged: { config: Parameters<Packager>[0]; projectDir: string }[];
  const packager: Packager = (config, projectDir) => {
    packaged.push({ config, projectDir });
    return Promise.resolve();
  };

  beforeEach(() => {
    engine = createEngine();
    packaged = [];
  });
  afterEach(() => engine.cleanup());

  it("stamps the build and packages git's view of the tree, never an ignored file (ADR 0004 decisions 1 and 4)", async () => {
    write(engine.root, 'node_modules/dep/index.js', '');
    write(engine.root, 'dist/old-build.txt', '');
    write(engine.root, 'secrets.local', 'ignored by the engine');
    write(engine.root, '.gitignore', 'node_modules/\ndist/\n*.local\n');
    const head = engine.commit('chore: ignore local files');
    write(engine.root, 'ui/untracked-widget.ts', 'export {};\n');

    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      packager,
      now: () => new Date('2026-11-12T09:00:00Z'),
    });
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    expect(packaged).toHaveLength(1);
    const files = packaged[0]?.config.files as unknown[];
    expect(files).toEqual([
      'package.json',
      '.gitignore',
      'cc.config.ts',
      'connectors.lock',
      'pnpm-lock.yaml',
      'theme/tokens.json',
      'tsconfig.json',
      'ui/header.ts',
      'ui/untracked-widget.ts',
      { from: join(engine.root, 'dist', '.stage'), to: '.', filter: ['**/*'] },
    ]);

    const stamp = readBuildStamp(join(engine.root, 'dist', '.stage', BUILD_STAMP));
    expect(stamp).toMatchObject({
      stampVersion: 1,
      commit: head,
      checkout: engine.root,
      clean: false,
      builtAt: '2026-11-12T09:00:00.000Z',
      extensionApi: 1,
      install: { kind: 'checkout' },
    });
    expect(stamp?.dirtyReasons[0]).toBe('uncommitted changes: ui/untracked-widget.ts');
    expect(Object.keys(stamp?.lockfiles ?? {})).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]);
    expect(
      JSON.parse(readFileSync(join(engine.root, 'dist', '.stage', 'cc.config.json'), 'utf8')),
    ).toEqual({
      extensionApi: 1,
      vocabulary: { actionItem: 'Action' },
    });
    expect(result.lines).toContain(
      'cc-build: the tree is not clean (uncommitted changes: ui/untracked-widget.ts); this build will start in developer mode',
    );
  });

  it('type-checks before packaging, and a type error stops the build (ADR 0003 decision 7)', async () => {
    const result = await runBuild({
      root: engine.root,
      typecheck: () =>
        Promise.resolve({ ok: false, output: 'ui/header.ts(1,1): error TS2322', ms: 1 }),
      packager,
    });
    expect(result).toEqual({
      exitCode: 1,
      lines: [
        'cc-build: ui/ has 1 widget file(s) (ui/header.ts); widgets are not built into the app until @cc/ui-sdk/v1 ships (P1-18)',
        'cc-build: type-check failed',
        'ui/header.ts(1,1): error TS2322',
      ],
    });
    expect(packaged).toEqual([]);
    expect(existsSync(join(engine.root, 'dist'))).toBe(false);
  });

  it('refuses a config without extensionApi or with a version the foundation does not build', async () => {
    write(engine.root, 'cc.config.ts', 'export default { vocabulary: {} };\n');
    expect(
      (await runBuild({ root: engine.root, typecheck: passingTypecheck, packager })).lines,
    ).toEqual(['cc-build: cc.config.ts has no extensionApi; add extensionApi: <N> to its config']);
    write(engine.root, 'cc.config.ts', 'export default { extensionApi: 7 };\n');
    const result = await runBuild({ root: engine.root, typecheck: passingTypecheck, packager });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toMatch(
      /^cc-build: cc\.config\.ts: extension API 7 is newer than foundation/,
    );
  });

  it('reports a packaging failure and exits 1', async () => {
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      packager: () => Promise.reject(new Error('no Electron download')),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.at(-1)).toBe('cc-build: packaging failed: no Electron download');
  });

  it('a clean build of a git checkout is stamped clean', async () => {
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      package: false,
    });
    expect(result.exitCode).toBe(0);
    const stamp = readBuildStamp(join(engine.root, 'dist', '.stage', BUILD_STAMP));
    expect(stamp?.clean).toBe(true);
    expect(stamp?.commit).toBe(git(engine.root, 'rev-parse', 'HEAD'));
    expect(git(engine.root, 'status', '--porcelain')).toBe('');
  });
});

describe('readExtensionApi (ADR 0003 decision 1)', () => {
  it.each([
    ['export default { extensionApi: 2 };', { api: 2 }],
    ["export default defineConfig({\n  'extensionApi': 1,\n});", { api: 1 }],
    ['// extensionApi: 9\nexport default { extensionApi: 1 };', { api: 1 }],
    [
      'export default {};',
      { error: 'cc.config.ts has no extensionApi; add extensionApi: <N> to its config' },
    ],
    [
      'export default { extensionApi: API };',
      { error: 'cc.config.ts: extensionApi must be a literal integer (found API)' },
    ],
    [
      'export default { extensionApi: 1, x: { extensionApi: 2 } };',
      { error: 'cc.config.ts sets extensionApi more than once' },
    ],
  ])('%s', (source, expected) => {
    expect(readExtensionApi(source)).toEqual(expected);
  });
});

describe('the engine-facing commands (08 §6 exit codes)', () => {
  it('ships one bin per engine script, the names the cc-engine template runs (tools/cc.ts)', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { bin: Record<string, string> };
    // cc-engine tools/cc.ts COMMANDS: build, start, upgrade, install-stamp (include is P5).
    expect(Object.keys(manifest.bin).sort()).toEqual([
      'cc-build',
      'cc-install-stamp',
      'cc-start',
      'cc-upgrade',
    ]);
    for (const target of Object.values(manifest.bin)) {
      expect(target).toMatch(/^\.\/dist\/bin\/cc-[a-z-]+\.js$/);
      const source = target.replace('./dist/', '../src/').replace(/\.js$/, '.ts');
      expect(existsSync(fileURLToPath(new URL(source, import.meta.url))), source).toBe(true);
    }
  });

  it('cc-build with no command, or with only options, is the build (the engine passes pnpm build arguments through)', async () => {
    const engine = createEngine();
    try {
      write(engine.root, 'cc.config.ts', 'export default { vocabulary: {} };\n');
      const bare = await ccBuild([], engine.root);
      const flagged = await ccBuild(['--no-package'], engine.root);
      for (const result of [bare, flagged]) {
        expect(result).toEqual({
          exitCode: 1,
          lines: [
            'cc-build: cc.config.ts has no extensionApi; add extensionApi: <N> to its config',
          ],
        });
      }
    } finally {
      engine.cleanup();
    }
  });

  it('cc-start passes everything after its own --out to the app (pnpm start --profile-dir <dir>)', async () => {
    expect(parseStartArgs([])).toEqual({ args: [] });
    expect(parseStartArgs(['--profile-dir', '/p', '--smoke'])).toEqual({
      args: ['--profile-dir', '/p', '--smoke'],
    });
    expect(parseStartArgs(['--out', 'out', '--', '--out', 'x'])).toEqual({
      outDir: 'out',
      args: ['--out', 'x'],
    });
    expect(parseStartArgs(['--out=out', 'commandcenter://home'])).toEqual({
      outDir: 'out',
      args: ['commandcenter://home'],
    });
    expect(parseStartArgs(['--out'])).toEqual({ error: 'cc-start: --out needs a directory' });
    expect((await ccStart(['--out'], '/')).exitCode).toBe(2);
    expect(await ccStart(['--help'], '/')).toEqual({ exitCode: 0, lines: [CC_START_USAGE] });
    expect(await ccStart(['--profile-dir', '/p'], '/nowhere')).toEqual({
      exitCode: 1,
      lines: [`cc-start: no packaged app in ${resolve('/nowhere', 'dist')}; run pnpm build first`],
    });
  });

  it('cc-install-stamp is the postinstall: it records the lockfiles and takes no arguments', () => {
    const engine = createEngine();
    try {
      expect(ccInstallStamp([], engine.root).lines[0]).toMatch(
        /^cc-install-stamp: install stamp [0-9a-f]{12}$/,
      );
      expect(existsSync(join(engine.root, INSTALL_STAMP))).toBe(true);
      expect(ccInstallStamp(['--force'], engine.root).exitCode).toBe(2);
    } finally {
      engine.cleanup();
    }
  });

  it('cc-build with an unknown command is a usage error (exit 2)', async () => {
    expect(await ccBuild(['--help'], '/')).toEqual({ exitCode: 0, lines: [CC_BUILD_USAGE] });
    expect(await ccBuild(['publish'], '/')).toEqual({
      exitCode: 2,
      lines: ['cc-build: unknown command publish', CC_BUILD_USAGE],
    });
    expect((await ccBuild(['build', '--bogus'], '/')).exitCode).toBe(2);
    expect((await ccBuild(['build', '--rebuild-of', 'not-a-commit'], '/')).lines[0]).toBe(
      'cc-build: --rebuild-of takes <checkout>@<commit>',
    );
    expect((await ccUpgrade(['--bogus'], '/')).exitCode).toBe(2);
  });

  it('cc-build install-stamp records the lockfiles, and start-check reports the mode', async () => {
    const engine = createEngine();
    try {
      expect((await ccBuild(['install-stamp'], engine.root)).lines[0]).toMatch(
        /^cc-build: install stamp [0-9a-f]{12}$/,
      );
      expect(await ccBuild(['start-check'], engine.root)).toEqual({
        exitCode: 0,
        lines: ['mode: developer (no build stamp: not a packaged build)'],
      });
      expect((await ccBuild(['start'], engine.root)).lines[0]).toMatch(
        /^cc-build start: no packaged app in .*; run pnpm build first$/,
      );
    } finally {
      engine.cleanup();
    }
  });
});

describe('finding the packaged app electron-builder wrote (cc-start, Rebuild now)', () => {
  let dir: ReturnType<typeof createProfileDir>;
  beforeEach(() => (dir = createProfileDir()));
  afterEach(() => dir.cleanup());

  it('finds the executable on macOS whatever the bundle is called, on Windows and on Linux', () => {
    const out = dir.path;
    write(out, 'mac-arm64/command-center.app/Contents/MacOS/command-center', '');
    write(out, 'mac-arm64/command-center.app/Contents/Frameworks/x.app/Contents/MacOS/x', '');
    expect(findPackagedApp(out, 'darwin')).toBe(
      join(out, 'mac-arm64', 'command-center.app', 'Contents', 'MacOS', 'command-center'),
    );
    write(out, 'win-unpacked/command-center.exe', '');
    expect(findPackagedApp(out, 'win32')).toBe(join(out, 'win-unpacked', 'command-center.exe'));
    write(out, 'linux-unpacked/command-center', '');
    expect(findPackagedApp(out, 'linux')).toBe(join(out, 'linux-unpacked', 'command-center'));
    expect(findPackagedApp(join(out, 'nothing'), 'linux')).toBeNull();
  });
});
