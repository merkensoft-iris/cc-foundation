import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');

/**
 * Three projects: `unit` (unit, integration and fixture tests; pnpm test), `e2e`
 * (headless-core scenario tests; pnpm e2e) and `app` (Playwright runs of the human-only screens
 * in the built Electron app; pnpm e2e:app). All block the network (AC-08-01) and resolve @cc/*
 * imports to package sources, so tests never depend on a stale build; the app itself runs from
 * the desktop build, which pnpm e2e:app makes first.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cc\/cli$/, replacement: `${root}apps/cli/src/index.ts` },
      { find: /^@cc\/core\/(client|headless)$/, replacement: `${root}packages/core/src/$1.ts` },
      // Versioned entry points (ADR 0003 decision 2): @cc/ui-sdk/v1.
      { find: /^@cc\/([a-z-]+)\/(v[0-9]+)$/, replacement: `${root}packages/$1/src/$2.ts` },
      { find: /^@cc\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    setupFiles: [`${root}packages/test-kit/src/setup.ts`],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
          exclude: ['**/*.e2e.test.ts', '**/*.app.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['{apps,packages}/*/test/**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'app',
          include: ['apps/desktop/test/app/**/*.app.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // One Electron app at a time: each test starts its own app on its own profile.
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
