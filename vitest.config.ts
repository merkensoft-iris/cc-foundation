import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');

/**
 * Two projects: `unit` (unit, integration and fixture tests; pnpm test) and `e2e`
 * (headless-core scenario tests; pnpm e2e). Both block the network (AC-08-01) and resolve
 * @cc/* imports to package sources, so tests never depend on a stale build.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cc\/cli$/, replacement: `${root}apps/cli/src/index.ts` },
      { find: /^@cc\/core\/(client|headless)$/, replacement: `${root}packages/core/src/$1.ts` },
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
          exclude: ['**/*.e2e.test.ts', '**/node_modules/**', '**/dist/**'],
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
    ],
  },
});
