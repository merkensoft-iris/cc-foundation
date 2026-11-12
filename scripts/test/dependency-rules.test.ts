/**
 * Dependency rules D1-D7 (08 §4.2): each rule fires on a violating import, names its rule,
 * and stays quiet on the imports the design allows. The import-graph rules run
 * dependency-cruiser on a throwaway tree laid out like this repository; the syntax rules run
 * ESLint on virtual files at real paths.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

const root = fileURLToPath(new URL('../..', import.meta.url));
const config = createRequire(import.meta.url)('../../.dependency-cruiser.cjs') as IConfiguration;

const workDirs: Array<{ cleanup(): void }> = [];
afterAll(() => workDirs.forEach((dir) => dir.cleanup()));

/** Writes `files` into a fresh tree and returns the names of the rules they violate. */
async function violations(files: Record<string, string>): Promise<string[]> {
  const dir = createProfileDir();
  workDirs.push(dir);
  // Cruise from the real path: on macOS /tmp is a symlink to /private/tmp, and resolved
  // imports would otherwise fall outside baseDir.
  const base = realpathSync(dir.path);
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), code);
  }
  const result = await cruise(
    ['apps', 'packages'].filter((top) => Object.keys(files).some((f) => f.startsWith(`${top}/`))),
    {
      baseDir: base,
      validate: true,
      ruleSet: { forbidden: config.forbidden ?? [] },
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
    },
  );
  const output = result.output as ICruiseResult;
  return [...new Set(output.summary.violations.map((violation) => violation.rule.name))].sort();
}

describe('dependency-cruiser rules', () => {
  it('AC-08-02 an @anthropic-ai/sdk import in packages/core fails, naming D1', async () => {
    expect(
      await violations({
        'packages/core/src/index.ts':
          "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
      }),
    ).toEqual(['D1-no-ai-sdk']);
  });

  it('AC-08-02 an @anthropic-ai/sdk import in packages/orchestrator fails, naming D1', async () => {
    expect(
      await violations({
        'packages/orchestrator/src/index.ts': "export { default } from '@anthropic-ai/sdk';\n",
      }),
    ).toEqual(['D1-no-ai-sdk']);
  });

  it('D1 also catches require() and dynamic import() of other AI SDKs', async () => {
    expect(
      await violations({
        'packages/core/src/index.ts':
          "import { createRequire } from 'node:module';\n" +
          "export const o = createRequire(import.meta.url)('openai');\n" +
          "export const l = () => import('@langchain/core');\n",
      }),
    ).toEqual(['D1-no-ai-sdk']);
  });

  const cases: Array<[rule: string, file: string, code: string]> = [
    [
      'D3-renderer-no-node',
      'apps/desktop/src/renderer/index.ts',
      "export { readFileSync } from 'node:fs';\n",
    ],
    [
      'D3-renderer-only-ui-sdk',
      'apps/desktop/src/renderer/index.ts',
      "export * from '@cc/core';\n",
    ],
    [
      'D3-renderer-only-ui-sdk',
      'apps/desktop/src/renderer/index.ts',
      "export * from '../main/index.ts';\n",
    ],
    [
      'D4-pure-no-io',
      'packages/rhythm/src/index.ts',
      "export { randomUUID } from 'node:crypto';\n",
    ],
    ['D4-pure-internal', 'packages/domain/src/index.ts', "export * from '@cc/connector-sdk';\n"],
    [
      'D4-rhythm-calendar-contract',
      'packages/rhythm/src/index.ts',
      "export * from '@cc/connector-host';\n",
    ],
    [
      'D5-store-only-from-core',
      'packages/orchestrator/src/index.ts',
      "export * from '@cc/store';\n",
    ],
    [
      'D5-store-only-from-core',
      'packages/connector-host/src/index.ts',
      "export * from '../../store/src/index.ts';\n",
    ],
    [
      'D6-schemas-nothing-internal',
      'packages/schemas/src/index.ts',
      "export * from '@cc/ui-sdk';\n",
    ],
    [
      'D7-no-test-code-in-production',
      'packages/core/src/index.ts',
      "export * from '@cc/test-kit';\n",
    ],
    [
      'D7-no-test-code-in-production',
      'packages/core/src/index.ts',
      "export * from './test-keyring.ts';\n",
    ],
  ];
  it.each(cases)('%s fires for %s', async (rule, file, code) => {
    expect(
      await violations({
        [file]: code,
        'apps/desktop/src/main/index.ts': 'export {};\n',
        'packages/store/src/index.ts': 'export {};\n',
        'packages/core/src/test-keyring.ts': 'export {};\n',
      }),
    ).toContain(rule);
  });

  it('allows what the design allows', async () => {
    expect(
      await violations({
        'packages/core/src/index.ts': "export * from '@cc/store';\nexport * from '@cc/domain';\n",
        'packages/core/test/core.test.ts': "export * from '@cc/test-kit';\n",
        'packages/rhythm/src/index.ts':
          "export * from '@cc/connector-sdk';\nexport * from '@cc/schemas';\n",
        'packages/rhythm/test/rhythm.test.ts': "export { readFileSync } from 'node:fs';\n",
        'packages/domain/src/index.ts':
          "export * from '@cc/schemas';\nexport * from '@cc/policy';\n",
        'apps/desktop/src/renderer/index.ts':
          "export * from '@cc/ui-sdk';\nexport type * from '@cc/schemas';\n",
        'packages/test-kit/src/index.ts': "export { readFileSync } from 'node:fs';\n",
      }),
    ).toEqual([]);
  });
});

describe('ESLint rules', () => {
  const eslint = new ESLint({ cwd: root });

  async function messages(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(root, file) });
    return (result?.messages ?? []).map((message) => message.message);
  }

  for (const pkg of ['core', 'orchestrator']) {
    it(`AC-08-02 an @anthropic-ai/sdk import in packages/${pkg} fails pnpm lint, naming D1`, async () => {
      const found = await messages(
        `packages/${pkg}/src/probe.ts`,
        "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n",
      );
      expect(found).toEqual([
        expect.stringMatching(/^'@anthropic-ai\/sdk' import is restricted .*D1: /),
      ]);
    });
  }

  it('D1 an eslint-disable comment does not switch the rule off (C-08-02)', async () => {
    const found = await messages(
      'packages/core/src/probe.ts',
      "// eslint-disable-next-line no-restricted-imports\nimport OpenAI from 'openai';\nexport const o = OpenAI;\n",
    );
    expect(found).toContainEqual(expect.stringContaining('D1: '));
  });

  it('D1 starting the claude or codex CLI from a package fails', async () => {
    const found = await messages(
      'packages/orchestrator/src/probe.ts',
      "import childProcess, { spawn } from 'node:child_process';\n" +
        "spawn('claude', ['-p']);\n" +
        "childProcess.execFile('codex', ['exec']);\n",
    );
    expect(found.filter((message) => message.startsWith('D1: '))).toHaveLength(2);
  });

  it('D3 the renderer may not use the network', async () => {
    const found = await messages(
      'apps/desktop/src/renderer/probe.ts',
      "export const r = fetch('/x');\n",
    );
    expect(found).toEqual([expect.stringContaining('D3: ')]);
  });

  it('D4 pure packages may not read the clock or randomness', async () => {
    const found = await messages(
      'packages/rhythm/src/probe.ts',
      'export const a = Date.now();\nexport const b = Math.random();\nexport const c = new Date();\n' +
        'export const d = crypto.randomUUID();\n',
    );
    expect(found).toHaveLength(4);
    expect(found.every((message) => message.includes('D4: '))).toBe(true);
  });

  it('D4 tests of pure packages may use the clock, and a fixed date is pure', async () => {
    expect(
      await messages('packages/rhythm/test/probe.test.ts', 'export const a = Date.now();\n'),
    ).toEqual([]);
    expect(
      await messages('packages/rhythm/src/probe.ts', "export const d = new Date('2026-11-04');\n"),
    ).toEqual([]);
  });
});
