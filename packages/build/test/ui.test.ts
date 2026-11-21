/**
 * `cc-build` and the engine's UI (09 P1-25, ADR 0008 decision 1; 08 §4.2 rule D3, ADR 0003
 * decision 8): an engine with an empty `ui/` builds on the default UI; an engine whose
 * composition root replaces one screen is bundled into `cc-ui/` in the app; an import outside
 * the D3 allowlist fails the build, and the check fails closed.
 *
 * The fixture engines are synthetic (AGENTS.md rule 5). `@cc/ui-sdk` is the real UI contract,
 * copied from its sources; `@cc/ui/v1` is a small stand-in for the default UI package that
 * P1-26 publishes, with the composition API ADR 0008 names (`createApp(overrides)`); `tiny-view`
 * stands for a UI library the engine chooses, with a dependency of its own.
 */
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Metafile } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runBuild, type Packager } from '../src/build.js';
import {
  checkUiMetafile,
  ENGINE_UI_DIR,
  engineImportProblem,
  packageOf,
  uiConfigProblems,
} from '../src/ui.js';
import { createEngine, ENGINE_FILES, write, type EngineFixture } from './engine-fixture.js';

const passingTypecheck = () => Promise.resolve({ ok: true, output: '', ms: 3 });
const UI_SDK_SRC = fileURLToPath(new URL('../../ui-sdk/src', import.meta.url));

/** The engine files without the template's old widget file. */
const BASE_FILES = Object.fromEntries(
  Object.entries(ENGINE_FILES).filter(([path]) => path !== 'ui/header.ts'),
);

const CONFIG_WITH_LIBRARY =
  'export default {\n  extensionApi: 1,\n  ui: { libraries: ["tiny-view"] },\n};\n';

/** The composition root over the default UI, with the Home screen replaced. */
const REPLACED_SCREEN: Readonly<Record<string, string>> = {
  'cc.config.ts': CONFIG_WITH_LIBRARY,
  'ui/README.md': '# The UI of this engine\n',
  'ui/app.ts': [
    "import { createApp } from '@cc/ui/v1';",
    "import { home } from './screens/home.js';",
    "import './styles/app.css';",
    '',
    'createApp({ screens: { home } });',
    '',
  ].join('\n'),
  'ui/screens/home.ts': [
    "import type { Screen } from '@cc/ui-sdk/v1';",
    "import { token } from '@cc/ui-sdk/v1';",
    "import { h } from 'tiny-view';",
    '',
    'interface HomeState { readonly title: string }',
    '',
    'export const home: Screen<HomeState, unknown> = {',
    "  load: () => Promise.resolve({ title: 'Our week at a glance' }),",
    "  view: (state) => h('h1', { style: `color: ${token('color.accent')}` }, state.title),",
    '};',
    '',
  ].join('\n'),
  'ui/styles/app.css': 'h1 {\n  font-weight: 650;\n}\n',
};

/** Installed packages, as `pnpm install` leaves them (ignored by git). */
function installPackages(root: string): void {
  cpSync(UI_SDK_SRC, join(root, 'node_modules/@cc/ui-sdk/src'), { recursive: true });
  write(
    root,
    'node_modules/@cc/ui-sdk/package.json',
    JSON.stringify({ name: '@cc/ui-sdk', type: 'module', exports: { './v1': './src/v1.ts' } }),
  );
  write(
    root,
    'node_modules/@cc/ui/package.json',
    JSON.stringify({ name: '@cc/ui', type: 'module', exports: { './v1': './v1.js' } }),
  );
  write(
    root,
    'node_modules/@cc/ui/v1.js',
    [
      "import { createClient } from '@cc/ui-sdk/v1';",
      'const DEFAULT_SCREENS = {',
      "  home: { load: () => Promise.resolve({}), view: () => 'default home' },",
      "  items: { load: () => Promise.resolve({}), view: () => 'default items' },",
      '};',
      'export function createApp(overrides = {}) {',
      '  const screens = { ...DEFAULT_SCREENS, ...overrides.screens };',
      '  return { screens, client: createClient(window.cc) };',
      '}',
      '',
    ].join('\n'),
  );
  for (const [name, source] of [
    [
      'tiny-view',
      "import { el } from 'tiny-view-core';\nexport const h = (t, p, ...c) => el(t, p, c);\n",
    ],
    ['tiny-view-core', 'export const el = (tag, props, children) => ({ tag, props, children });\n'],
    ['left-pad', 'export default (s) => s;\n'],
    ['evil-view', "import '@cc/core';\nexport const h = () => null;\n"],
    ['@cc/core', 'export const openDatabase = () => null;\n'],
    ['@cc/schemas', 'export const SCOPES = [];\n'],
  ] as const) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: 'module', main: 'index.js' }),
    );
    write(root, `node_modules/${name}/index.js`, source);
  }
}

function engineWith(files: Readonly<Record<string, string>>): EngineFixture {
  const engine = createEngine({ ...BASE_FILES, ...files });
  installPackages(engine.root);
  return engine;
}

let engine: EngineFixture | undefined;
afterEach(() => {
  engine?.cleanup();
  engine = undefined;
});

function recordingPackager(): { packager: Packager; runs: number } {
  const state = {
    runs: 0,
    packager: (() => {
      state.runs += 1;
      return Promise.resolve();
    }) as Packager,
  };
  return state;
}

describe('cc-build and the engine UI (09 P1-25, ADR 0008 decision 1)', () => {
  it('AC-08-11 an engine with an empty ui/ builds, and the app runs the default UI', async () => {
    engine = engineWith({ 'ui/README.md': '# Build your own UI here\n' });
    const recorded = recordingPackager();
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      packager: recorded.packager,
    });
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    expect(result.lines).toContain('cc-build: ui/ has no app.ts; the app runs the default UI');
    expect(recorded.runs).toBe(1);
    // No engine UI in the app, so main serves the default UI (apps/desktop app-protocol.ts).
    expect(existsSync(join(engine.root, 'dist', '.stage', ENGINE_UI_DIR))).toBe(false);
  });

  it('builds on the default UI, saying so, when ui/ has source files but no app.ts', async () => {
    engine = engineWith({ 'ui/header.ts': 'export const title = "Header";\n' });
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      package: false,
    });
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    expect(result.lines).toContain(
      'cc-build: ui/ has 1 source file(s) (ui/header.ts) but no app.ts, the composition root; nothing in ui/ is built and the app runs the default UI',
    );
    expect(existsSync(join(engine.root, 'dist', '.stage', ENGINE_UI_DIR))).toBe(false);
  });

  it('AC-08-11 an engine with one replaced screen builds: ui/app.ts is bundled into cc-ui/index.js and cc-ui/app.css', async () => {
    engine = engineWith(REPLACED_SCREEN);
    const recorded = recordingPackager();
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      packager: recorded.packager,
    });
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    expect(recorded.runs).toBe(1);
    const line = result.lines.find((l) => l.startsWith('cc-build: ui/app.ts bundled'));
    expect(line).toMatch(
      /^cc-build: ui\/app\.ts bundled \(3 ui\/ file\(s\), \d+ package file\(s\); index\.js [\d.]+ kB, app\.css [\d.]+ kB\); the app runs the engine's UI$/,
    );
    const dir = join(engine.root, 'dist', '.stage', ENGINE_UI_DIR);
    expect(readdirSync(dir).sort()).toEqual(['app.css', 'index.js']);
    const script = readFileSync(join(dir, 'index.js'), 'utf8');
    // app.ts, the replaced screen and its stylesheet; the default UI's other screens and the
    // contract, in one module.
    expect(script).toContain('Our week at a glance');
    expect(script).toContain('default items');
    expect(script).toContain('function token(');
    expect(script).toContain('// node_modules/tiny-view-core/index.js');
    expect(script).not.toMatch(/\bfrom\s*["']|\bimport\s*\(|\brequire\(/);
    expect(readFileSync(join(dir, 'app.css'), 'utf8')).toContain('font-weight: 650');
  });

  it('`cc-build check` runs the same D3 check, and writes nothing', async () => {
    engine = engineWith(REPLACED_SCREEN);
    const ok = await runBuild({ root: engine.root, typecheck: passingTypecheck, checkOnly: true });
    expect(ok.exitCode, ok.lines.join('\n')).toBe(0);
    expect(ok.lines.some((l) => l.startsWith('cc-build: ui/app.ts bundled'))).toBe(true);
    write(engine.root, 'ui/app.ts', "import 'left-pad';\n");
    const bad = await runBuild({ root: engine.root, typecheck: passingTypecheck, checkOnly: true });
    expect(bad.exitCode).toBe(1);
    expect(existsSync(join(engine.root, 'dist'))).toBe(false);
  });

  describe('D3: an import outside the allowlist fails the build, before anything is packaged', () => {
    // One engine for the refusals below, each run through `cc-build check` (the same bundle and
    // check, writing nothing); one full build shows that a refusal stages and packages nothing.
    const LIBRARIES_CONFIG =
      'export default {\n  extensionApi: 1,\n  ui: { libraries: ["tiny-view", "evil-view"] },\n};\n';
    let shared: EngineFixture;
    beforeAll(() => {
      shared = engineWith({ 'cc.config.ts': LIBRARIES_CONFIG, 'ui/app.ts': 'export {};\n' });
    }, 60_000);
    afterAll(() => shared.cleanup());

    it.each([
      [
        'a foundation runtime package',
        "import { openDatabase } from '@cc/core';\nopenDatabase();\n",
        'cc-build: ui: ui/app.ts: @cc/core is a foundation runtime package; the UI reaches the app only through window.cc (D3)',
      ],
      [
        '@cc/schemas at run time',
        "import { SCOPES } from '@cc/schemas';\nconsole.log(SCOPES);\n",
        'cc-build: ui: ui/app.ts: @cc/schemas is imported at run time; import its types with `import type` (D3)',
      ],
      [
        'a library the engine did not name',
        "import pad from 'left-pad';\nconsole.log(pad('x'));\n",
        'cc-build: ui: ui/app.ts: left-pad is not on the UI import allowlist; name it in cc.config.ts ui.libraries if it is a UI library (D3)',
      ],
      [
        'the UI contract by another version',
        "import { token } from '@cc/ui-sdk/v9';\nconsole.log(token);\n",
        null,
      ],
      [
        'a file outside ui/',
        "import config from '../cc.config.ts';\nconsole.log(config);\n",
        'cc-build: ui: ui/app.ts imports ../cc.config.ts, a file outside ui/ (D3)',
      ],
      [
        'a foundation package through a library',
        "import { h } from 'evil-view';\nconsole.log(h);\n",
        'cc-build: ui: node_modules/evil-view/index.js (in evil-view): @cc/core is a foundation runtime package (D3)',
      ],
    ])('%s', async (_name, source, expected) => {
      write(shared.root, 'ui/app.ts', source);
      const result = await runBuild({
        root: shared.root,
        typecheck: passingTypecheck,
        checkOnly: true,
      });
      expect(result.exitCode).toBe(1);
      if (expected === null) {
        expect(result.lines.join('\n')).toMatch(/@cc\/ui-sdk\/v9/);
      } else {
        expect(result.lines).toContain(expected);
      }
      expect(existsSync(join(shared.root, 'dist'))).toBe(false);
    });

    it('a Node built-in does not bundle for the window', async () => {
      write(
        shared.root,
        'ui/app.ts',
        "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n",
      );
      const result = await runBuild({
        root: shared.root,
        typecheck: passingTypecheck,
        checkOnly: true,
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toMatch(/ui\/app\.ts did not bundle: .*node:fs/);
    });

    it('a refusal stops the full build before anything is staged or packaged', async () => {
      engine = engineWith({
        'cc.config.ts': LIBRARIES_CONFIG,
        'ui/app.ts': "import { h } from 'evil-view';\nconsole.log(h);\n",
      });
      const recorded = recordingPackager();
      const result = await runBuild({
        root: engine.root,
        typecheck: passingTypecheck,
        packager: recorded.packager,
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(
        'cc-build: ui: node_modules/evil-view/index.js (in evil-view): @cc/core is a foundation runtime package (D3)',
      );
      expect(recorded.runs).toBe(0);
      expect(existsSync(join(engine.root, 'dist', '.stage'))).toBe(false);
    });

    it('a file git ignores is never bundled into the app (ADR 0004 decision 4)', async () => {
      engine = engineWith({
        '.gitignore': 'node_modules/\ndist/\n*.local.ts\n',
        'ui/app.ts': "import { secret } from './keys.local.ts';\nconsole.log(secret);\n",
      });
      write(engine.root, 'ui/keys.local.ts', "export const secret = 'not for the app';\n");
      const result = await runBuild({
        root: engine.root,
        typecheck: passingTypecheck,
        package: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(
        "cc-build: ui: ui/keys.local.ts is ignored by git, and the build packs only git's view of the tree (ADR 0004 decision 4)",
      );
    });
  });
});

describe('the D3 metafile check (ADR 0003 decision 8)', () => {
  const allow = { supported: [1], libraries: ['tiny-view'] };
  const input = (imports: Metafile['inputs'][string]['imports']) => ({ bytes: 1, imports });

  it('fails closed when the bundle holds a file the walk from the entry did not reach', () => {
    const metafile: Metafile = {
      inputs: { 'ui/app.ts': input([]), 'ui/elsewhere.ts': input([]) },
      outputs: {
        'cc-ui/index.js': {
          bytes: 2,
          imports: [],
          exports: [],
          inputs: {
            'ui/app.ts': { bytesInOutput: 1 },
            'ui/elsewhere.ts': { bytesInOutput: 1 },
            'node_modules/unknown/index.js': { bytesInOutput: 1 },
          },
        },
      },
    };
    const check = checkUiMetafile(metafile, 'ui/app.ts', allow);
    expect(check.problems).toEqual([
      'the D3 check reached 1 of the 3 bundled files (not ui/elsewhere.ts); it fails closed',
    ]);
  });

  it('refuses an import left outside the bundle and a node: import anywhere', () => {
    const metafile: Metafile = {
      inputs: {
        'ui/app.ts': input([
          {
            path: 'https://cdn.invalid/x.js',
            kind: 'import-statement',
            external: true,
            original: 'https://cdn.invalid/x.js',
          },
          {
            path: 'node_modules/tiny-view/index.js',
            kind: 'import-statement',
            original: 'tiny-view',
          },
        ]),
        'node_modules/tiny-view/index.js': input([
          { path: 'node:fs', kind: 'import-statement', original: 'node:fs' },
        ]),
      },
      outputs: {},
    };
    expect(checkUiMetafile(metafile, 'ui/app.ts', allow).problems).toEqual([
      'ui/app.ts imports https://cdn.invalid/x.js, which is left outside the bundle',
      'node_modules/tiny-view/index.js (in tiny-view) imports the Node built-in node:fs; the window has no Node (D3)',
    ]);
  });

  it('admits the versioned entry points of every API the foundation builds, and listed libraries with their subpaths', () => {
    const both = { supported: [1, 2], libraries: ['tiny-view', '@scope/kit'] };
    for (const ok of [
      '@cc/ui-sdk/v1',
      '@cc/ui/v2',
      'tiny-view',
      'tiny-view/hooks',
      '@scope/kit/x',
    ]) {
      expect(engineImportProblem(ok, both), ok).toBeUndefined();
    }
    for (const bad of [
      '@cc/ui-sdk',
      '@cc/ui/v3',
      '@cc/ui-sdk/host',
      '@cc/store',
      'tiny-viewer',
      '@scope/other',
    ]) {
      expect(engineImportProblem(bad, both), bad).toBeTypeOf('string');
    }
    expect(packageOf('@scope/kit/deep/path')).toBe('@scope/kit');
    expect(packageOf('kit/deep')).toBe('kit');
  });
});

describe('the ui setting in cc.config.ts', () => {
  it('takes a list of npm package names, never a foundation package', () => {
    expect(uiConfigProblems({})).toEqual([]);
    expect(uiConfigProblems({ ui: { libraries: ['preact', '@scope/kit'] } })).toEqual([]);
    expect(uiConfigProblems({ ui: 'preact' })).toEqual([
      'cc.config.ts: ui must be an object, such as { libraries: [] }',
    ]);
    expect(uiConfigProblems({ ui: { libraries: 'preact', layout: 1 } })).toEqual([
      'cc.config.ts: ui.layout is not a setting (the UI settings are: libraries)',
      'cc.config.ts: ui.libraries must be a list of package names',
    ]);
    expect(uiConfigProblems({ ui: { libraries: ['Not A Name', '@cc/core'] } })).toEqual([
      'cc.config.ts: ui.libraries: Not A Name is not an npm package name',
      'cc.config.ts: ui.libraries: @cc/core is a foundation package; a UI imports @cc/ui-sdk/v<N> and @cc/ui/v<N> without listing them, and nothing else of the foundation (D3)',
    ]);
  });

  it('fails the build when it is wrong', async () => {
    engine = engineWith({
      'cc.config.ts': 'export default { extensionApi: 1, ui: { libraries: ["@cc/core"] } };\n',
    });
    const result = await runBuild({
      root: engine.root,
      typecheck: passingTypecheck,
      package: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toMatch(
      /^cc-build: cc\.config\.ts: ui\.libraries: @cc\/core is a foundation package/,
    );
  });
});
