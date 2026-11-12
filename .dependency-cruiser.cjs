'use strict';
/**
 * Dependency rules D1-D7 of docs/design/08-repository-and-automation.md §4.2, run by
 * `pnpm lint` (lint:deps) and in CI. A violation fails the build (C-08-02). Every rule name
 * starts with its rule ID, so the failure names the rule. Syntax-level parts that an
 * import graph cannot see (spawning an AI CLI, clock and randomness, network globals) are
 * in eslint.config.js.
 */
const {
  AI_SDK_PATH_REGEX,
  ANY_INTERNAL,
  PURE_PACKAGES,
  RENDERER_ALLOWED_PACKAGES,
  TEST_CODE,
  internalPackage,
} = require('./scripts/boundaries.cjs');

const RENDERER = '^apps/desktop/src/renderer/';
const PURE = `^packages/(?:${PURE_PACKAGES.join('|')})/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'D1-no-ai-sdk',
      comment:
        'D1: no code in cc-foundation imports an AI SDK. AI code lives only in cc-connectors ' +
        'adapters/ai/*; packages/orchestrator loads adapters through AiProvider (08 §4.2).',
      severity: 'error',
      from: {},
      to: { path: AI_SDK_PATH_REGEX },
    },
    {
      name: 'D2-connectors-no-adapters',
      comment:
        'D2: connectors/* may not import anything under adapters/. Applies to cc-connectors ' +
        'layouts; cc-foundation has no connectors/ or adapters/ directory (08 §4.2).',
      severity: 'error',
      from: { path: '^connectors/' },
      to: { path: '^adapters/' },
    },
    {
      name: 'D2-connectors-no-process-network-files',
      comment:
        'D2: connectors/* may not import Node built-ins for network, files or processes; the ' +
        'host supplies HTTP and the browser (08 §4.2, 05 §12).',
      severity: 'error',
      from: { path: '^connectors/' },
      to: {
        dependencyTypes: ['core'],
        path: '^(?:node:)?(?:child_process|worker_threads|net|tls|dgram|http|https|http2|fs|fs/promises)$',
      },
    },
    {
      name: 'D2-adapters-no-connector-sdk',
      comment: 'D2: adapters may not import @cc/connector-sdk (08 §4.2).',
      severity: 'error',
      from: { path: '^adapters/' },
      to: { path: internalPackage(['connector-sdk']) },
    },
    {
      name: 'D3-renderer-no-node',
      comment:
        'D3: apps/desktop/src/renderer imports no Node built-ins: no files, no network, no ' +
        'processes (08 §4.2, 04 §3 rules 1 and 3).',
      severity: 'error',
      from: { path: RENDERER },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'D3-renderer-only-ui-sdk',
      comment:
        'D3: apps/desktop/src/renderer imports only @cc/ui-sdk, @cc/schemas types and UI ' +
        'libraries, never internal runtime packages or the main and preload processes (08 §4.2).',
      severity: 'error',
      from: { path: RENDERER },
      to: {
        path: ANY_INTERNAL,
        pathNot: [RENDERER, internalPackage(RENDERER_ALLOWED_PACKAGES)],
      },
    },
    {
      name: 'D4-pure-no-io',
      comment:
        'D4: domain, frameworks, rhythm and policy are pure: no Node built-ins (no I/O, clock ' +
        'or randomness). The clock, ID generator and stores are passed in (08 §4.2).',
      severity: 'error',
      from: { path: PURE, pathNot: TEST_CODE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'D4-pure-internal',
      comment:
        'D4: domain, frameworks and policy import only @cc/schemas and other pure packages ' +
        '(08 §4.2).',
      severity: 'error',
      from: { path: '^packages/(?:domain|frameworks|policy)/', pathNot: TEST_CODE },
      to: { path: ANY_INTERNAL, pathNot: internalPackage([...PURE_PACKAGES, 'schemas']) },
    },
    {
      name: 'D4-rhythm-calendar-contract',
      comment:
        'D4: rhythm imports only @cc/schemas, other pure packages and the calendar@1 contract ' +
        'in @cc/connector-sdk; it reaches calendars only through that contract (08 §4.2).',
      severity: 'error',
      from: { path: '^packages/rhythm/', pathNot: TEST_CODE },
      to: {
        path: ANY_INTERNAL,
        pathNot: internalPackage([...PURE_PACKAGES, 'schemas', 'connector-sdk']),
      },
    },
    {
      name: 'D5-store-only-from-core',
      comment: 'D5: only packages/core imports packages/store: one writer (08 §4.2, 03 §12).',
      severity: 'error',
      from: { pathNot: '^packages/(?:core|store)/' },
      to: { path: internalPackage(['store']) },
    },
    {
      name: 'D6-schemas-nothing-internal',
      comment: 'D6: packages/schemas imports nothing internal: no cycles (08 §4.2).',
      severity: 'error',
      from: { path: '^packages/schemas/' },
      to: { path: ANY_INTERNAL, pathNot: '^packages/schemas/' },
    },
    {
      name: 'D7-no-test-code-in-production',
      comment:
        'D7: production code never imports @cc/test-kit or the test keyring, so neither can ' +
        'reach a production build. Headless mode and the test keyring also refuse to start ' +
        'when NODE_ENV=production (08 §4.2).',
      severity: 'error',
      from: { path: '^(?:apps|packages)/[^/]+/src/', pathNot: ['^packages/test-kit/', TEST_CODE] },
      to: { path: [internalPackage(['test-kit']), '(?:^|/)test-keyring(?:[./]|$)'] },
    },
    {
      name: 'no-circular',
      comment: 'No dependency cycles.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(?:^|/)(?:dist|node_modules|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
