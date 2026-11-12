/** pnpm cc:new-template (08 §6): scaffolds templates, forks and packs that cc:gen accepts. */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

import { readFrameworkFiles } from '../gen.ts';
import { camel, parseArgs, runNewTemplate, SCAFFOLD_DIR } from '../new-template.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** A throwaway directory with the scaffold and the Prettier config. */
function sandbox(): { path: string; cleanup(): void } {
  const dir = createProfileDir();
  for (const path of ['.prettierrc.json', SCAFFOLD_DIR]) {
    cpSync(join(root, path), join(dir.path, path), { recursive: true });
  }
  return dir;
}

async function run(dir: string, args: string[]) {
  const options = parseArgs(args);
  if (options === undefined) return { exitCode: 2, lines: ['usage'] };
  return runNewTemplate(dir, options);
}

describe('cc:new-template', { timeout: 30_000 }, () => {
  it('AC-01-08 --from forks a built template to custom:<name>, a valid file cc:gen accepts', async () => {
    const dir = sandbox();
    try {
      const result = await run(dir.path, ['--id', 'custom:ald-weekly', '--from', 'eos-lite@1.0.0']);
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual([
        'wrote packages/frameworks/templates/custom/ald-weekly/1.0.0.yaml',
        'wrote packages/frameworks/test/custom-ald-weekly.test.ts',
        'next: edit the YAML file, then run pnpm cc:gen',
      ]);
      const [file] = readFrameworkFiles(dir.path);
      expect(file?.issues).toEqual([]);
      expect(file?.value).toMatchObject({
        id: 'custom:ald-weekly',
        version: '1.0.0',
        forkedFrom: { templateId: 'eos-lite', version: '1.0.0' },
      });
      const yaml = readFileSync(join(dir.path, file?.path ?? ''), 'utf8');
      expect(yaml).toMatch(/^# custom:ald-weekly 1\.0\.0: custom \(based on eos-lite 1\.0\.0\)/);
      // Removing an invariant from the fork's file keeps it valid (01 §9 level 5).
      const path = join(dir.path, file?.path ?? '');
      writeFileSync(path, yaml.replace(/\n {4}- id: E-5\n(?: {6}.*\n)+/, '\n'));
      expect(readFrameworkFiles(dir.path)[0]?.issues).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });

  it('never overwrites a file', async () => {
    const dir = sandbox();
    try {
      const args = ['--id', 'custom:ald-weekly', '--from', 'eos-lite'];
      expect((await run(dir.path, args)).exitCode).toBe(0);
      const again = await run(dir.path, args);
      expect(again.exitCode).toBe(1);
      expect(again.lines[0]).toMatch(/1\.0\.0\.yaml exists; nothing was written$/);
    } finally {
      dir.cleanup();
    }
  });

  it('scaffolds a catalogue template with a validator stub and test cases', async () => {
    const dir = sandbox();
    try {
      const result = await run(dir.path, ['--id', 'scaling-up']);
      expect(result.exitCode).toBe(0);
      expect(result.lines.slice(0, 3)).toEqual([
        'wrote packages/frameworks/templates/scaling-up/1.0.0.yaml',
        'wrote packages/frameworks/validators/scaling-up.ts',
        'wrote packages/frameworks/test/scaling-up.test.ts',
      ]);
      expect(result.lines[3]).toMatch(/register scalingUpPlaceholder in/);
      const validator = readFileSync(
        join(dir.path, 'packages/frameworks/validators/scaling-up.ts'),
        'utf8',
      );
      expect(validator).toContain('export const scalingUpPlaceholder: ValidatorDefinition');
      // Until the stub is registered and the TODOs are filled in, cc:gen reports the file.
      const [file] = readFrameworkFiles(dir.path);
      expect(file?.issues).toContain(
        'invariant N-1: no validator scalingUpPlaceholder in packages/frameworks/validators',
      );
    } finally {
      dir.cleanup();
    }
  });

  it('scaffolds an empty pack or copies one, both valid', async () => {
    const dir = sandbox();
    try {
      expect((await run(dir.path, ['--id', 'pack.sales', '--pack'])).exitCode).toBe(0);
      const copy = await run(dir.path, [
        '--id',
        'pack.outreach',
        '--pack',
        '--from',
        'pack.job-search',
      ]);
      expect(copy.exitCode).toBe(0);
      const files = readFrameworkFiles(dir.path);
      expect(files.map((file) => [file.path, file.issues])).toEqual([
        ['packages/frameworks/packs/pack.outreach/1.0.0.yaml', []],
        ['packages/frameworks/packs/pack.sales/1.0.0.yaml', []],
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it('rejects usage errors with exit 2 and unknown or built sources with exit 1', async () => {
    const dir = sandbox();
    try {
      const code = async (args: string[]) => (await run(dir.path, args)).exitCode;
      expect(parseArgs([])).toBeUndefined();
      expect(parseArgs(['--id', 'x', '--from', 'eos-lite@1'])).toBeUndefined();
      expect(parseArgs(['--id', 'x', '--bogus'])).toBeUndefined();
      expect(await code(['--id', 'kanban'])).toBe(2);
      expect(await code(['--id', 'custom:ald-weekly'])).toBe(2);
      expect(await code(['--id', 'custom:Ald', '--from', 'eos-lite'])).toBe(2);
      expect(await code(['--id', 'eos', '--from', 'eos-lite'])).toBe(2);
      expect(await code(['--id', 'sales', '--pack'])).toBe(2);
      expect(await code(['--id', 'personal-os'])).toBe(1);
      expect(await code(['--id', 'custom:x', '--from', 'eos-lite@9.0.0'])).toBe(1);
      expect(await code(['--id', 'pack.x', '--pack', '--from', 'pack.none'])).toBe(1);
    } finally {
      dir.cleanup();
    }
  });

  it('names validators in camelCase', () => {
    expect(camel('scaling-up')).toBe('scalingUp');
    expect(camel('custom:ald-weekly')).toBe('aldWeekly');
    expect(camel('4dx')).toBe('4dx');
  });
});
