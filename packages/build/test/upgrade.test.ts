/**
 * `pnpm cc:upgrade` (08 §6, ADR 0003 decision 6, owner decision D-1) against a fixture
 * foundation at extension API 2 and a fixture engine written against API 1 (N−1). The engine's
 * UI is part of it (ADR 0008 decision 1): a composition root over the fixture `@cc/ui/v1`, and
 * a Home screen it ejected from `@cc/ui` 1.4.0 and edited, which `@cc/ui` 2.0.0 changes too.
 * The type-checks are real: the engine's own `tsc` (the workspace's TypeScript, linked into
 * the fixture's node_modules as `pnpm install` would).
 */
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { runBuild } from '../src/build.js';
import { CODEMODS } from '../src/codemods/index.js';
import { runUiUpdate } from '../src/eject.js';
import type { Foundation } from '../src/foundation.js';
import { runUpgrade } from '../src/upgrade.js';
import { hashTree } from './engine-fixture.js';
import { codemod1to2 } from './upgrade-codemod.js';

/** These tests run the real tsc, which takes seconds when the whole suite runs at once. */
const TSC_TIMEOUT = 60_000;
const fixtures = fileURLToPath(new URL('fixtures/upgrade/', import.meta.url));
const typescriptDir = dirname(
  dirname(createRequire(import.meta.url).resolve('typescript/bin/tsc')),
);

const FOUNDATION_2: Foundation = { version: '2.0.0', api: 2, supported: [1, 2] };
const codemods = [codemod1to2];

let dir: ProfileDir;
let root: string;

/**
 * A copy of the API 1 fixture engine, installed: the fixture @cc/ui-sdk and @cc/ui, and
 * TypeScript. `withUi: false` leaves out its composition root and ejected screen.
 */
function installEngine(options: { withLegend: boolean; withUi?: boolean }): void {
  cpSync(join(fixtures, 'engine-api1'), root, { recursive: true });
  if (!options.withLegend) rmSync(join(root, 'ui', 'legend.ts'));
  if (options.withUi === false) {
    for (const path of ['app.ts', 'screens', '.cc-ui', '.cc-ui.json']) {
      rmSync(join(root, 'ui', path), { recursive: true });
    }
  }
  mkdirSync(join(root, 'node_modules', '@cc'), { recursive: true });
  for (const name of ['ui-sdk', 'ui']) {
    cpSync(join(fixtures, name), join(root, 'node_modules', '@cc', name), { recursive: true });
  }
  symlinkSync(typescriptDir, join(root, 'node_modules', 'typescript'), 'junction');
}

const read = (path: string) => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  dir = createProfileDir();
  root = join(dir.path, 'engine');
});
afterEach(() => dir.cleanup());

describe('cc:upgrade (AC-08-10)', { timeout: TSC_TIMEOUT }, () => {
  it('AC-08-10 a fixture engine written against extension API N-1 builds against the current foundation, and pnpm cc:upgrade moves it to API N with type-checks passing, its UI included', async () => {
    installEngine({ withLegend: false });

    // N−1 builds: config, the engine's type-check and its UI bundle pass, with a deprecation warning.
    const before = await runBuild({ root, checkOnly: true, foundation: FOUNDATION_2 });
    expect(before.exitCode, before.lines.join('\n')).toBe(0);
    expect(before.lines[0]).toBe(
      'cc-build: deprecated: cc.config.ts: extension API 1 is deprecated in foundation 2.0.0 and removed at the next API version; run pnpm cc:upgrade',
    );

    // --check writes nothing, lists the planned edits (the composition root and the ejected
    // Home screen included) and the upstream change to the ejected screen, and exits 1.
    const untouched = hashTree(root);
    const check = await runUpgrade({ root, check: true, foundation: FOUNDATION_2, codemods });
    expect(check.exitCode).toBe(1);
    expect(check.lines).toEqual([
      'cc-upgrade --check: engine on API 1, foundation 2.0.0 is on API 2: 16 edits in 5 files would be made, 0 need a person',
      '  API 1 -> 2: dashboard slots become home slots; tokens are nested and read with token(); createApp takes replace and screens render()',
      '  cc.config.ts: 1 edit',
      '  theme/tokens.json: 2 edits',
      '  ui/app.ts: 2 edits',
      '  ui/header.ts: 7 edits',
      '  ui/screens/home.ts: 4 edits',
      '  run pnpm cc:upgrade locally to apply them (owner decision D-1)',
      '  1 ejected screen changed upstream:',
      '  ejected screen home changed upstream (@cc/ui 1.4.0 -> 2.0.0):',
      '    ui/screens/home.ts: changed upstream (+5 -4 lines); changed here too, merges cleanly',
      '  run pnpm cc:ui-update locally to merge them',
    ]);
    expect(hashTree(root)).toEqual(untouched);

    // The upgrade writes the edits and the engine's type-check passes on API 2.
    const upgrade = await runUpgrade({ root, foundation: FOUNDATION_2, codemods });
    expect(upgrade.exitCode, upgrade.lines.join('\n')).toBe(0);
    expect(upgrade.lines[0]).toMatch(/^cc-upgrade: API 1 -> 2: 16 edits in 5 files \(\d+ ms\)$/);
    expect(upgrade.lines).toContainEqual(
      expect.stringMatching(/^cc-upgrade: type-check passed \(\d+ ms\)$/),
    );
    expect(read('cc.config.ts')).toContain('extensionApi: 2');
    expect(JSON.parse(read('theme/tokens.json'))).toEqual({
      color: { accent: '#0b6e4f' },
      radius: { base: '12px' },
    });
    const header = read('ui/header.ts');
    expect(header).toContain("import { defineWidget, token } from '@cc/ui-sdk/v2';");
    expect(header).toContain("token('color.accent')");
    expect(header).toContain(
      "defineWidget({ slot: 'home.header', title: 'Header', component: Header });",
    );
    expect(header).not.toContain('theme');
    // The UI at API 2: the composition root and the ejected screen, the engine's edit kept.
    expect(read('ui/app.ts')).toContain(
      "import { createApp } from '@cc/ui/v2';\n\nimport { homeScreen } from './screens/home.js';\n\nvoid createApp({ replace: { home: homeScreen } }).start();",
    );
    const home = read('ui/screens/home.ts');
    expect(home).not.toContain('@cc/ui/v1');
    expect(home).toContain('  render: (state) => section(TITLE,');
    expect(home).toContain("const TITLE = 'This week';");

    // The upgraded engine builds against the foundation with no warning.
    const after = await runBuild({ root, checkOnly: true, foundation: FOUNDATION_2 });
    expect(after.exitCode, after.lines.join('\n')).toBe(0);
    expect(after.lines.some((line) => line.includes('deprecated'))).toBe(false);

    // The upstream change to the ejected screen is merged in, and the engine still builds.
    const merged = runUiUpdate({ root, foundation: FOUNDATION_2 });
    expect(merged).toEqual({
      exitCode: 0,
      lines: [
        'cc-ui-update: 1 file merged, 0 with conflicts',
        '  home: @cc/ui 1.4.0 -> 2.0.0',
        '    ui/screens/home.ts: merged',
        '  run pnpm check',
      ],
    });
    expect(read('ui/screens/home.ts')).toBe(
      read('node_modules/@cc/ui/src/screens/home.ts')
        .replace(/'\.\.\/(?:app|ui)\/[a-z]+\.js'/g, "'@cc/ui/v2'")
        .replace("'Today'", "'This week'"),
    );
    const rebuilt = await runBuild({ root, checkOnly: true, foundation: FOUNDATION_2 });
    expect(rebuilt.exitCode, rebuilt.lines.join('\n')).toBe(0);

    // A second run does nothing.
    const again = await runUpgrade({ root, foundation: FOUNDATION_2, codemods });
    expect(again).toEqual({
      exitCode: 0,
      lines: [
        'cc-upgrade: ok  engine already on extension API 2 (foundation 2.0.0); nothing to do',
      ],
    });
    const checkAgain = await runUpgrade({ root, check: true, foundation: FOUNDATION_2, codemods });
    expect(checkAgain.exitCode).toBe(0);
  });

  it('a site the codemod must not guess is marked and listed, stays on the N-1 shim, and the upgrade exits 1', async () => {
    installEngine({ withLegend: true });
    const check = await runUpgrade({ root, check: true, foundation: FOUNDATION_2, codemods });
    expect(check.lines[0]).toBe(
      'cc-upgrade --check: engine on API 1, foundation 2.0.0 is on API 2: 16 edits in 5 files would be made, 1 need a person',
    );
    expect(check.lines).toContain(
      '  needs a person: ui/legend.ts:6 reads the theme with a computed key (theme[k]); use token() with a TokenPath',
    );

    const upgrade = await runUpgrade({ root, foundation: FOUNDATION_2, codemods });
    expect(upgrade.exitCode).toBe(1);
    expect(upgrade.lines).toContain(
      'cc-upgrade: type-check passed (' +
        /\d+/.exec(upgrade.lines.find((l) => l.includes('type-check')) ?? '')?.[0] +
        ' ms)',
    );
    expect(upgrade.lines.at(-1)).toBe('cc-upgrade: 1 site needs a person; see the marks above');
    const legend = read('ui/legend.ts');
    expect(legend).toContain("from '@cc/ui-sdk/v1'");
    expect(legend).toContain(
      '/* cc:upgrade TODO(API 2): reads the theme with a computed key (theme[k]); use token() with a TokenPath */',
    );

    // Until a person finishes it, every later run lists it and exits 1.
    const again = await runUpgrade({ root, foundation: FOUNDATION_2, codemods });
    expect(again.exitCode).toBe(1);
    expect(again.lines).toEqual([
      'cc-upgrade: engine on extension API 2 (foundation 2.0.0); 1 site needs a person',
      '  ui/legend.ts:6 cc:upgrade TODO(API 2): reads the theme with a computed key (theme[k]); use token() with a TokenPath',
      '  1 ejected screen changed upstream:',
      '  ejected screen home changed upstream (@cc/ui 1.4.0 -> 2.0.0):',
      '    ui/screens/home.ts: changed upstream (+5 -4 lines); changed here too, merges cleanly',
      '  run pnpm cc:ui-update locally to merge them',
    ]);
  });

  it('a type error after the codemods fails the upgrade', async () => {
    installEngine({ withLegend: false });
    // A step that moves the import to v2 but leaves the v1 call: tsc must catch it.
    const failing: typeof codemod1to2 = {
      ...codemod1to2,
      run: (context) => {
        for (const file of context.project.getSourceFiles()) {
          file.getImportDeclaration('@cc/ui-sdk/v1')?.setModuleSpecifier('@cc/ui-sdk/v2');
        }
      },
    };
    const upgrade = await runUpgrade({ root, foundation: FOUNDATION_2, codemods: [failing] });
    expect(upgrade.exitCode).toBe(1);
    expect(upgrade.lines.join('\n')).toMatch(/cc-upgrade: type-check failed[\s\S]*error TS/);
  });

  it('says what to do for an engine outside what the foundation can upgrade', async () => {
    installEngine({ withLegend: false });
    const tooNew = await runUpgrade({
      root,
      foundation: { version: '1.4.0', api: 0, supported: [0] },
      codemods,
    });
    expect(tooNew.lines).toEqual([
      'cc-upgrade: engine is on API 1, newer than foundation 1.4.0 (API 0); set extensionApi to 0 or install a newer foundation',
    ]);
    const tooOld = await runUpgrade({
      root,
      foundation: { version: '3.0.0', api: 3, supported: [2, 3] },
      codemods,
    });
    expect(tooOld).toEqual({
      exitCode: 1,
      lines: [
        'cc-upgrade: foundation 3.0.0 has no codemod from API 2 to 3; upgrade one foundation major at a time (supported: 2, 3)',
      ],
    });
    const wrongTo = await runUpgrade({ root, to: '2.1.0', foundation: FOUNDATION_2, codemods });
    expect(wrongTo.exitCode).toBe(1);
    expect(wrongTo.lines[0]).toMatch(
      /^cc-upgrade: the installed foundation is 2\.0\.0, not 2\.1\.0;/,
    );
    const unsupported = await runBuild({
      root,
      checkOnly: true,
      foundation: { version: '3.0.0', api: 3, supported: [2, 3] },
    });
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.lines[0]).toContain(
      'extension API 1 is no longer supported by foundation 3.0.0',
    );
  });

  it('the real foundation is at extension API 1 and ships no codemods yet', async () => {
    installEngine({ withLegend: false, withUi: false });
    expect(CODEMODS).toEqual([]);
    const result = await runUpgrade({ root });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toMatch(
      /^cc-upgrade: ok {2}engine already on extension API 1 \(foundation \d+\.\d+\.\d+.*\); nothing to do$/,
    );
  });
});
