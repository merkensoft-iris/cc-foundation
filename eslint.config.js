/**
 * ESLint: TypeScript rules plus the syntax-level parts of dependency rules D1, D3 and D4
 * (docs/design/08-repository-and-automation.md §4.2). The import-graph parts of D1-D7 are in
 * .dependency-cruiser.cjs. Inline eslint-disable comments are not honoured anywhere, so
 * no rule can be switched off in code (C-08-02).
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import boundaries from './scripts/boundaries.cjs';

const { AI_CLIS, AI_SDK_IMPORT_REGEX, PURE_PACKAGES } = boundaries;

const D1_IMPORT = {
  regex: AI_SDK_IMPORT_REGEX,
  message:
    'D1: no AI SDK in cc-foundation. AI code lives only in cc-connectors adapters/ai/*; ' +
    'packages/orchestrator loads adapters through AiProvider (08 §4.2).',
};

// ADR 0001 decision 1 and follow-up 1: one Temporal per process, imported only by
// packages/schemas/src/temporal.ts (everything else imports it from @cc/schemas), and
// rrule-temporal only in packages/rhythm/src/expand.ts (tests may use it as a differential oracle).
const TEMPORAL_FILE = 'packages/schemas/src/temporal.ts';
const RRULE_FILE = 'packages/rhythm/src/expand.ts';
const TEMPORAL_IMPORT = {
  regex: '^(?:temporal-polyfill|@js-temporal/polyfill)(?:/|$)',
  message:
    'ADR 0001 decision 1: import Temporal from @cc/schemas; only packages/schemas/src/temporal.ts imports the polyfill.',
};
const RRULE_IMPORT = {
  regex: '^rrule-temporal(?:/|$)',
  message:
    'ADR 0001 follow-up 1: only packages/rhythm/src/expand.ts imports rrule-temporal, always with temporal: Temporal.',
};

const SPAWN_FUNCTIONS =
  '/^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|execaSync)$/';
const AI_CLI_COMMAND = `/^(?:${AI_CLIS.join('|')})(?:\\s|$)/`;
const D1_SPAWN = [
  {
    selector: `CallExpression:matches([callee.name=${SPAWN_FUNCTIONS}], [callee.property.name=${SPAWN_FUNCTIONS}]) > Literal.arguments:first-child[value=${AI_CLI_COMMAND}]`,
    message: `D1: no package in cc-foundation starts an AI CLI (${AI_CLIS.join(', ')}). AI CLIs run only in cc-connectors adapters/ai/* (08 §4.2).`,
  },
];

const D3_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'require',
  'process',
].map((name) => ({
  name,
  message: `D3: the renderer has no network and no Node access (${name}); it talks to the app only through window.cc.invoke (08 §4.2, 04 §3).`,
}));

const D4_MESSAGE =
  'D4: pure packages have no I/O, no clock and no randomness; pass the clock, ID generator and stores in (08 §4.2).';
const D4_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'crypto',
  'performance',
  'process',
  'setTimeout',
  'setInterval',
  'setImmediate',
].map((name) => ({ name, message: `${D4_MESSAGE} (${name})` }));
const D4_PROPERTIES = [
  { object: 'Date', property: 'now' },
  { object: 'Math', property: 'random' },
].map((entry) => ({ ...entry, message: `${D4_MESSAGE} (${entry.object}.${entry.property})` }));
const D4_SYNTAX = [
  {
    selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
    message: `${D4_MESSAGE} (new Date())`,
  },
  { selector: 'CallExpression[callee.name="Date"]', message: `${D4_MESSAGE} (Date())` },
];

// packages/frameworks/validators/ is source too (01 §4, 08 §4.1).
const PURE_SOURCES = PURE_PACKAGES.flatMap((name) => [
  `packages/${name}/src/**`,
  `packages/${name}/validators/**`,
]);
const TESTS = ['**/test/**', '**/*.test.ts'];

export default defineConfig(
  { ignores: ['**/dist/', '**/node_modules/', 'coverage/'] },
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // A sandboxed Electron preload is CommonJS and can reach Electron only through `require`
  // (04 §3; apps/desktop/src/preload/index.cts).
  {
    files: ['apps/desktop/src/preload/**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // D1, both halves, everywhere in the repository's code; the ADR 0001 single imports.
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: [D1_IMPORT, TEMPORAL_IMPORT, RRULE_IMPORT] }],
    },
  },
  {
    files: [TEMPORAL_FILE],
    rules: { 'no-restricted-imports': ['error', { patterns: [D1_IMPORT, RRULE_IMPORT] }] },
  },
  {
    files: [RRULE_FILE, ...TESTS],
    rules: { 'no-restricted-imports': ['error', { patterns: [D1_IMPORT, TEMPORAL_IMPORT] }] },
  },
  { files: ['apps/**', 'packages/**'], rules: { 'no-restricted-syntax': ['error', ...D1_SPAWN] } },
  // D3: the renderer.
  {
    files: ['apps/desktop/src/renderer/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'no-restricted-globals': ['error', ...D3_GLOBALS] },
  },
  // D4: pure packages. Tests may use the clock (they get it from @cc/test-kit).
  {
    files: PURE_SOURCES,
    ignores: TESTS,
    rules: {
      'no-restricted-globals': ['error', ...D4_GLOBALS],
      'no-restricted-properties': ['error', ...D4_PROPERTIES],
      'no-restricted-syntax': ['error', ...D1_SPAWN, ...D4_SYNTAX],
    },
  },
  prettier,
);
