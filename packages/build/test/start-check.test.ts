/**
 * The clean-tree start check (ADR 0004 decision 3) over the scenario matrix of ADR 0004's
 * Result section, on a synthetic engine checkout, and the stale-build offer of 04 §10 rule 2.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_STAMP,
  checkStart,
  findOnPath,
  readBuildStamp,
  type BuildStamp,
} from '@cc/build-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBuild } from '../src/build.js';
import { createEngine, git, write, type EngineFixture } from './engine-fixture.js';

const passingTypecheck = () => Promise.resolve({ ok: true, output: '', ms: 0 });

/** Builds the engine without packaging and returns the stamp the build wrote. */
async function buildStamp(root: string): Promise<BuildStamp> {
  const result = await runBuild({ root, package: false, typecheck: passingTypecheck });
  expect(result.exitCode, result.lines.join('\n')).toBe(0);
  const stamp = readBuildStamp(join(root, 'dist', '.stage', BUILD_STAMP));
  if (stamp === null) throw new Error('no build stamp');
  return stamp;
}

function reasons(result: Awaited<ReturnType<typeof checkStart>>): readonly string[] {
  return result.mode.kind === 'developer' ? result.mode.reasons : [];
}

describe('clean-tree start check (ADR 0004)', () => {
  let engine: EngineFixture;
  let stamp: BuildStamp;

  beforeEach(async () => {
    engine = createEngine();
    stamp = await buildStamp(engine.root);
  });
  afterEach(() => engine.cleanup());

  it('a clean checkout with the build at HEAD starts normally', async () => {
    expect(stamp.clean).toBe(true);
    expect(stamp.git).toBe(findOnPath('git'));
    const result = await checkStart(stamp);
    expect(result.mode).toEqual({ kind: 'normal' });
    expect(result.offerRebuild).toBe(false);
  });

  it('a build output in ignored dist/ and a touch with the same bytes stay normal', async () => {
    write(engine.root, 'dist/extra.txt', 'output');
    write(engine.root, 'ui/header.ts', 'export const title = "Header";\n');
    expect((await checkStart(stamp)).mode.kind).toBe('normal');
  });

  it('a file edited inside node_modules stays normal: the app runs from its asar', async () => {
    write(engine.root, 'node_modules/some-dep/index.js', 'module.exports = 2;\n');
    expect((await checkStart(stamp)).mode.kind).toBe('normal');
  });

  it.each([
    [
      'a tracked file modified',
      (root: string) => write(root, 'ui/header.ts', 'export const title = "Changed";\n'),
    ],
    [
      'a change staged only',
      (root: string) => {
        write(root, 'ui/header.ts', 'export const title = "Staged";\n');
        git(root, 'add', 'ui/header.ts');
      },
    ],
    ['a tracked file deleted', (root: string) => rmSync(join(root, 'ui/header.ts'))],
    ['an untracked file in ui/', (root: string) => write(root, 'ui/new-widget.ts', 'export {};\n')],
    [
      'an edit with the same size',
      (root: string) => write(root, 'ui/header.ts', 'export const title = "Hxader";\n'),
    ],
  ])(
    'AC-04-14 a dirty checkout (%s) starts in developer mode with no Rebuild now offer',
    async (_name, mutate) => {
      mutate(engine.root);
      const result = await checkStart(stamp);
      expect(result.mode.kind).toBe('developer');
      expect(reasons(result)[0]).toMatch(/^uncommitted changes: ui\//);
      expect(result.offerRebuild).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a mode change (chmod +x) is developer mode',
    async () => {
      chmodSync(join(engine.root, 'ui/header.ts'), 0o755);
      const result = await checkStart(stamp);
      expect(reasons(result)[0]).toMatch(/^uncommitted changes: ui\/header\.ts/);
    },
  );

  it('AC-04-14 committing a change that moves HEAD past the running build offers Rebuild now', async () => {
    write(engine.root, 'ui/header.ts', 'export const title = "Committed";\n');
    const head = engine.commit('feat: new header');
    const result = await checkStart(stamp);
    expect(result.mode.kind).toBe('developer');
    expect(reasons(result)[0]).toBe(
      `build out of date: the checkout is at ${head.slice(0, 12)}, the build at ${stamp.commit?.slice(0, 12) ?? ''}`,
    );
    expect(result.offerRebuild).toBe(true);
    expect(result.head).toBe(head);
  });

  it('a commit that changes only connectors.lock needs no rebuild (04 §10 rule 3)', async () => {
    write(engine.root, 'connectors.lock', '{ "entries": [{ "id": "fixture-calendar" }] }\n');
    engine.commit('chore: include fixture-calendar');
    expect((await checkStart(stamp)).mode).toEqual({ kind: 'normal' });
  });

  it('a merged update PR that is not installed is "build out of date" and offers Rebuild now', async () => {
    write(
      engine.root,
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\n\nimporters:\n  .: { dependencies: {} }\n",
    );
    engine.commit('chore(deps): update @cc/* pins');
    const result = await checkStart(stamp);
    expect(reasons(result)).toContain(
      'build out of date: install out of date: pnpm-lock.yaml changed since pnpm install',
    );
    expect(result.offerRebuild).toBe(true);
  });

  it('an install without the stamp (--ignore-scripts) is never normal', async () => {
    rmSync(join(engine.root, 'node_modules', '.cc-install-stamp.json'));
    const result = await checkStart(stamp);
    expect(reasons(result)).toEqual([
      'build out of date: install out of date: no install stamp (run pnpm install)',
    ]);
  });

  it('a merge in progress is developer mode', async () => {
    writeFileSync(join(engine.root, '.git', 'MERGE_HEAD'), `${stamp.commit ?? ''}\n`);
    const result = await checkStart(stamp);
    expect(reasons(result)).toContain('merge in progress');
    expect(result.offerRebuild).toBe(false);
  });

  it('an untracked file hidden by .git/info/exclude is developer mode', async () => {
    mkdirSync(join(engine.root, '.git', 'info'), { recursive: true });
    writeFileSync(join(engine.root, '.git', 'info', 'exclude'), '# comment\nui/hidden.ts\n');
    write(engine.root, 'ui/hidden.ts', 'export {};\n');
    const result = await checkStart(stamp);
    expect(reasons(result)).toContain('.git/info/exclude has active patterns: ui/hidden.ts');
  });

  it.each([['--assume-unchanged'], ['--skip-worktree']])(
    'an edit hidden by %s is developer mode',
    async (flag) => {
      git(engine.root, 'update-index', flag, 'ui/header.ts');
      write(engine.root, 'ui/header.ts', 'export const title = "Hidden";\n');
      const result = await checkStart(stamp);
      expect(reasons(result)).toContain('index flags hide changes: ui/header.ts');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a core.fsmonitor hook in .git/config is not run, and the edit is still found',
    async () => {
      const marker = join(engine.path, 'fsmonitor-ran');
      const hook = join(engine.path, 'fsmonitor-hook.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
      git(engine.root, 'config', 'core.fsmonitor', hook);
      write(engine.root, 'ui/header.ts', 'export const title = "Monitored";\n');
      const result = await checkStart(stamp);
      expect(reasons(result)[0]).toMatch(/^uncommitted changes: ui\/header\.ts/);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('git missing is developer mode, "cannot verify tree"', async () => {
    const result = await checkStart({ ...stamp, git: join(engine.path, 'no-such-git') });
    expect(reasons(result)).toEqual(['cannot verify tree: git not found']);
    expect(result.offerRebuild).toBe(false);
  });

  it('a checkout without .git inside another repository is "not a git checkout", not the enclosing one', async () => {
    const outer = join(engine.path, 'outer');
    mkdirSync(outer);
    git(outer, 'init', '-q');
    const copy = join(outer, 'engine-copy');
    cpSync(engine.root, copy, {
      recursive: true,
      filter: (path) => !path.includes(`${join(engine.root, '.git')}`),
    });
    const result = await checkStart({ ...stamp, checkout: copy });
    expect(reasons(result)).toEqual(['not a git checkout']);
  });

  it('no build stamp is developer mode, never normal', async () => {
    const result = await checkStart(null);
    expect(result.mode).toEqual({
      kind: 'developer',
      reasons: ['no build stamp: not a packaged build'],
    });
  });

  it('a build made from a dirty tree is never normal, and offers Rebuild now once the tree is clean', async () => {
    write(engine.root, 'ui/header.ts', 'export const title = "Preview";\n');
    const dirtyStamp = await buildStamp(engine.root);
    expect(dirtyStamp.clean).toBe(false);
    expect((await checkStart(dirtyStamp)).offerRebuild).toBe(false);
    git(engine.root, 'checkout', '--', 'ui/header.ts');
    const result = await checkStart(dirtyStamp);
    expect(reasons(result)[0]).toMatch(/^build out of date: built from a tree that was not clean/);
    expect(result.offerRebuild).toBe(true);
  });

  it('a linked worktree is checked against its own HEAD and index', async () => {
    const linked = join(engine.path, 'linked');
    git(engine.root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const linkedStamp: BuildStamp = { ...stamp, checkout: linked };
    // The linked worktree has no install of its own yet.
    expect(reasons(await checkStart(linkedStamp))).toEqual([
      'build out of date: install out of date: no install stamp (run pnpm install)',
    ]);
    write(linked, 'ui/header.ts', 'export const title = "Linked";\n');
    expect(reasons(await checkStart(linkedStamp))[0]).toMatch(
      /^uncommitted changes: ui\/header\.ts/,
    );
  });
});
