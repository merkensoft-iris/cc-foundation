/**
 * Ambient context (07 §8): `cc-axi setup hooks | status`, `cc-axi hook session-start` and the
 * directory-to-workstream mapping, in-process against the headless core. Every file is
 * written under a temporary directory that stands in for both the project and `$HOME`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encode } from '@toon-format/toon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { sessionStartView, MAX_HOOK_LINES } from '../src/commands/hook.js';
import type { HomeResult } from '../src/commands/common.js';
import {
  commandCenterHooks,
  commandLine,
  isCommandCenterHook,
  OPENCODE_PLUGIN_MARKER,
  resolveHookCommand,
  upsertSessionStartHook,
} from '../src/hooks.js';
import { normalizeRemote, workstreamForDirectory } from '../src/repo-map.js';
import { referenceData, type FixtureData } from './support/fixture-api.ts';
import { startTestCore, testEnv, type TestCore } from './support/core.ts';
import { cli } from './support/run.ts';

/** The `bin` support/run.ts gives every run; it does not exist, so it is used as given. */
const BIN = '/usr/local/bin/cc-axi';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-hooks-'));
  env = { HOME: dir, USERPROFILE: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function expectedCommand(): string {
  return commandLine(resolveHookCommand(BIN, testEnv(dir, env)));
}

describe('cc-axi setup hooks', () => {
  let profile: ProfileDir;

  beforeEach(() => {
    profile = createProfileDir();
  });

  afterEach(() => {
    profile.cleanup();
  });

  it('AC-07-05 setup hooks --agents claude-code,codex,opencode --scope project run twice leaves one hook per agent', async () => {
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    // Someone else's hooks and settings stay as they are.
    const other = { type: 'command', command: 'other-tool context', timeout: 5 };
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ model: 'x', hooks: { SessionStart: [{ matcher: '', hooks: [other] }] } }),
    );
    const args = ['setup', 'hooks', '--agents', 'claude-code,codex,opencode', '--scope', 'project'];

    const first = await cli(profile.path, args, env, project);
    expect(first.code).toBe(0);
    expect(first.output['status']).toBe('ok');
    expect(first.output['command']).toBe(expectedCommand());
    const second = await cli(profile.path, args, env, project);
    expect(second).toMatchObject({ code: 0, output: { status: 'no-op' } });
    expect(second.stdout).toBe('status: no-op\n');

    const claude = readJson(join(project, '.claude', 'settings.json'));
    expect(commandCenterHooks(claude)).toEqual([expectedCommand()]);
    expect(claude['model']).toBe('x');
    expect(JSON.stringify(claude)).toContain('other-tool context');
    const codex = readJson(join(project, '.codex', 'hooks.json'));
    expect(commandCenterHooks(codex)).toEqual([expectedCommand()]);
    expect(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')).toMatch(
      /\[features\]\r?\nhooks = true/,
    );
    const plugin = readFileSync(join(project, '.opencode', 'plugins', 'command-center.js'), 'utf8');
    expect(plugin.startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true);
    expect(plugin).toContain('["hook","session-start"]');

    const status = await cli(profile.path, ['setup', 'status'], env, project);
    expect(status.code).toBe(0);
    const rows = status.output['hooks'] as { agent: string; scope: string; state: string }[];
    expect(rows.filter((row) => row.scope === 'project').map((row) => row.state)).toEqual([
      'installed',
      'installed',
      'installed',
    ]);
    expect(rows.filter((row) => row.scope === 'user').map((row) => row.state)).toEqual([
      'missing',
      'missing',
      'missing',
    ]);
    expect(status.output['codex_hooks_feature']).toMatch(/^enabled in /);
    expect(status.output['help']).toBeUndefined();
  });

  it('AC-07-05 the default is every P1 agent at user scope, under $HOME', async () => {
    const run = await cli(profile.path, ['setup', 'hooks'], env, join(dir));
    expect(run.code).toBe(0);
    expect(commandCenterHooks(readJson(join(dir, '.claude', 'settings.json')))).toHaveLength(1);
    expect(commandCenterHooks(readJson(join(dir, '.codex', 'hooks.json')))).toHaveLength(1);
    expect(
      readFileSync(join(dir, '.config', 'opencode', 'plugins', 'command-center.js'), 'utf8'),
    ).toContain(OPENCODE_PLUGIN_MARKER);
  });

  it('AC-07-05 --agents grok is refused until the P7 writer, and writes nothing', async () => {
    const run = await cli(
      profile.path,
      ['setup', 'hooks', '--agents', 'claude-code,grok', '--scope', 'project'],
      env,
      dir,
    );
    expect(run.code).toBe(2);
    expect(run.output['code']).toBe('E_USAGE');
    expect(JSON.stringify(run.output['help'])).toContain('P7');
    const unknown = await cli(profile.path, ['setup', 'hooks', '--agents', 'cursor'], env, dir);
    expect(unknown).toMatchObject({ code: 2, output: { code: 'E_USAGE' } });
    expect(() => readFileSync(join(dir, '.claude', 'settings.json'))).toThrow();
  });

  it('AC-07-05 a stale or duplicated hook is repaired to exactly one current hook', async () => {
    const stale = { type: 'command', command: '/old/place/cc-axi hook session-start', timeout: 3 };
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [stale] },
            { matcher: 'startup', hooks: [{ ...stale, command: 'cc-axi hook session-start' }] },
          ],
        },
      }),
    );
    const status = await cli(profile.path, ['setup', 'status'], env, dir);
    const claude = (status.output['hooks'] as { agent: string; scope: string; state: string }[])[0];
    expect(claude).toMatchObject({ agent: 'claude-code', scope: 'user', state: 'outdated' });
    expect(status.output['help']).toEqual([
      'Run `cc-axi setup hooks` to repair the user-level hooks',
    ]);

    const run = await cli(profile.path, ['setup', 'hooks', '--agents', 'claude-code'], env, dir);
    expect(run.code).toBe(0);
    const hooks = (run.output['hooks'] as { result: string }[]).map((row) => row.result);
    expect(hooks).toEqual(['updated']);
    const settings = readJson(join(dir, '.claude', 'settings.json'));
    expect(commandCenterHooks(settings)).toEqual([expectedCommand()]);
    // The emptied second group is gone; the first keeps its place.
    expect((settings['hooks'] as { SessionStart: unknown[] }).SessionStart).toHaveLength(1);
  });

  it('AC-07-05 a file that is not its own is left alone: E_CONFLICT, exit 1, the others written', async () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'hooks.json'), '{ not json');
    mkdirSync(join(dir, '.config', 'opencode', 'plugins'), { recursive: true });
    const theirs = join(dir, '.config', 'opencode', 'plugins', 'command-center.js');
    writeFileSync(theirs, 'export default {};\n');
    const run = await cli(profile.path, ['setup', 'hooks'], env, dir);
    expect(run.code).toBe(1);
    expect(run.output['code']).toBe('E_CONFLICT');
    expect(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')).toBe('{ not json');
    expect(readFileSync(theirs, 'utf8')).toBe('export default {};\n');
    expect(commandCenterHooks(readJson(join(dir, '.claude', 'settings.json')))).toHaveLength(1);
  });
});

describe('hook helpers', () => {
  it('AC-07-05 only Command Center hooks are recognised as its own', () => {
    expect(isCommandCenterHook('cc-axi hook session-start')).toBe(true);
    expect(isCommandCenterHook('"C:\\Tools\\cc-axi.cmd" hook session-start')).toBe(true);
    expect(isCommandCenterHook('node /opt/cc/apps/cli/dist/bin.js hook session-start')).toBe(true);
    expect(isCommandCenterHook('cc-axi')).toBe(false);
    expect(isCommandCenterHook('gh-axi hook session-start')).toBe(false);
    expect(isCommandCenterHook('other-tool context')).toBe(false);
  });

  it('AC-07-05 upserting into settings that already hold the hook changes nothing', () => {
    const [once, changed] = upsertSessionStartHook({}, 'cc-axi hook session-start');
    expect(changed).toBe(true);
    const [twice, again] = upsertSessionStartHook(once, 'cc-axi hook session-start');
    expect(again).toBe(false);
    expect(twice).toBe(once);
  });

  it('AC-07-05 the portable command is the bare name when PATH finds this binary', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const entry = join(bin, 'cc-axi');
    writeFileSync(entry, '#!/bin/sh\n');
    expect(resolveHookCommand(entry, { PATH: bin })).toEqual({ program: 'cc-axi', args: [] });
    // Not on PATH: the absolute path; a .js entry runs through Node.js.
    const script = join(dir, 'dist', 'bin.js');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(script, '');
    const command = resolveHookCommand(script, { PATH: bin }, process.platform, '/opt/node/node');
    expect(command.args).toEqual([script]);
    expect(command.program).toContain('node');
  });

  it('AC-07-06 remotes compare equal across ssh, https and case', () => {
    expect(normalizeRemote('git@github.com:Example/Quillmarsh-Site.git')).toBe(
      'github.com/example/quillmarsh-site',
    );
    expect(normalizeRemote('https://user@github.com/example/quillmarsh-site/')).toBe(
      'github.com/example/quillmarsh-site',
    );
    expect(normalizeRemote('ssh://git@github.com:22/example/quillmarsh-site.git')).toBe(
      'github.com/example/quillmarsh-site',
    );
  });

  it('AC-07-06 a directory maps by the most specific repoPaths entry, ~ expanded', () => {
    const site = join(dir, 'code', 'quillmarsh-site');
    mkdirSync(join(site, 'docs'), { recursive: true });
    const workstreams = [
      { slug: 'alderwick', repoPaths: ['~/code'] },
      { slug: 'quillmarsh', repoPaths: ['~/code/quillmarsh-site'] },
    ];
    expect(workstreamForDirectory(join(site, 'docs'), workstreams, dir)).toEqual({
      slug: 'quillmarsh',
      via: 'path',
    });
    expect(workstreamForDirectory(join(dir, 'code'), workstreams, dir)?.slug).toBe('alderwick');
    expect(workstreamForDirectory(dir, workstreams, dir)).toBeUndefined();
  });

  it('AC-07-06 a clone or worktree elsewhere maps by its git remote', () => {
    const main = join(dir, 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(
      join(main, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:example/quillmarsh-site.git\n',
    );
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = join(dir, 'elsewhere', 'wt');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);

    const byPath = [{ slug: 'quillmarsh', repoPaths: [main] }];
    expect(workstreamForDirectory(join(worktree, 'src'), byPath, dir)).toEqual({
      slug: 'quillmarsh',
      via: 'remote',
    });
    const byRemote = [
      { slug: 'quillmarsh', repoPaths: ['https://github.com/Example/quillmarsh-site'] },
    ];
    expect(workstreamForDirectory(worktree, byRemote, dir)?.slug).toBe('quillmarsh');
    const other = [{ slug: 'alderwick', repoPaths: ['github.com/example/alderwick-site'] }];
    expect(workstreamForDirectory(worktree, other, dir)).toBeUndefined();
  });

  it('C-07-05 the hook output stays within 20 lines however busy the day', () => {
    const home: HomeResult = {
      workspace: 'main',
      now: '2026-11-13T09:02:00+05:30',
      today: Array.from({ length: 14 }, (_, index) => ({
        ref: `M-00${String(10 + index)}`,
        time: `${String(8 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '00' : '30'}`,
        title: `Meeting ${String(index + 1)}, with a long name: agenda, notes and follow-ups`,
      })),
      attention: {
        overdue: 4,
        atRisk: 2,
        awaitingReview: 1,
        confirmationsPending: 3,
        sessionsNeedingYou: 0,
      },
      items: [],
      counts: { dueSoon: 0, open: 0 },
    };
    const item = {
      ref: 'A-0144',
      title: 'Fix the contact form',
      due: '2026-11-18',
      state: 'waiting' as const,
    };
    const view = sessionStartView({
      home,
      mapped: {
        match: { slug: 'quillmarsh', via: 'path' },
        items: [item, { ...item, ref: 'A-0150' }, { ...item, ref: 'A-0151' }],
        total: 9,
      },
    });
    expect(view['meetings']).toBe('8 of 14 meetings today');
    // TOON, as the SDK prints it.
    expect(encode(view).split('\n').length).toBeLessThanOrEqual(MAX_HOOK_LINES);
  });
});

describe('cc-axi hook session-start', () => {
  let profile: ProfileDir;
  let core: TestCore;
  let site: string;

  /** Quillmarsh maps to a site repository; the sensitive project to a folder inside it. */
  function mappedData(): FixtureData {
    const data = referenceData();
    site = join(dir, 'quillmarsh-site');
    mkdirSync(join(site, 'confidential', 'notes'), { recursive: true });
    for (const workstream of data.workstreams) {
      if (workstream.slug === 'quillmarsh') workstream.repoPaths = [site];
      if (workstream.slug === 'private-project') {
        workstream.repoPaths = [join(site, 'confidential')];
      }
    }
    for (const item of data.items) {
      if (item.ref === 'A-0150') item.workstreamId = 'ws_qlm';
    }
    return data;
  }

  beforeEach(async () => {
    profile = createProfileDir();
    core = await startTestCore({ profileDir: profile.path, data: mappedData() });
  });

  afterEach(async () => {
    await core.close();
    profile.cleanup();
  });

  it("AC-07-06 C-07-05 in a directory in Quillmarsh's repoPaths, only Quillmarsh's top items and never a sensitive item", async () => {
    for (const cwd of [site, join(site, 'confidential', 'notes')]) {
      const run = await cli(profile.path, ['hook', 'session-start'], env, cwd);
      expect(run.code).toBe(0);
      expect(run.output['workspace']).toBe('main');
      expect(run.output['workstream']).toBe('quillmarsh');
      const refs = (run.output['items'] as { ref: string }[]).map((row) => row.ref);
      // Most urgent first: A-0150 is due 2026-11-16, A-0144 on 2026-11-18.
      expect(refs).toEqual(['A-0150', 'A-0144']);
      expect(run.output['count']).toBe('2 of 2 active items in workstream quillmarsh');
      // The sensitive project's item, its name and its slug appear nowhere (C-07-05).
      expect(run.stdout).not.toContain('A-0152');
      expect(run.stdout).not.toContain('statement of work');
      expect(run.stdout).not.toMatch(/private/i);
      expect(run.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(20);
      expect(run.output['help']).toHaveLength(1);
    }
    expect(core.calls).toContain('items.list');
  });

  it('AC-07-06 a principal with sensitiveAccess gets the sensitive workstream it is in', async () => {
    await core.core.principals.create(
      { kind: 'user' },
      { name: 'sensitive-reader', kind: 'cli', scopes: ['read'], sensitiveAccess: true },
    );
    const run = await cli(
      profile.path,
      ['hook', 'session-start', '--principal', 'sensitive-reader'],
      env,
      join(site, 'confidential', 'notes'),
    );
    expect(run.code).toBe(0);
    expect(run.output['workstream']).toBe('private-project');
    expect((run.output['items'] as { ref: string }[]).map((row) => row.ref)).toEqual(['A-0152']);
  });

  it('C-07-05 outside every mapped directory: the most urgent items, still none sensitive', async () => {
    const run = await cli(profile.path, ['hook', 'session-start'], env, dir);
    expect(run.code).toBe(0);
    expect(run.output['workstream']).toBe('none mapped to this directory');
    expect(run.output['items']).toHaveLength(3);
    expect(run.output['attention']).toMatch(/^\d+ overdue, \d+ at risk, \d+ awaiting review/);
    expect(run.stdout).not.toContain('A-0152');
    expect(run.output['help']).toHaveLength(1);
  });

  it('AC-07-06 the app not running prints one line and exits 0, so the session starts', async () => {
    const nowhere = createProfileDir();
    try {
      const run = await cli(nowhere.path, ['hook', 'session-start'], env, site);
      expect(run.code).toBe(0);
      expect(run.output).toEqual({
        command_center: 'not running',
        help: ['Open Command Center, then run `cc-axi` for the home view'],
      });
    } finally {
      nowhere.cleanup();
    }
  });
});
