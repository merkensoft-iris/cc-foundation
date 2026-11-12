/**
 * D1 (08 §4.2): "A test also searches the built output for spawns of claude or codex."
 * `pnpm test` builds every package first, so dist/ is current when this runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

export const AI_CLI_SPAWN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|execaSync)\s*\(\s*['"`](?:claude|codex)\b/;

function workspacePackages(): string[] {
  return ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(root, top, entry.name, 'package.json')),
      )
      .map((entry) => join(top, entry.name)),
  );
}

function builtFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(?:c|m)?js$/.test(file))
    .map((file) => join(dir, file));
}

describe('built output', () => {
  it('D1 the spawn pattern matches the calls it must catch', () => {
    expect(AI_CLI_SPAWN.test("spawn('claude', ['-p'])")).toBe(true);
    expect(AI_CLI_SPAWN.test('cp.execFile(`codex`, [])')).toBe(true);
    expect(AI_CLI_SPAWN.test("spawn('node', ['claude.js'])")).toBe(false);
  });

  it('D1 no package build spawns claude or codex', () => {
    const packages = workspacePackages();
    expect(packages.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const pkg of packages) {
      const dist = join(root, pkg, 'dist');
      expect(existsSync(dist), `${pkg} has no dist/; run pnpm build`).toBe(true);
      for (const file of builtFiles(dist)) {
        if (AI_CLI_SPAWN.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
