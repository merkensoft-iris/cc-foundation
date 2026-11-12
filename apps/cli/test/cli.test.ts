/**
 * `cc-axi` end to end in-process against the real core service in headless mode (07 §4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { VERSION } from '../src/version.js';
import { emptyData } from './support/fixture-api.ts';
import { cli } from './support/run.ts';
import { startTestCore, type TestCore } from './support/core.ts';

let profile: ProfileDir;
let core: TestCore;

beforeEach(async () => {
  profile = createProfileDir();
  core = await startTestCore({ profileDir: profile.path });
});

afterEach(async () => {
  await core.close();
  profile.cleanup();
});

describe('cc-axi', () => {
  it('AC-07-01 the home view starts with bin: and description: and shows live content', async () => {
    const run = await cli(profile.path, []);
    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n');
    // The SDK writes bin: from process.argv[1] for the no-argument view.
    expect(lines[0]).toMatch(/^bin: /);
    expect(lines[1]).toMatch(/^description: /);
    expect(run.output['workspace']).toBe('main');
    expect(run.output['items']).toHaveLength(3);
    // The client engagement's item is sensitive and not counted for cli-default (07 §5).
    expect(run.output['count']).toBe('3 of 5 items overdue or due within 7 days (7 open in total)');
    expect(run.output['help']).toContain(
      'Run `cc-axi items list --due-before 2026-11-20` for all 5',
    );
  });

  it('AC-07-01 cc-axi home is the home view and accepts the global flags (ADR 0002 follow-up 2)', async () => {
    const run = await cli(profile.path, ['home', '--format', 'json', '--principal', 'read-only']);
    expect(run.code).toBe(0);
    const json = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(json).slice(0, 2)).toEqual(['bin', 'description']);
    expect(json['bin']).toBe('/usr/local/bin/cc-axi');
  });

  it('AC-07-01 -v, -V and --version print the bare version through the full CLI too', async () => {
    for (const flag of ['-v', '-V', '--version']) {
      const run = await cli(profile.path, [flag]);
      expect(run).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    }
  });

  it('AC-07-01 lists carry a total count and next steps; --fields adds columns', async () => {
    const run = await cli(profile.path, ['items', 'list', '--limit', '2', '--fields', 'owner']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('items[2]{ref,title,due,state,owner}:');
    // cli-default has no sensitiveAccess, so the client engagement's item is not counted (07 §5).
    expect(run.output['count']).toBe('2 of 8 active items');
    expect(run.output['help']).toEqual([
      'Run `cc-axi items view <ref>` for details',
      'Run `cc-axi items list --fields owner --limit 8` for all 8',
    ]);
  });

  it('AC-07-01 every list has a definitive empty message', async () => {
    const empty = createProfileDir();
    const emptyCore = await startTestCore({ profileDir: empty.path, data: emptyData() });
    try {
      const cases: [string[], string, string][] = [
        [
          ['items', 'list', '--owner', 'me', '--workstream', 'quillmarsh'],
          'items',
          '0 active items owned by you in workstream quillmarsh',
        ],
        [['decisions', 'list'], 'decisions', '0 decisions'],
        [['issues', 'list', '--status', 'open'], 'issues', '0 open issues'],
        [['measures', 'list'], 'measures', '0 measures'],
        [['goals', 'list'], 'goals', '0 goals in the current period'],
        [['search', 'anything'], 'hits', '0 results for "anything"'],
      ];
      for (const [argv, key, message] of cases) {
        const run = await cli(empty.path, argv);
        expect(run.code, argv.join(' ')).toBe(0);
        expect(run.output[key], argv.join(' ')).toBe(message);
      }
      const home = await cli(empty.path, []);
      expect(home.output['today']).toBe('0 meetings today');
      expect(home.output['items']).toBe('0 items overdue or due within 7 days (0 open in total)');
    } finally {
      await emptyCore.close();
      empty.cleanup();
    }
  });

  it('AC-07-01 --full hints appear only when text was cut, with the total size', async () => {
    const cut = await cli(profile.path, ['items', 'view', 'A-0161']);
    const item = cut.output['item'] as Record<string, string>;
    expect(item['done_means']).toMatch(/… \(truncated: 1000 of 3260 chars\)$/);
    expect(cut.output['help']).toEqual(['Run `cc-axi items view A-0161 --full` for the full text']);
    const full = await cli(profile.path, ['items', 'view', 'A-0161', '--full']);
    expect((full.output['item'] as Record<string, string>)['done_means']).toHaveLength(3260);
    expect(full.output['help']).toBeUndefined();
    const short = await cli(profile.path, ['items', 'view', 'A-0142']);
    expect(short.output['help']).toBeUndefined();
  });

  it('AC-07-01 the detail view carries the pre-computed aggregates of 07 §4.3', async () => {
    const run = await cli(profile.path, ['items', 'view', 'A-0142']);
    expect(run.output['item']).toMatchObject({
      ref: 'A-0142',
      workstream: 'alderwick',
      state: 'waiting',
      waiting_on: 'confirmation cfm_7q2 since 2026-11-11',
      evidence: '0/1 checks passed',
      steps: '1/2 done (s2 waiting_confirmation cfm_7q2)',
      carry: 0,
    });
  });

  it('AC-07-01 a repeated claim prints no-op and exits 0 (C-03-01)', async () => {
    const argv = [
      'items',
      'claim',
      'A-0150',
      '--evidence',
      'https://example.com/notes/onboarding-checklist',
    ];
    const first = await cli(profile.path, argv);
    expect(first.code).toBe(0);
    expect(first.output['status']).toBe('ok');
    const again = await cli(profile.path, argv);
    expect(again.code).toBe(0);
    expect(again.output['status']).toBe('no-op');
  });

  it('AC-07-01 errors print error:, code: and help on stdout with exit 1, usage errors exit 2', async () => {
    const missing = await cli(profile.path, ['items', 'view', 'A-9999']);
    expect(missing.code).toBe(1);
    expect(missing.stdout.split('\n').slice(0, 2)).toEqual([
      'error: no action item A-9999',
      'code: E_NOT_FOUND',
    ]);
    const usage = await cli(profile.path, ['items', 'list', '--limit', '0']);
    expect(usage.code).toBe(2);
    expect(usage.output['code']).toBe('E_USAGE');
    const json = await cli(profile.path, ['items', 'view', 'A-9999', '--format', 'json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('AC-07-01 an unknown subcommand exits 2; a human-only verb points to the app', async () => {
    const run = await cli(profile.path, ['items', 'drop', 'A-0142']);
    expect(run.code).toBe(2);
    expect(run.output['help']).toContain(
      'drop is done by the user in the app; open it there (04 §4.3)',
    );
    expect(core.calls).toEqual([]);
  });

  it('a principal without the scope gets E_FORBIDDEN from the API (07 §5)', async () => {
    const argv = [
      'decisions',
      'propose',
      '--workstream',
      'alderwick',
      '--question',
      'Phased pricing?',
    ];
    const refused = await cli(profile.path, argv);
    expect(refused.code).toBe(1);
    expect(refused.output['code']).toBe('E_FORBIDDEN');
    const allowed = await cli(profile.path, [...argv, '--principal', 'claude-code']);
    expect(allowed.output['status']).toBe('ok');
    const fromEnv = await cli(profile.path, argv, { CC_PRINCIPAL: 'claude-code' });
    expect(fromEnv.output['status']).toBe('ok');
  });

  it('file: evidence is sent as an absolute path and record: evidence as a connector record', async () => {
    const run = await cli(profile.path, [
      'items',
      'attach',
      'A-0142',
      '--evidence',
      'record:gmail-alderwick/message/a/b',
      '--requirement',
      'er1',
    ]);
    expect(run.code).toBe(0);
    expect(run.output['evidence']).toMatchObject({ kind: 'connector_record', requirement: 'er1' });
    const bad = await cli(profile.path, [
      'items',
      'attach',
      'A-0142',
      '--evidence',
      'record:only-binding',
    ]);
    expect(bad.code).toBe(2);
  });
});
