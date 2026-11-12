/**
 * `cc-axi onboarding status | recommend | apply | export` in-process against the real core in
 * headless mode (07 §4.2; 01 §3, §9.1; 09 P1-12).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { emptyData } from './support/fixture-api.ts';
import { cli } from './support/run.ts';
import { startTestCore, type TestCore } from './support/core.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SAMPLE = join(ROOT, 'fixtures', 'onboarding', 'sample-profile.json');
const SCENARIO = join(ROOT, 'fixtures', 'onboarding', 'scenario.json');

const opened: { profile: ProfileDir; core: TestCore }[] = [];
afterEach(async () => {
  for (const { profile, core } of opened.splice(0)) {
    await core.close();
    profile.cleanup();
  }
});

async function start(data?: Parameters<typeof startTestCore>[0]['data']) {
  const profile = createProfileDir();
  const core = await startTestCore({
    profileDir: profile.path,
    ...(data === undefined ? {} : { data }),
  });
  opened.push({ profile, core });
  return { dir: profile.path, core };
}

function rowCount(core: TestCore): number {
  return core.core.store.read(
    (tx) =>
      tx.list('workspace').length +
      tx.list('workstreams').length +
      tx.list('meeting_series').length +
      tx.list('meeting_instances').length +
      tx.list('onboarding').length,
  );
}

describe('cc-axi onboarding status', () => {
  it('shows a committed workspace, the steps answered and the app-only answers', async () => {
    const { dir } = await start();
    const run = await cli(dir, ['onboarding', 'status']);
    expect(run.code).toBe(0);
    expect(run.output['onboarding']).toMatchObject({
      state: 'committed',
      workstreams: 2,
      next_step: '',
    });
    expect(run.output['app_only']).toEqual([
      { row: 9, question: 'Backup passphrase', answered: false },
      { row: 10, question: 'Off-machine backup destination', answered: false },
      { row: 66, question: 'Approve the first calendar write batch', answered: false },
      { row: 67, question: 'Sign in to each service', answered: false },
    ]);
    expect(run.output['help']).toBeUndefined();
  });

  it('shows not_started on a profile nobody has onboarded yet', async () => {
    const { dir } = await start(emptyData());
    const run = await cli(dir, ['onboarding', 'status']);
    expect(run.code).toBe(0);
    expect(run.output['onboarding']).toMatchObject({
      state: 'not_started',
      next_step: 'workspace',
    });
  });
});

describe('cc-axi onboarding recommend', () => {
  it('AC-01-01 recommends the 01 §7.2 templates for a profile.json', async () => {
    const { dir } = await start(emptyData());
    const run = await cli(dir, ['onboarding', 'recommend', '--file', SCENARIO]);
    expect(run.code).toBe(0);
    expect(run.output['recommendations']).toEqual([
      {
        workstream: 'alderwick',
        template: 'eos-lite',
        mode: 'solo',
        packs: 'pack.client-services pack.product pack.marketing',
        fired_rules: 'R8 M2 M5 M6 M7 M8',
        merge_group: 'weekly-ceo-review',
        privacy: 'normal',
        alternatives: '4dx personal-os',
      },
      {
        workstream: 'quillmarsh',
        template: 'eos-lite',
        mode: 'solo',
        packs: 'pack.product pack.marketing',
        fired_rules: 'R8 M2 M6 M7 M8',
        merge_group: 'weekly-ceo-review',
        privacy: 'normal',
        alternatives: '4dx personal-os',
      },
    ]);
  });

  it('a missing --file is a usage error, exit 2; a file that is not a profile is E_USAGE naming the pointer', async () => {
    const { dir } = await start(emptyData());
    const missing = await cli(dir, ['onboarding', 'recommend']);
    expect(missing.code).toBe(2);
    expect(missing.output['code']).toBe('E_USAGE');
    const wrong = await cli(dir, ['onboarding', 'recommend', '--file', join(ROOT, 'package.json')]);
    expect(wrong.code).toBe(2);
    expect(wrong.output['code']).toBe('E_USAGE');
  });
});

describe('cc-axi onboarding apply', () => {
  it('AC-01-10 apply --file sample-profile.json --dry-run on a fresh profile exits 0, writes nothing, and previews the templates, modes, packs and rules of 01 §7.2 and the series of 01 §7.3', async () => {
    const { dir, core } = await start(null);
    const before = rowCount(core);
    const run = await cli(dir, ['onboarding', 'apply', '--file', SAMPLE, '--dry-run']);
    expect(run.code).toBe(0);
    expect(run.output).toMatchObject({ status: 'ok', dry_run: true, wrote: 'nothing' });
    expect(run.output['framework_instances']).toEqual([
      {
        workstream: 'alderwick',
        template: 'eos-lite 1.0.0',
        mode: 'solo',
        goal_model: 'rocks',
        packs: 'pack.client-services pack.product pack.marketing',
        fired_rules: 'R8 M2 M5 M6 M7 M8',
      },
      {
        workstream: 'quillmarsh',
        template: 'eos-lite 1.0.0',
        mode: 'solo',
        goal_model: 'rocks',
        packs: 'pack.product pack.marketing',
        fired_rules: 'R8 M2 M6 M7 M8',
      },
    ]);
    const series = run.output['series'] as { name: string; rrule: string; minutes: number }[];
    expect(series.map((s) => [s.name, s.minutes])).toEqual([
      ['Daily start', 10],
      ['Daily shutdown', 10],
      ['Weekly CEO review', 60],
      ['Monthly review', 90],
      ['Quarterly planning', 240],
      ['Annual review', 240],
    ]);
    expect(run.output['time_budget']).toEqual({ average_weekly_minutes: 173.8, budget: 240 });
    expect(run.output['blockers']).toEqual([]);
    expect(rowCount(core)).toBe(before);
  });

  it('AC-01-06 without --dry-run every record exists after one transaction, once the user granted onboarding:apply', async () => {
    const { dir, core } = await start(null);
    const refused = await cli(dir, ['onboarding', 'apply', '--file', SCENARIO]);
    expect(refused.code).toBe(1);
    expect(refused.output['code']).toBe('E_FORBIDDEN');
    expect(rowCount(core)).toBe(0);

    await core.core.callAsUser('principals.update', {
      name: 'cli-default',
      scopes: ['read', 'onboarding:apply'],
    });
    const run = await cli(dir, ['onboarding', 'apply', '--file', SCENARIO]);
    expect(run.code).toBe(0);
    expect(run.output['status']).toBe('ok');
    const counts = core.core.store.read((tx) => ({
      workstreams: tx.list('workstreams').length,
      series: tx.list('meeting_series').length,
      scheduled: tx.list('meeting_instances').filter((m) => m.state === 'scheduled').length,
    }));
    expect(counts).toEqual({ workstreams: 3, series: 6, scheduled: 0 });
    expect(
      (run.output['outward_actions'] as string[]).some((a) => a.startsWith('calendar_batch:')),
    ).toBe(true);
  });
});

describe('cc-axi onboarding export', () => {
  it('AC-01-09 writes the answers with workstreams by key and no names, notes or app-only answers; the same export again is a no-op', async () => {
    const { dir } = await start();
    const out = mkdtempSync(join(tmpdir(), 'cc-export-'));
    try {
      const file = join(out, 'profile.json');
      const run = await cli(dir, ['onboarding', 'export', '--out', file]);
      expect(run.code).toBe(0);
      expect(run.output).toMatchObject({ status: 'ok', workstreams: 2 });
      const written = JSON.parse(readFileSync(file, 'utf8')) as {
        workstreams: { key: string; name: string; notes?: string }[];
        workspace: Record<string, unknown>;
        completedSteps: string[];
      };
      expect(written.workstreams.map((w) => [w.key, w.name, w.notes])).toEqual([
        ['alderwick', 'alderwick', undefined],
        ['quillmarsh', 'quillmarsh', undefined],
      ]);
      expect(written.workspace['backup']).toBeUndefined();
      expect(written.completedSteps).not.toContain('commit');
      const again = await cli(dir, ['onboarding', 'export', '--out', file]);
      expect(again.output['status']).toBe('no-op');

      const fresh = await start(null);
      const replay = await cli(fresh.dir, ['onboarding', 'apply', '--file', file, '--dry-run']);
      expect(replay.code).toBe(0);
      expect((replay.output['series'] as unknown[]).length).toBe(6);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
