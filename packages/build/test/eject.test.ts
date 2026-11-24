/**
 * Ejected screens (09 P1-27, ADR 0008 decision 1; 08 §6 `cc:eject`, `cc:ui-update`,
 * `cc:upgrade --check`) against the real default UI, `@cc/ui`, installed in a fixture engine
 * from this workspace. A new upstream release is the installed copy with a screen's source
 * edited and its version raised, as a dependency PR would bring it.
 *
 * The engine's type-check and the D3 bundle check are the real ones (`cc-build check`), so an
 * ejected screen is proven to compile against `@cc/ui/v1` and to pass the import allowlist.
 * The fixture engine is synthetic (AGENTS.md rule 5).
 */
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256 } from '@cc/build-runtime';

import { runBuild } from '../src/build.js';
import { ccEject, ccUiUpdate } from '../src/cli.js';
import { runUpgrade } from '../src/upgrade.js';
import {
  createEngine,
  ENGINE_FILES,
  hashTree,
  write,
  type EngineFixture,
} from './engine-fixture.js';

/** The real type-check of a fixture engine with every default screen takes seconds. */
const TSC_TIMEOUT = 120_000;
const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const typescriptDir = dirname(
  dirname(createRequire(import.meta.url).resolve('typescript/bin/tsc')),
);

const ENGINE_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2022',
      lib: ['es2024', 'dom'],
      types: [],
      skipLibCheck: true,
    },
    include: ['cc.config.ts', 'ui'],
  },
  null,
  2,
)}\n`;

/** The composition root over the default UI with the named screens replaced by ejected copies. */
function appWith(...screens: string[]): string {
  return [
    "import { createApp } from '@cc/ui/v1';",
    '',
    ...screens.map((screen) => `import { ${screen}Screen } from './screens/${screen}.js';`),
    '',
    `void createApp({ screens: { ${screens.map((s) => `${s}: ${s}Screen`).join(', ')} } }).start();`,
    '',
  ].join('\n');
}

const BASE_FILES = Object.fromEntries(
  Object.entries(ENGINE_FILES).filter(([path]) => path !== 'ui/header.ts'),
);

let engine: EngineFixture | undefined;
afterEach(() => {
  engine?.cleanup();
  engine = undefined;
});

/**
 * A committed fixture engine with `@cc/ui` installed at `version`: a copy of the workspace's
 * package (its sources, its built types and its stylesheet), and the packages its types name
 * linked as pnpm links them.
 */
function engineWithDefaultUi(files: Readonly<Record<string, string>> = {}): EngineFixture {
  const fixture = createEngine({
    ...BASE_FILES,
    'tsconfig.json': ENGINE_TSCONFIG,
    'ui/README.md': '# The UI of this engine\n',
    ...files,
  });
  const ui = join(fixture.root, 'node_modules/@cc/ui');
  for (const part of ['src', 'dist', 'styles']) {
    cpSync(join(PACKAGES, 'ui', part), join(ui, part), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(PACKAGES, 'ui/package.json'), 'utf8')) as object;
  write(
    fixture.root,
    'node_modules/@cc/ui/package.json',
    JSON.stringify({ ...manifest, version: '1.0.0' }),
  );
  for (const name of ['ui-sdk', 'schemas']) {
    symlinkSync(join(PACKAGES, name), join(fixture.root, 'node_modules/@cc', name), 'junction');
  }
  symlinkSync(typescriptDir, join(fixture.root, 'node_modules/typescript'), 'junction');
  return fixture;
}

/** A new release of `@cc/ui` in the engine: `edit` applied to one screen file, version raised. */
function release(
  root: string,
  version: string,
  path: string,
  edit: (text: string) => string,
): void {
  const file = join(root, 'node_modules/@cc/ui/src', path);
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
  const manifestPath = join(root, 'node_modules/@cc/ui/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as object;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }));
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (root: string, path: string) => JSON.parse(read(root, path)) as unknown;

/** An edit that must change the text. */
const replace = (from: string, to: string) => (text: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

async function check(root: string): Promise<void> {
  const result = await runBuild({ root, checkOnly: true });
  expect(result.exitCode, result.lines.join('\n')).toBe(0);
  expect(result.lines.join('\n')).toMatch(
    /cc-build: type-check passed[\s\S]*cc-build: ui\/app\.ts bundled/,
  );
}

describe('ejected screens (AC-08-10, ADR 0008 decision 1)', { timeout: TSC_TIMEOUT }, () => {
  it('AC-08-10 cc:eject copies a default screen into ui/ and records it; cc:upgrade --check lists a changed upstream screen for the ejected copy; cc:ui-update merges it', async () => {
    engine = engineWithDefaultUi({ 'ui/app.ts': appWith('home') });
    const { root } = engine;

    // cc:eject: the source, its imports of the default UI's own modules on @cc/ui/v1.
    const ejected = ccEject(['home'], root);
    expect(ejected).toEqual({
      exitCode: 0,
      lines: [
        'cc-eject: home ejected from @cc/ui 1.0.0 (1 file); recorded in ui/.cc-ui.json',
        '  ui/screens/home.ts',
        "  use it in ui/app.ts: import { homeScreen } from './screens/home.js'; createApp({ screens: { home: homeScreen } })",
        '  pnpm cc:upgrade --check lists upstream changes to it; pnpm cc:ui-update merges them',
      ],
    });
    const upstream = read(root, 'node_modules/@cc/ui/src/screens/home.ts');
    const copy = read(root, 'ui/screens/home.ts');
    expect(copy).toContain("import type { HomeResult } from '@cc/ui/v1';");
    expect(copy).toContain("import { h, type VNode } from '@cc/ui/v1';");
    expect(copy).not.toMatch(/from '\.\.?\//);
    expect(copy.replaceAll("'@cc/ui/v1'", '')).toBe(
      upstream.replace(/'\.\.\/(?:app|ui)\/[a-z-]+\.js'/g, ''),
    );
    expect(readJson(root, 'ui/.cc-ui.json')).toEqual({
      $comment: expect.stringContaining('Do not edit') as unknown,
      screens: {
        home: { version: '1.0.0', api: 1, files: { 'ui/screens/home.ts': sha256(upstream) } },
      },
    });
    expect(read(root, 'ui/.cc-ui/base/screens/home.ts.base')).toBe(upstream);
    // The copy compiles against @cc/ui/v1 and passes D3; nothing has changed upstream.
    await check(root);
    expect(await runUpgrade({ root, check: true })).toEqual({
      exitCode: 0,
      lines: [
        expect.stringMatching(
          /^cc-upgrade --check: ok {2}engine already on extension API 1 /,
        ) as unknown,
      ],
    });
    engine.commit('feat: eject the Home screen');

    // A dependency PR brings @cc/ui 1.1.0, which changes the Home screen.
    release(
      root,
      '1.1.0',
      'screens/home.ts',
      replace("'No meetings today.'", "'No meetings today. Enjoy the quiet.'"),
    );
    const untouched = hashTree(root);
    const due = await runUpgrade({ root, check: true });
    expect(due).toEqual({
      exitCode: 1,
      lines: [
        expect.stringMatching(
          /^cc-upgrade --check: engine on extension API 1 \(foundation .+\); 1 ejected screen changed upstream$/,
        ) as unknown,
        '  ejected screen home changed upstream (@cc/ui 1.0.0 -> 1.1.0):',
        '    ui/screens/home.ts: changed upstream (+1 -1 lines); unchanged here, so taken as it is',
        '  run pnpm cc:ui-update locally to merge them',
      ],
    });
    // --check wrote nothing.
    expect(hashTree(root)).toEqual(untouched);

    // The engine changed its copy elsewhere: the merge keeps both changes.
    write(
      root,
      'ui/screens/home.ts',
      replace("'Nothing is due in the next seven days.'", "'Nothing due this week.'")(copy),
    );
    const predicted = await runUpgrade({ root, check: true });
    expect(predicted.lines[2]).toBe(
      '    ui/screens/home.ts: changed upstream (+1 -1 lines); changed here too, merges cleanly',
    );
    const updated = ccUiUpdate([], root);
    expect(updated).toEqual({
      exitCode: 0,
      lines: [
        'cc-ui-update: 1 file merged, 0 with conflicts',
        '  home: @cc/ui 1.0.0 -> 1.1.0',
        '    ui/screens/home.ts: merged',
        '  run pnpm check',
      ],
    });
    const merged = read(root, 'ui/screens/home.ts');
    expect(merged).toContain("'No meetings today. Enjoy the quiet.'");
    expect(merged).toContain("'Nothing due this week.'");
    const newUpstream = read(root, 'node_modules/@cc/ui/src/screens/home.ts');
    expect(readJson(root, 'ui/.cc-ui.json')).toMatchObject({
      screens: {
        home: { version: '1.1.0', api: 1, files: { 'ui/screens/home.ts': sha256(newUpstream) } },
      },
    });
    expect(read(root, 'ui/.cc-ui/base/screens/home.ts.base')).toBe(newUpstream);
    await check(root);
    expect((await runUpgrade({ root, check: true })).exitCode).toBe(0);
    expect(ccUiUpdate([], root)).toEqual({
      exitCode: 0,
      lines: ['cc-ui-update: ok  1 ejected screen match @cc/ui 1.1.0; nothing to do'],
    });
  });

  it('a change both sides made to the same lines is left marked for a person, and cc:upgrade lists it until resolved', async () => {
    engine = engineWithDefaultUi({ 'ui/app.ts': appWith('home') });
    const { root } = engine;
    expect(ccEject(['home'], root).exitCode).toBe(0);
    const copy = read(root, 'ui/screens/home.ts');
    write(root, 'ui/screens/home.ts', replace("'No meetings today.'", "'A free day.'")(copy));
    release(
      root,
      '1.1.0',
      'screens/home.ts',
      replace("'No meetings today.'", "'No meetings today. Enjoy the quiet.'"),
    );

    const predicted = await runUpgrade({ root, check: true });
    expect(predicted.exitCode).toBe(1);
    expect(predicted.lines).toContain(
      '    ui/screens/home.ts: changed upstream (+1 -1 lines); changed here too, merges with 1 conflict for a person',
    );

    const updated = ccUiUpdate(['home'], root);
    expect(updated.exitCode).toBe(1);
    const marked = read(root, 'ui/screens/home.ts');
    const line = marked.split('\n').indexOf('<<<<<<< ui/screens/home.ts (yours)') + 1;
    expect(line).toBeGreaterThan(0);
    expect(updated.lines).toEqual([
      'cc-ui-update: 0 files merged, 1 with conflicts; 1 conflict left for a person',
      '  home: @cc/ui 1.0.0 -> 1.1.0',
      `    ui/screens/home.ts: 1 conflict at line ${String(line)}; resolve the <<<<<<< marks`,
      `  ui/screens/home.ts:${String(line)} has an unresolved merge from cc:ui-update; resolve it`,
      '  resolve them, then run pnpm check',
    ]);
    expect(marked).toContain(
      "||||||| @cc/ui 1.0.0\n          ? h('p', { class: 'empty' }, 'No meetings today.')",
    );
    expect(marked).toContain('>>>>>>> @cc/ui 1.1.0');

    // Until a person resolves it, cc:upgrade lists it and exits 1, with or without --check.
    for (const checkOnly of [true, false]) {
      const listed = await runUpgrade({ root, check: checkOnly });
      expect(listed.exitCode).toBe(1);
      expect(listed.lines).toContain(
        `  ui/screens/home.ts:${String(line)} has an unresolved merge from cc:ui-update; resolve it`,
      );
    }
    // The person keeps their text.
    write(
      root,
      'ui/screens/home.ts',
      marked.replace(/<<<<<<< [^\n]*\n([^\n]*\n)\|{7}[\s\S]*?>>>>>>> [^\n]*\n/, '$1'),
    );
    expect(read(root, 'ui/screens/home.ts')).toContain("'A free day.'");
    await check(root);
    expect((await runUpgrade({ root, check: true })).exitCode).toBe(0);
  });

  it('a module the screen starts to use upstream is added, and one it stops using is left to the engine', async () => {
    engine = engineWithDefaultUi({ 'ui/app.ts': appWith('settings') });
    const { root } = engine;
    const ejected = ccEject(['settings'], root);
    expect(ejected.lines.slice(0, 5)).toEqual([
      'cc-eject: settings ejected from @cc/ui 1.0.0 (4 files); recorded in ui/.cc-ui.json',
      '  ui/screens/settings-agents.ts',
      '  ui/screens/settings-backups.ts',
      '  ui/screens/settings-parts.ts',
      '  ui/screens/settings.ts',
    ]);
    await check(root);

    // Upstream 1.1.0: Settings stops importing settings-backups.ts and starts using a new module.
    const ui = join(root, 'node_modules/@cc/ui/src/screens');
    writeFileSync(
      join(ui, 'settings-note.ts'),
      "export const NOTE = 'Settings are saved on this device.';\n",
    );
    release(
      root,
      '1.1.0',
      'screens/settings.ts',
      (text) =>
        `import { NOTE } from './settings-note.js';\n${text.replace(
          /^import \{[^}]*\} from '\.\/settings-backups\.js';\n/m,
          '',
        )}\nexport const SETTINGS_NOTE = NOTE;\n`,
    );
    const due = await runUpgrade({ root, check: true });
    expect(due.lines).toEqual(
      expect.arrayContaining([
        '  ejected screen settings changed upstream (@cc/ui 1.0.0 -> 1.1.0):',
        expect.stringMatching(
          /^ {4}ui\/screens\/settings\.ts: changed upstream \(\+\d+ -\d+ lines\); unchanged here, so taken as it is$/,
        ) as unknown,
        '    ui/screens/settings-backups.ts: removed upstream; your copy stays',
        '    ui/screens/settings-note.ts: added upstream (+1 -0 lines); new here, so taken as it is',
      ]),
    );
    const updated = ccUiUpdate([], root);
    expect(updated.lines).toEqual([
      'cc-ui-update: 2 files merged, 0 with conflicts',
      '  settings: @cc/ui 1.0.0 -> 1.1.0',
      '    ui/screens/settings-backups.ts: removed upstream; your copy stays and is no longer tracked',
      '    ui/screens/settings-note.ts: added',
      '    ui/screens/settings.ts: updated (unchanged here)',
      '  run pnpm check',
    ]);
    expect(read(root, 'ui/screens/settings-note.ts')).toBe(
      read(root, 'node_modules/@cc/ui/src/screens/settings-note.ts'),
    );
    expect(existsSync(join(root, 'ui/screens/settings-backups.ts'))).toBe(true);
    expect(existsSync(join(root, 'ui/.cc-ui/base/screens/settings-backups.ts.base'))).toBe(false);
    expect(
      Object.keys(
        (readJson(root, 'ui/.cc-ui.json') as { screens: { settings: { files: object } } }).screens
          .settings.files,
      ),
    ).toEqual([
      'ui/screens/settings-agents.ts',
      'ui/screens/settings-note.ts',
      'ui/screens/settings-parts.ts',
      'ui/screens/settings.ts',
    ]);
  });

  it('every default screen ejects into a copy that compiles against @cc/ui/v1 and passes D3', async () => {
    const screens = [
      'decisions',
      'home',
      'issues',
      'items',
      'meetings',
      'onboarding',
      'scorecard',
      'settings',
    ];
    engine = engineWithDefaultUi({ 'ui/app.ts': appWith(...screens) });
    const { root } = engine;
    for (const screen of screens) {
      const result = ccEject([screen], root);
      expect(result.exitCode, result.lines.join('\n')).toBe(0);
    }
    expect(ccEject(['onboarding'], root).exitCode).toBe(1);
    const manifest = readJson(root, 'ui/.cc-ui.json') as { screens: Record<string, unknown> };
    expect(Object.keys(manifest.screens)).toEqual(screens);
    await check(root);
  });

  it('says what is wrong with a screen it cannot eject or update', () => {
    engine = engineWithDefaultUi();
    const { root } = engine;
    expect(ccEject([], root).exitCode).toBe(2);
    expect(ccEject(['dashboard'], root)).toEqual({
      exitCode: 2,
      lines: [
        'cc-eject: dashboard is not a default screen of @cc/ui 1.0.0 (screens: decisions, home, issues, items, meetings, onboarding, scorecard, settings)',
      ],
    });
    // A file of the screen the engine already has is never overwritten.
    write(root, 'ui/screens/home.ts', 'export const homeScreen = {};\n');
    expect(ccEject(['home'], root)).toEqual({
      exitCode: 1,
      lines: [
        'cc-eject: 1 file of home already exists in the engine; move it away first',
        '  ui/screens/home.ts',
      ],
    });
    expect(existsSync(join(root, 'ui/.cc-ui.json'))).toBe(false);
    expect(ccEject(['issues'], root).exitCode).toBe(0);
    expect(ccEject(['issues'], root)).toEqual({
      exitCode: 1,
      lines: [
        'cc-eject: issues is already ejected (from @cc/ui 1.0.0); pnpm cc:ui-update merges upstream changes into it',
      ],
    });
    expect(ccUiUpdate(['home'], root)).toEqual({
      exitCode: 2,
      lines: ['cc-ui-update: not ejected: home (ejected: issues)'],
    });
    expect(ccUiUpdate(['--check'], root).exitCode).toBe(2);
    write(root, 'ui/.cc-ui.json', '{ "screens": [] }\n');
    expect(ccUiUpdate([], root)).toEqual({
      exitCode: 1,
      lines: ['cc-ui-update: ui/.cc-ui.json has no screens object'],
    });
  });
});
