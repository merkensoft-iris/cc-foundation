/**
 * Onboarding through the local API (01 §3, §9.1; 09 P1-12): the saved answers, the recommender,
 * the preview (`apply --dry-run`), the commit in one transaction, the export, and the
 * app-only backup answers. Each test runs a real core in its own profile directory with a fixed
 * clock: onboarding on 2026-11-04, as in the reference scenario (README §4).
 */
import fs from 'node:fs';
import path from 'node:path';

import { OnboardingProfile, type Scope } from '@cc/schemas';
import { FakeTimerClock, makeCanary } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { Meetings } from '../src/meetings.js';
import { ALL_SCOPES, rejection, repoRoot, startTestCore, type TestCore } from './helpers.js';

/** These tests run a real core and compose the whole rhythm; slow CI runners need longer than vitest's 5 s. */
const SLOW_MS = 60_000;

const NOW = '2026-11-04T04:10:00.000Z';

function fixture(name: string): OnboardingProfile {
  return OnboardingProfile.parse(
    JSON.parse(fs.readFileSync(path.join(repoRoot(), 'fixtures/onboarding', name), 'utf8')),
  );
}

type Preview = {
  workstreams: { key: string; framework?: string }[];
  frameworkInstances: {
    workstream: string;
    templateId: string;
    mode: string;
    packs: string[];
    firedRules: string[];
    parameters: Record<string, unknown>;
  }[];
  series: {
    name: string;
    cadence: string;
    rrule: string;
    dtstart: string;
    durationMinutes: number;
    workstreams: string[];
    meeting: string;
    absorbs?: string;
  }[];
  measures: { ref: string }[];
  goals: { ref: string }[];
  instances: { count: number; first?: string; last?: string };
  timeBudget: { averageWeeklyMinutes: number; weeklyManagementMinutes: number };
  warnings: { code: string; text: string }[];
  blockers: { code: string; text: string; help: string[] }[];
  outwardActions: { kind: string; text: string }[];
  rhythmStartsOn: string;
};

const cores: TestCore[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.dispose();
});

async function core(): Promise<TestCore> {
  const started = await startTestCore({ clock: new FakeTimerClock(NOW) });
  cores.push(started);
  return started;
}

/** Grants `cli-default` more scopes, as the user does in Settings → Agent access (07 §5 rule 3). */
async function grant(test: TestCore, ...scopes: Scope[]): Promise<void> {
  await test.core.callAsUser('principals.update', {
    name: 'cli-default',
    scopes: [...new Set(['read', ...scopes])],
  });
}

function rows(test: TestCore): Record<string, number> {
  return test.core.store.read((tx) => ({
    workspace: tx.list('workspace').length,
    persons: tx.list('persons').length,
    workstreams: tx.list('workstreams').length,
    framework_instances: tx.list('framework_instances').length,
    measures: tx.list('measures').length,
    goals: tx.list('goals').length,
    meeting_series: tx.list('meeting_series').length,
    meeting_instances: tx.list('meeting_instances').length,
    onboarding: tx.list('onboarding').length,
    events: tx.events().length,
  }));
}

/** The 02 §8.1 series of the reference scenario, in the order the composer makes them. */
const SCENARIO_SERIES = [
  ['Daily start', 'daily', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', 10],
  ['Daily shutdown', 'daily', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=17;BYMINUTE=20', 10],
  ['Weekly CEO review', 'weekly', 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0', 60],
  ['Monthly review', 'monthly', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0', 90],
  [
    'Quarterly planning',
    'quarterly',
    'FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-2FR;BYHOUR=9;BYMINUTE=45',
    240,
  ],
  ['Annual review', 'yearly', 'FREQ=YEARLY;BYMONTH=12;BYDAY=2FR;BYHOUR=9;BYMINUTE=45', 240],
] as const;

function expectScenarioRhythm(preview: Preview): void {
  // 01 §7.2
  expect(
    preview.frameworkInstances.map((i) => [
      i.workstream,
      i.templateId,
      i.mode,
      i.packs,
      i.firedRules,
    ]),
  ).toEqual([
    [
      'alderwick',
      'eos-lite',
      'solo',
      ['pack.client-services', 'pack.product', 'pack.marketing'],
      ['R8', 'M2', 'M5', 'M6', 'M7', 'M8'],
    ],
    [
      'quillmarsh',
      'eos-lite',
      'solo',
      ['pack.product', 'pack.marketing'],
      ['R8', 'M2', 'M6', 'M7', 'M8'],
    ],
  ]);
  // 01 §7.3 and 02 §8.1
  expect(preview.series.map((s) => [s.name, s.cadence, s.rrule, s.durationMinutes])).toEqual(
    SCENARIO_SERIES.map((row) => [...row]),
  );
  expect(preview.series.every((s) => s.workstreams.join() === 'alderwick,quillmarsh')).toBe(true);
  expect(preview.series.find((s) => s.meeting === 'monthly')?.absorbs).toBe('weekly (30 min)');
  expect(preview.rhythmStartsOn).toBe('2026-11-09');
  expect(Object.fromEntries(preview.series.map((s) => [s.meeting, s.dtstart]))).toMatchObject({
    weekly: '2026-11-13T15:00',
    monthly: '2026-11-27T15:00',
    quarterly: '2026-12-18T09:45',
    yearly: '2026-12-11T09:45',
  });
  // T1: 160 minutes a week, about 174 with the monthly absorption (01 §7.3)
  expect(Math.round(preview.timeBudget.averageWeeklyMinutes)).toBe(174);
  expect(preview.blockers).toEqual([]);
}

describe('onboarding status and the saved answers (01 §3)', { timeout: SLOW_MS }, () => {
  it('a new profile has not started; each saved step persists and names the next one', async () => {
    const test = await core();
    expect(await test.core.callAsUser('onboarding.status', {})).toMatchObject({
      state: 'not_started',
      completedSteps: [],
      nextStep: 'workspace',
      workstreams: 0,
    });
    const profile = { ...fixture('scenario.json'), completedSteps: [] };
    const saved = await test.core.callAsUser('onboarding.save', { profile, step: 'workspace' });
    expect(saved).toEqual({ status: 'ok', completedSteps: ['workspace'], nextStep: 'workstreams' });
    expect(
      await test.core.callAsUser('onboarding.save', {
        profile: { ...profile, completedSteps: ['workspace'] },
      }),
    ).toMatchObject({ status: 'no-op' });

    const status = (await test.core.callAsUser('onboarding.status', {})) as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'in_progress', nextStep: 'workstreams', workstreams: 2 });
    expect(status['profile']).toBeDefined();
    // C-01-01: saving answers writes no record but the answers
    expect(rows(test)).toMatchObject({
      workspace: 0,
      workstreams: 0,
      meeting_series: 0,
      onboarding: 1,
    });

    // An agent sees where onboarding stands, never the answers themselves.
    const client = await test.connect();
    const agent = await client.call<Record<string, unknown>>('onboarding.status', {});
    expect(agent['state']).toBe('in_progress');
    expect(agent['profile']).toBeUndefined();
  });

  it('01 §3 rule 1: S4 is not marked answered before S3', async () => {
    const test = await core();
    const profile = { ...fixture('scenario.json'), completedSteps: ['workspace' as const] };
    const error = await rejection(
      test.core.callAsUser('onboarding.save', { profile, step: 'recommendation' }),
    );
    expect(error.code).toBe('E_USAGE');
  });
});

describe('the recommender over the API (01 §6, C-01-02)', { timeout: SLOW_MS }, () => {
  it('AC-01-01 recommends the 01 §7.2 templates for the saved answers and for a file alike', async () => {
    const test = await core();
    const client = await test.connect();
    const result = await client.call<{
      recommendations: { workstreamKey: string; templateId: string; firedRules: string[] }[];
    }>('onboarding.recommend', { profile: fixture('scenario.json') });
    expect(
      result.recommendations.map((r) => [r.workstreamKey, r.templateId, r.firedRules]),
    ).toEqual([
      ['alderwick', 'eos-lite', ['R8', 'M2', 'M5', 'M6', 'M7', 'M8']],
      ['quillmarsh', 'eos-lite', ['R8', 'M2', 'M6', 'M7', 'M8']],
    ]);
    const none = await rejection(client.call('onboarding.recommend', {}));
    expect(none.code).toBe('E_NOT_FOUND');
  });
});

describe('apply --dry-run and apply (C-01-07, C-01-01)', { timeout: SLOW_MS }, () => {
  it('AC-01-10 previewing fixtures/onboarding/sample-profile.json on a fresh profile writes nothing and shows the templates of 01 §7.2 and the series of 01 §7.3', async () => {
    const test = await core();
    const client = await test.connect();
    await client.call('onboarding.status', {});
    const before = rows(test);
    const { preview } = await client.call<{ preview: Preview }>('onboarding.preview', {
      profile: fixture('sample-profile.json'),
    });
    expectScenarioRhythm(preview);
    expect(preview.measures.map((m) => m.ref)).toEqual([
      'K-0001',
      'K-0002',
      'K-0003',
      'K-0004',
      'K-0006',
      'K-0007',
      'K-0008',
    ]);
    // "per plan" lines wait for a target; priorities without a done-means are warned about
    expect(preview.warnings.filter((w) => w.code === 'W-DEFERRED').map((w) => w.text)).toEqual([
      expect.stringContaining('Invoices raised'),
      expect.stringContaining('Active users or pilots'),
    ]);
    expect(rows(test)).toEqual(before);
  });

  it('AC-01-06 the dry run of scenario.json previews every record and writes nothing; apply writes them all in one transaction, and no calendar event exists', async () => {
    const test = await core();
    const client = await test.connect();
    const before = rows(test);
    const { preview } = await client.call<{ preview: Preview }>('onboarding.preview', {
      profile: fixture('scenario.json'),
    });
    expectScenarioRhythm(preview);
    expect(preview.workstreams.map((w) => [w.key, w.framework])).toEqual([
      ['alderwick', 'eos-lite'],
      ['quillmarsh', 'eos-lite'],
      ['workspace', undefined],
    ]);
    expect(preview.outwardActions.filter((a) => a.kind === 'calendar_batch')).toHaveLength(1);
    expect(rows(test)).toEqual(before);

    // cli-default has no onboarding:apply until the user grants it (07 §5 rule 3).
    const refused = await rejection(
      client.call('onboarding.apply', { profile: fixture('scenario.json') }),
    );
    expect(refused.code).toBe('E_FORBIDDEN');
    await grant(test, 'onboarding:apply');
    const applied = await client.call<{ status: string; committedAt: string; preview: Preview }>(
      'onboarding.apply',
      { profile: fixture('scenario.json') },
    );
    expect(applied.status).toBe('ok');
    expect(applied.committedAt).toBe(NOW);

    const after = rows(test);
    expect(after).toMatchObject({
      workspace: 1,
      persons: 1,
      workstreams: 3,
      framework_instances: 2,
      meeting_series: 6,
      onboarding: 1,
    });
    expect(after['meeting_instances']).toBe(preview.instances.count);
    expect(after['meeting_instances']).toBeGreaterThan(100);
    // one transaction: every record's event carries the commit's correlation
    const events = test.core.store.read((tx) => tx.events());
    const created = events.filter(
      (e) => e.type.endsWith('.created') && e.entity.kind !== 'agent_principal',
    );
    expect(created.length).toBeGreaterThan(100);
    expect(created.every((e) => e.correlationId === 'onboarding.commit')).toBe(true);
    // No calendar event before the separate confirmation: every instance is only planned.
    const states = test.core.store.read((tx) => tx.list('meeting_instances').map((m) => m.state));
    // (absorbed: the weekly review the monthly review takes over on its last Friday, 02 §4.3)
    expect(new Set(states)).toEqual(new Set(['planned', 'absorbed']));

    expect(await client.call('onboarding.status', {})).toMatchObject({
      state: 'committed',
      committedAt: NOW,
    });
    const again = await rejection(
      client.call('onboarding.apply', { profile: fixture('scenario.json') }),
    );
    expect(again.code).toBe('E_CONFLICT');
    // The workspace pseudo-workstream exists once (03 §5.2, owner decision Q4).
    const kinds = test.core.store.read((tx) => tx.list('workstreams').map((w) => w.kind));
    expect(kinds.filter((kind) => kind === 'workspace')).toHaveLength(1);
  });

  it('AC-01-04 with a budget of 160 the scenario commit is blocked by W-TIME-BUDGET until the user picks one of the four fixes', async () => {
    const test = await core();
    const base = fixture('scenario.json');
    const tight = { ...base, workspace: { ...base.workspace, weeklyManagementMinutes: 160 } };
    const { preview } = (await test.core.callAsUser('onboarding.preview', { profile: tight })) as {
      preview: Preview;
    };
    const [blocker] = preview.blockers;
    expect(blocker?.code).toBe('W-TIME-BUDGET');
    expect(blocker?.help.join(' ')).toMatch(/merge, shorten, biweekly or raise_budget/);
    const error = await rejection(test.core.callAsUser('onboarding.apply', { profile: tight }));
    expect(error.code).toBe('E_INVARIANT');
    expect(error.message).toMatch(/W-TIME-BUDGET/);
    expect(rows(test)['workspace']).toBe(0);

    for (const fix of ['merge', 'shorten', 'biweekly', 'raise_budget'] as const) {
      const picked = { ...tight, rhythm: { ...base.rhythm!, timeBudgetFix: fix } };
      const result = (await test.core.callAsUser('onboarding.preview', { profile: picked })) as {
        preview: Preview;
      };
      expect(result.preview.blockers, fix).toEqual([]);
      expect(
        result.preview.warnings.some((w) => w.code === 'W-TIME-BUDGET'),
        fix,
      ).toBe(true);
    }
    const shortened = (await test.core.callAsUser('onboarding.preview', {
      profile: { ...tight, rhythm: { ...base.rhythm!, timeBudgetFix: 'shorten' } },
    })) as { preview: Preview };
    expect(shortened.preview.series.find((s) => s.meeting === 'weekly')?.durationMinutes).toBe(45);
    const raised = (await test.core.callAsUser('onboarding.preview', {
      profile: { ...tight, rhythm: { ...base.rhythm!, timeBudgetFix: 'raise_budget' } },
    })) as { preview: Preview };
    expect(raised.preview.timeBudget.weeklyManagementMinutes).toBe(174);

    const applied = await test.core.callAsUser('onboarding.apply', {
      profile: { ...tight, rhythm: { ...base.rhythm!, timeBudgetFix: 'raise_budget' } },
    });
    expect(applied).toMatchObject({ status: 'ok' });
  });

  it('02 §4.6 a session inside a soft block needs the user to confirm it at S6 before the commit', async () => {
    const test = await core();
    const unconfirmed = {
      ...fixture('scenario.json'),
      rhythm: { dailyStart: true, dailyShutdown: true, acceptedOverlaps: [] },
    };
    const { preview } = (await test.core.callAsUser('onboarding.preview', {
      profile: unconfirmed,
    })) as {
      preview: Preview;
    };
    expect(preview.blockers.map((b) => b.text)).toEqual([
      expect.stringMatching(/^Quarterly planning .* soft protected block Deep block A/),
      expect.stringMatching(/^Annual review .* soft protected block Deep block A/),
    ]);
    const error = await rejection(
      test.core.callAsUser('onboarding.apply', { profile: unconfirmed }),
    );
    expect(error.code).toBe('E_INVARIANT');
  });

  it('C-01-04 an S5 parameter outside its bounds is refused with E_PARAM_BOUNDS, naming key and bounds', async () => {
    const test = await core();
    const sample = fixture('sample-profile.json');
    const tailoring = sample.tailoring!.map((t) =>
      t.workstreamKey === 'alderwick'
        ? { ...t, parameters: { ...t.parameters, priorityCount: 7 } }
        : t,
    );
    const error = await rejection(
      test.core.callAsUser('onboarding.preview', { profile: { ...sample, tailoring } }),
    );
    expect(error.code).toBe('E_PARAM_BOUNDS');
    expect(error.message).toMatch(/priorityCount = 7/);
    expect(error.help.join(' ')).toMatch(/1 to 5/);
  });

  it('C-01-07 a profile missing a required answer is E_USAGE naming the JSON pointer', async () => {
    const test = await core();
    const client = await test.connect();
    const broken = JSON.parse(JSON.stringify(fixture('scenario.json'))) as Record<string, unknown>;
    delete (broken['workspace'] as Record<string, unknown>)['timeZone'];
    const error = await rejection(client.call('onboarding.preview', { profile: broken }));
    expect(error.code).toBe('E_USAGE');
    expect(error.message).toMatch(/workspace\.timeZone|\/workspace\/timeZone/);
  });
});

describe('export (01 §9.1, C-01-09)', { timeout: SLOW_MS }, () => {
  it('AC-01-09 the export of the committed scenario holds no person name, client name or secret, and applying it on a fresh profile previews the same instances and series', async () => {
    const person = makeCanary('person');
    const client = makeCanary('client');
    const secret = makeCanary('secret');
    const base = fixture('scenario.json');
    const scenario: OnboardingProfile = {
      ...base,
      workstreams: [
        ...base.workstreams.map((w) => ({ ...w, notes: `Retainer with ${client}` })),
        {
          ...base.workstreams[0]!,
          key: 'goal-area',
          kind: 'personal',
          name: `${person}'s goal`,
          principal: {
            kind: 'other',
            displayName: person,
            relationship: 'friend',
            timeZone: 'Asia/Kolkata',
            consentNote: `${person} agreed on a call; token ${secret}`,
          },
        },
      ],
      rhythm: {
        ...base.rhythm!,
        acceptedOverlaps: [
          ...base.rhythm!.acceptedOverlaps,
          {
            workstreamKey: 'goal-area',
            meetingKey: 'quarterly',
            blockId: 'pb_deep_a',
            reason: 'soft_block',
          },
        ],
      },
    };
    const first = await core();
    await first.core.callAsUser('onboarding.save', { profile: scenario, step: 'ai' });
    await first.core.callAsUser('backups.destination', {
      destination: { kind: 'folder', label: 'Synced folder', path: `/Users/${person}/Drive/cc` },
    });
    await first.core.callAsUser('onboarding.apply', {});
    const expected = (await first.core.callAsUser('onboarding.preview', {})) as {
      preview: Preview;
    };

    const agent = await first.connect();
    const { profile } = await agent.call<{ profile: OnboardingProfile }>('onboarding.export', {});
    const text = JSON.stringify(profile);
    for (const canary of [person, client, secret]) expect(text).not.toContain(canary);
    expect(profile.workstreams.map((w) => w.name)).toEqual([
      'alderwick',
      'quillmarsh',
      'goal-area',
    ]);
    expect(profile.workspace.backup).toBeUndefined();

    const fresh = await core();
    const reader = await fresh.connect();
    const { preview } = await reader.call<{ preview: Preview }>('onboarding.preview', { profile });
    const shape = (p: Preview) => ({
      instances: p.frameworkInstances.map((i) => [
        i.workstream,
        i.templateId,
        i.mode,
        i.packs,
        i.firedRules,
      ]),
      series: p.series.map((s) => [s.name, s.rrule, s.dtstart, s.durationMinutes, s.workstreams]),
    });
    expect(shape(preview)).toEqual(shape(expected.preview));
  });
});

describe('the app-only answers (01 §3.1 rows 9 and 10, 04 §4.3)', { timeout: SLOW_MS }, () => {
  it('the backup passphrase and destination are human-only, and a profile from an agent cannot carry them', async () => {
    const test = await core();
    await grant(test, ...ALL_SCOPES);
    const client = await test.connect();
    for (const method of ['backups.passphrase', 'backups.destination']) {
      const error = await rejection(client.call(method, {}));
      expect(error.code, method).toBe('E_HUMAN_REQUIRED');
    }
    const withBackup = {
      ...fixture('scenario.json'),
      workspace: { ...fixture('scenario.json').workspace, backup: { passphraseSet: true } },
    };
    for (const method of ['onboarding.save', 'onboarding.preview', 'onboarding.apply']) {
      const error = await rejection(client.call(method, { profile: withBackup }));
      expect(error.code, method).toBe('E_USAGE');
      expect(error.help.join(' ')).toMatch(/rows 9 and 10/);
    }

    // The user answers them in the app; saving other answers keeps them.
    await test.core.callAsUser('onboarding.save', {
      profile: fixture('scenario.json'),
      step: 'workspace',
    });
    expect(await test.core.callAsUser('backups.passphrase', {})).toEqual({
      status: 'ok',
      passphraseSet: true,
    });
    expect(
      await test.core.callAsUser('backups.destination', {
        destination: { kind: 'folder', label: 'Synced folder', path: '/tmp/cc-backups' },
      }),
    ).toEqual({ status: 'ok' });
    await test.core.callAsUser('onboarding.save', {
      profile: fixture('scenario.json'),
      step: 'workstreams',
    });
    const status = (await test.core.callAsUser('onboarding.status', {})) as {
      appOnly: { row: number; answered: boolean }[];
      profile: OnboardingProfile;
    };
    expect(status.appOnly.map((a) => [a.row, a.answered])).toEqual([
      [9, true],
      [10, true],
      [66, false],
      [67, false],
    ]);
    expect(status.profile.workspace.backup).toMatchObject({
      passphraseSet: true,
      destination: { label: 'Synced folder' },
    });
    // The event log names the destination by label only.
    const logged = test.core.store
      .read((tx) => tx.events())
      .filter((e) => e.type === 'onboarding.backup_set');
    expect(JSON.stringify(logged)).not.toContain('/tmp/cc-backups');
  });
});

describe('the Q-T08 answers drive escalation (01 §8, 02 §7.2)', { timeout: SLOW_MS }, () => {
  it("an item escalates to E3 after its workstream's own overdue days, not the default 30", async () => {
    const levelAfter = async (overdueDays: number | undefined): Promise<number> => {
      const test = await startTestCore({
        clock: new FakeTimerClock('2026-12-01T00:00:00Z'),
        seed: (item) => {
          const { waitingOn: _waiting, ...rest } = item;
          void _waiting;
          return {
            ...rest,
            lifecycle: 'open',
            due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' },
          };
        },
      });
      cores.push(test);
      if (overdueDays !== undefined) {
        const sample = fixture('sample-profile.json');
        const tailoring = sample.tailoring!.map((t) =>
          t.workstreamKey === 'alderwick'
            ? { ...t, escalation: { ...t.escalation, e3OverdueDays: overdueDays } }
            : t,
        );
        test.core.store.command({ actor: { kind: 'user' } }, (tx) => {
          tx.insert('onboarding', {
            id: 'onb_main',
            profile: { ...sample, tailoring },
            committedAt: NOW,
            createdAt: NOW,
            createdBy: { kind: 'user' },
            updatedAt: NOW,
            updatedBy: { kind: 'user' },
            version: 1,
          });
          tx.event({
            type: 'onboarding.committed',
            entity: { kind: 'onboarding', id: 'onb_main' },
          });
        });
      }
      new Meetings(test.core.store, { clock: test.core.clock }).escalate();
      const item = test.core.store.read((tx) =>
        tx.list('action_items').find((i) => i.ref === 'A-0142'),
      );
      return item?.escalationLevel ?? -1;
    };
    // 2026-12-01 is 18 days after the due date: past 14, short of the default 30.
    expect(await levelAfter(14)).toBe(3);
    expect(await levelAfter(undefined)).toBeLessThan(3);
  });
});
