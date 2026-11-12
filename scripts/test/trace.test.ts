import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

import {
  extractCitations,
  extractDesignIds,
  parseAcceptance,
  parseArgs,
  parseBuildPlan,
  runTrace,
} from '../trace.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Fixture IDs use file number 99, which the real design does not have. Test calls in fixture
// text are built at run time, so this file's own source cites nothing it does not prove.
const call = (fn: string, name: string) => `${fn}('${name}', () => {});\n`;

const PLAN = [
  '# 09 · Plan',
  '',
  '**Gate P0 (done).** Acceptance: AC-99-01, manual:AC-99-02. Open questions: none.',
  '',
  '**Gate P1.** Acceptance: AC-99-03 to AC-99-05. Manual checks: none.',
  '',
  '### 13.3 Track items',
  '',
  '| ID | Connector | Acceptance |',
  '|---|---|---|',
  '| P2-08 (done) | `demo` | AC-99-06 (live part manual) |',
  '| P2-09 | `other` | covered by AC-99-07 |',
  '',
  '## 14. Risks',
].join('\n');

function write(base: string, path: string, text: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), text);
}

function fixtureRepo(): { path: string; cleanup(): void } {
  const dir = createProfileDir();
  const criteria = [1, 2, 3, 4, 5, 6, 7].map((n) => `${n}. **AC-99-0${n}** criterion.`);
  write(dir.path, 'docs/design/99-demo.md', [...criteria, '1. **C-99-01** a rule.'].join('\n'));
  write(dir.path, 'docs/design/09-build-plan.md', PLAN);
  write(dir.path, 'scripts/test/demo.test.ts', call('it', 'AC-99-01 proves the P0 criterion'));
  write(dir.path, 'packages/x/test/track.test.ts', call('test', 'AC-99-06 C-99-01 proves P2-08'));
  return dir;
}

describe('cc:trace', () => {
  it('AC-08-06 lists every AC- ID in docs/design with its covering tests', () => {
    const result = runTrace(root);
    const designIds = extractDesignIds(
      readdirSync(join(root, 'docs', 'design'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => readFileSync(join(root, 'docs', 'design', name), 'utf8')),
    ).filter((id) => id.startsWith('AC-'));
    expect(designIds.length).toBeGreaterThan(80);
    for (const id of designIds) {
      expect(result.lines.some((line) => line.startsWith(`${id} `))).toBe(true);
    }
    const line = (id: string) => result.lines.find((candidate) => candidate.startsWith(`${id} `));
    expect(line('AC-08-03')).toMatch(/^AC-08-03 +P0 +scripts\/test\/gen\.test\.ts:\d+/);
    expect(line('AC-08-06')).toMatch(/scripts\/test\/trace\.test\.ts:\d+/);
    expect(line('AC-08-02')).toMatch(/\.github\/workflows\/ci\.yml:\d+/);
    expect(result.exitCode).toBe(0);
  });

  it('AC-08-06 removing the only test of a done phase criterion fails cc:trace', () => {
    const repo = fixtureRepo();
    try {
      const before = runTrace(repo.path);
      expect(before.exitCode).toBe(0);
      expect(before.lines).toContain('AC-99-01  P0        scripts/test/demo.test.ts:1');
      expect(before.lines).toContain('AC-99-03  P1        uncovered');
      expect(before.lines.at(-1)).toBe(
        'cc:trace: 2 of 7 acceptance IDs covered, 1 of 1 contract IDs cited; done: P0, P2-08.',
      );

      rmSync(join(repo.path, 'scripts/test/demo.test.ts'));
      const after = runTrace(repo.path);
      expect(after.exitCode).toBe(1);
      expect(after.lines).toContain('FAIL P0 is marked done but has no test for AC-99-01');

      rmSync(join(repo.path, 'packages/x/test/track.test.ts'));
      expect(runTrace(repo.path).lines).toContain(
        'FAIL P2-08 is marked done but has no test for AC-99-06',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('AC-08-06 a skipped test does not cover a done phase criterion', () => {
    const repo = fixtureRepo();
    try {
      write(repo.path, 'scripts/test/demo.test.ts', call('it.skip', 'AC-99-01 skipped'));
      expect(runTrace(repo.path).exitCode).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  it('--phase checks one gate whether or not it is marked done; manual criteria are not required', () => {
    const repo = fixtureRepo();
    try {
      const p0 = runTrace(repo.path, { phase: 'P0' });
      expect(p0.exitCode).toBe(0);
      expect(p0.lines).toContain('AC-99-02  manual, uncovered');
      expect(p0.lines.at(-1)).toBe('cc:trace --phase P0: all 1 criteria covered, 1 manual.');
      const p1 = runTrace(repo.path, { phase: 'P1' });
      expect(p1.exitCode).toBe(1);
      expect(p1.lines.at(-1)).toBe(
        'cc:trace --phase P1: 3 of 3 criteria uncovered: AC-99-03, AC-99-04, AC-99-05.',
      );
      expect(runTrace(repo.path, { phase: 'P2-08' }).exitCode).toBe(0);
      expect(runTrace(repo.path, { phase: 'P5' }).exitCode).toBe(2);
    } finally {
      repo.cleanup();
    }
  });

  it('--repo adds the tests of another repository (the cc-engine and cc-connectors hook)', () => {
    const repo = fixtureRepo();
    const other = createProfileDir();
    try {
      write(other.path, 'test/p1.test.ts', call('it', 'AC-99-03 AC-99-04, AC-99-05 engine test'));
      const result = runTrace(repo.path, { phase: 'P1', repos: [other.path] });
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toBe(`AC-99-03  ${other.path}:test/p1.test.ts:1`);
    } finally {
      repo.cleanup();
      other.cleanup();
    }
  });

  it('reads gates, ranges, manual criteria and track items from the build plan', () => {
    expect(parseAcceptance('AC-01-01 to AC-01-03, manual:AC-01-07; AC-02-12')).toEqual({
      acceptance: ['AC-01-01', 'AC-01-02', 'AC-01-03', 'AC-02-12'],
      manual: ['AC-01-07'],
    });
    expect(parseBuildPlan(PLAN)).toEqual([
      { id: 'P0', kind: 'phase', done: true, acceptance: ['AC-99-01'], manual: ['AC-99-02'] },
      {
        id: 'P1',
        kind: 'phase',
        done: false,
        acceptance: ['AC-99-03', 'AC-99-04', 'AC-99-05'],
        manual: [],
      },
      { id: 'P2-08', kind: 'track', done: true, acceptance: ['AC-99-06'], manual: [] },
      { id: 'P2-09', kind: 'track', done: false, acceptance: ['AC-99-07'], manual: [] },
    ]);
    const plan = parseBuildPlan(readFileSync(join(root, 'docs/design/09-build-plan.md'), 'utf8'));
    expect(plan.filter((gate) => gate.kind === 'phase').map((gate) => gate.id)).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
      'P6',
      'P7',
    ]);
    expect(plan.find((gate) => gate.id === 'P0')?.acceptance).toEqual([
      'AC-08-01',
      'AC-08-02',
      'AC-08-03',
      'AC-08-04',
      'AC-08-06',
      'AC-08-07',
    ]);
  });

  it('takes only the IDs a test or CI step name starts with', () => {
    const text = call('describe', 'AC-99-01, AC-99-02 group') + call('it', 'mentions AC-99-03');
    expect(extractCitations('a.test.ts', text).map((citation) => citation.ids)).toEqual([
      ['AC-99-01', 'AC-99-02'],
    ]);
    const workflow = 'steps:\n  - name: AC-99-04 a CI check\n  - name: Install\n';
    expect(extractCitations('.github/workflows/ci.yml', workflow)).toEqual([
      { file: '.github/workflows/ci.yml', line: 2, name: 'AC-99-04 a CI check', ids: ['AC-99-04'] },
    ]);
  });

  it('rejects unknown arguments', () => {
    expect(parseArgs([])).toEqual({ repos: [] });
    expect(parseArgs(['--phase', 'P0', '--repo', 'x'])).toEqual({ phase: 'P0', repos: ['x'] });
    expect(parseArgs(['--phase'])).toBeUndefined();
    expect(parseArgs(['--phase', 'zero'])).toBeUndefined();
    expect(parseArgs(['--verbose'])).toBeUndefined();
  });
});
