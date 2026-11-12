/**
 * The onboarding wizard (09 P1-12; 01 §3): S1 to S9 with all 67 questions of 01 §3.1, the
 * first start (01 §1 item 7, AC-08-11), manual entry through to the commit, the S1 backup
 * answers, and the time-budget fix of S6 (AC-01-04). The renderer runs headless against a real
 * core in its own profile directory, as the user (04 §4.3 rule 1); the one call main answers
 * itself, the backup passphrase, is played by the test as main plays it (src/main/ipc.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCore, type CoreService } from '@cc/core';
import { OnboardingProfile, type OnboardingStep } from '@cc/schemas';
import { createProfileDir, FakeTimerClock, type ProfileDir } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { QUESTIONS, STEPS } from '../../src/renderer/screens/onboarding/questions.js';
import { allByTest, byTest, queryByTest, textOf, type VNode } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type, type Answer, type Harness } from './harness.js';

/** These tests run a real core and compose the whole rhythm; slow CI runners need longer than vitest's 5 s. */
const SLOW_MS = 60_000;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const NOW = '2026-11-04T04:10:00.000Z';

function fixture(name: string): OnboardingProfile {
  return OnboardingProfile.parse(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/onboarding', name), 'utf8')),
  );
}

interface Live {
  readonly core: CoreService;
  readonly app: Harness;
  /** What main put in the secret store (src/main/ipc.ts). */
  readonly secrets: string[];
}

const opened: { core: CoreService; profile: ProfileDir }[] = [];
afterEach(async () => {
  for (const { core, profile } of opened.splice(0)) {
    await core.stop();
    profile.cleanup();
  }
});

/** The app over a real core: every method goes to the core as the user. */
async function live(setup?: (core: CoreService) => Promise<void>): Promise<Live> {
  const profile = createProfileDir();
  const core = await startCore({
    userData: profile.path,
    clock: new FakeTimerClock(NOW),
    env: {},
    validateResults: true,
  });
  opened.push({ core, profile });
  await setup?.(core);
  const secrets: string[] = [];
  const answers = new Proxy({} as Record<string, Answer>, {
    get:
      (_target, method: string): Answer =>
      async (params) => {
        if (method === 'backups.passphrase') {
          // main keeps the passphrase and tells the core only that it is set
          secrets.push(String(params['passphrase']));
          return core.callAsUser(method, {});
        }
        return core.callAsUser(method, params);
      },
  });
  const app = await startApp(answers, { screen: 'onboarding' }, Date.parse(NOW));
  return { core, app, secrets };
}

async function settle(app: Harness): Promise<void> {
  for (let i = 0; i < 5; i += 1) await app.settle();
}

async function open(app: Harness, step: OnboardingStep): Promise<void> {
  app.app.ui.go({ screen: 'onboarding', step });
  await settle(app);
}

async function press(app: Harness, test: string): Promise<void> {
  await click(app, byTest(app.tree(), test));
  await settle(app);
}

function choose(node: VNode, value: string): void {
  const onInput = node.props.onInput;
  if (onInput === undefined) throw new Error(`<${node.tag}> is not a select`);
  onInput(value);
}

function tick(node: VNode, checked: boolean): void {
  const onCheck = node.props.onCheck;
  if (onCheck === undefined) throw new Error(`<${node.tag}> is not a checkbox`);
  onCheck(checked);
}

describe('the first start (01 §1 item 7)', { timeout: SLOW_MS }, () => {
  it('AC-08-11 the app opens onboarding on first start, and Home once onboarding is committed', async () => {
    const { app, core } = await live();
    await app.app.start();
    await settle(app);
    expect(app.app.route).toEqual({ screen: 'onboarding' });
    expect(queryByTest(app.tree(), 'step-workspace')).toBeDefined();

    await core.callAsUser('onboarding.apply', { profile: fixture('sample-profile.json') });
    await app.app.start();
    await settle(app);
    expect(app.app.route).toEqual({ screen: 'home' });
  });
});

describe('S1 to S9 (01 §3)', { timeout: SLOW_MS }, () => {
  it('asks all 67 questions of 01 §3.1, each in its step', async () => {
    expect(QUESTIONS.map((q) => q.row)).toEqual(Array.from({ length: 67 }, (_, i) => i + 1));
    const counts = Object.fromEntries(
      STEPS.map((step) => [step.id, QUESTIONS.filter((q) => q.step === step.id).length]),
    );
    // 01 §3.1: S1 10, S2 8, S3 15, S4 1, S5 12, S6 5, S7 8, S8 5, S9 3
    expect(counts).toEqual({
      workspace: 10,
      workstreams: 8,
      profiles: 15,
      recommendation: 1,
      tailoring: 12,
      rhythm: 5,
      tools: 8,
      ai: 5,
      commit: 3,
    });

    const { app } = await live((core) =>
      core
        .callAsUser('onboarding.save', { profile: fixture('sample-profile.json') })
        .then(() => undefined),
    );
    for (const step of STEPS) {
      await open(app, step.id);
      const tree = app.tree();
      expect(queryByTest(tree, `step-${step.id}`), step.id).toBeDefined();
      for (const question of QUESTIONS.filter((q) => q.step === step.id)) {
        expect(
          allByTest(tree, `q-${String(question.row)}`).length,
          `row ${String(question.row)} at ${step.id}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('manual entry: the scenario typed into S1 to S9 commits the workspace of 01 §7, with the rhythm of 01 §7.3', async () => {
    const { app, core } = await live();
    await app.app.start();
    await settle(app);

    // S1
    let tree = app.tree();
    type(byTest(tree, 'workspace-zone'), 'Asia/Kolkata');
    type(byTest(tree, 'hours-new-start'), '18:00');
    type(byTest(tree, 'hours-new-end'), '23:00');
    await press(app, 'hours-add');
    const blocks = [
      ['Evening block', '18:00', '300', 'hard'],
      ['Afternoon break', '14:00', '60', 'hard'],
      ['Deep block A', '09:45', '180', 'soft'],
    ] as const;
    for (const [label, start, minutes, policy] of blocks) {
      tree = app.tree();
      type(byTest(tree, 'block-label'), label);
      type(byTest(tree, 'block-start'), start);
      type(byTest(tree, 'block-minutes'), minutes);
      choose(byTest(tree, 'block-policy'), policy);
      await press(app, 'block-add');
    }
    tree = app.tree();
    type(byTest(tree, 'quiet-new-start'), '23:30');
    type(byTest(tree, 'quiet-new-end'), '08:00');
    await press(app, 'quiet-add');
    await press(app, 'onboarding-save');
    expect(app.app.route).toEqual({ screen: 'onboarding', step: 'workstreams' });

    // S2
    for (const name of ['Alderwick', 'Quillmarsh']) {
      type(byTest(app.tree(), 'stream-name'), name);
      await press(app, 'stream-add');
    }
    expect(textOf(app.tree())).toContain('quillmarsh');
    await press(app, 'onboarding-save');

    // S3
    tree = app.tree();
    choose(byTest(tree, 'business-alderwick'), 'mixed_services_product');
    choose(byTest(tree, 'goal-alderwick'), 'grow_revenue');
    choose(byTest(tree, 'stage-quillmarsh'), 'pre_revenue');
    choose(byTest(tree, 'business-quillmarsh'), 'product');
    choose(byTest(tree, 'goal-quillmarsh'), 'launch');
    await press(app, 'onboarding-save');

    // S4: the recommendation of 01 §7.2 (before S7 adds the social tool behind M7)
    expect(app.app.route).toEqual({ screen: 'onboarding', step: 'recommendation' });
    expect(textOf(byTest(app.tree(), 'rec-alderwick'))).toMatch(/eos-lite.*solo/);
    await press(app, 'onboarding-save');

    // S5: a scorecard line suggested by a pack, with its target, and a priority with its done-means
    await press(app, 'suggest-alderwick-client_hours_vs_plan');
    type(byTest(app.tree(), 'measure-value-alderwick'), '90');
    await press(app, 'measure-add-alderwick');
    expect(textOf(byTest(app.tree(), 'measure-alderwick-0'))).toMatch(
      /Client hours logged against plan.*gte 90/,
    );
    tree = app.tree();
    type(byTest(tree, 'goal-title-alderwick'), 'Win two consulting clients');
    type(byTest(tree, 'goal-done-alderwick'), 'Two signed engagements');
    await press(app, 'goal-add-alderwick');
    await press(app, 'onboarding-save');

    // S6: the quarterly and annual sessions sit in the soft Deep block A; confirm both
    expect(app.app.route).toEqual({ screen: 'onboarding', step: 'rhythm' });
    expect(textOf(byTest(app.tree(), 'time-budget'))).toMatch(/About 174 minutes a week/);
    await press(app, 'confirm-placement-0');
    await press(app, 'confirm-placement-0');
    expect(queryByTest(app.tree(), 'confirm-placement-0')).toBeUndefined();
    await press(app, 'onboarding-save');

    // S7: LinkedIn for both, and the team task tracker (owner decision C2)
    tree = app.tree();
    choose(byTest(tree, 'tool-category'), 'social');
    type(byTest(tree, 'tool-name'), 'LinkedIn');
    tick(byTest(tree, 'tool-workstream-alderwick'), true);
    tick(byTest(tree, 'tool-workstream-quillmarsh'), true);
    choose(byTest(tree, 'tool-choice'), 'later');
    await press(app, 'tool-add');
    tree = app.tree();
    choose(byTest(tree, 'tracker'), 'sheet');
    tick(byTest(tree, 'tracker-workstream-alderwick'), true);
    await press(app, 'tracker-set');
    await press(app, 'onboarding-save');

    // S8
    choose(byTest(app.tree(), 'ai-provider'), 'claude_cli');
    await press(app, 'onboarding-save');

    // S9: the full preview, then Confirm
    expect(app.app.route).toEqual({ screen: 'onboarding', step: 'commit' });
    tree = app.tree();
    expect(textOf(byTest(tree, 'preview-alderwick'))).toMatch(/eos-lite/);
    const confirm = byTest(tree, 'onboarding-confirm');
    expect(confirm.props.disabled).toBe(false);
    expect(core.store.read((tx) => tx.list('workspace'))).toHaveLength(0);
    await press(app, 'onboarding-confirm');

    expect(app.app.route).toEqual({ screen: 'home' });
    // Rows come back in ID order; IDs are random within a millisecond, so compare sorted.
    const records = core.store.read((tx) => ({
      workstreams: tx
        .list('workstreams')
        .map((w) => w.slug)
        .sort(),
      series: tx
        .list('meeting_series')
        .map((s) => [s.name, s.rrule, s.durationMinutes] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
      packs: tx
        .list('framework_instances')
        .map((i) => [tx.get('workstreams', i.workstreamId)?.slug, i.packIds] as const)
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      measures: tx.list('measures').map((m) => m.name),
      goals: tx.list('goals').map((g) => [g.title, g.doneMeans]),
      tools: tx.get('onboarding', 'onb_main')?.profile.tools.map((t) => t.category),
    }));
    expect(records.workstreams).toEqual(['alderwick', 'quillmarsh', 'workspace']);
    expect(records.series).toEqual([
      ['Annual review', 'FREQ=YEARLY;BYMONTH=12;BYDAY=2FR;BYHOUR=9;BYMINUTE=45', 240],
      ['Daily shutdown', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=17;BYMINUTE=20', 10],
      ['Daily start', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', 10],
      ['Monthly review', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0', 90],
      ['Quarterly planning', 'FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-2FR;BYHOUR=9;BYMINUTE=45', 240],
      ['Weekly CEO review', 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0', 60],
    ]);
    // M7 fired once S7 named LinkedIn as a social tool of both (01 §6.3)
    expect(records.packs).toEqual([
      ['alderwick', ['pack.client-services', 'pack.product', 'pack.marketing']],
      ['quillmarsh', ['pack.product', 'pack.marketing']],
    ]);
    expect(records.measures).toEqual(['Client hours logged against plan']);
    expect(records.goals).toEqual([['Win two consulting clients', 'Two signed engagements']]);
    expect(records.tools).toEqual(['social', 'task_tracker']);
  });

  it('a step can be skipped and resumed: Skip moves on without marking it answered', async () => {
    const { app, core } = await live();
    await app.app.start();
    await settle(app);
    await press(app, 'onboarding-skip');
    expect(app.app.route).toEqual({ screen: 'onboarding', step: 'workstreams' });
    expect(await core.callAsUser('onboarding.status', {})).toMatchObject({ state: 'not_started' });
  });
});

describe('S1 backups (01 §3.1 rows 9 and 10, 04 §9.1)', { timeout: SLOW_MS }, () => {
  it('the passphrase goes to the secret store and the destination is recorded; both stay out of a profile.json', async () => {
    const { app, core, secrets } = await live();
    await app.app.start();
    await settle(app);
    let tree = app.tree();
    type(byTest(tree, 'backup-passphrase'), 'correct horse battery staple');
    type(byTest(tree, 'backup-passphrase-confirm'), 'correct horse battery stapler');
    await press(app, 'backup-passphrase-set');
    expect(textOf(app.tree())).toMatch(/The two passphrases differ/);
    expect(secrets).toEqual([]);

    tree = app.tree();
    type(byTest(tree, 'backup-passphrase'), 'correct horse battery staple');
    type(byTest(tree, 'backup-passphrase-confirm'), 'correct horse battery staple');
    await press(app, 'backup-passphrase-set');
    expect(secrets).toEqual(['correct horse battery staple']);
    expect(textOf(app.tree())).toMatch(/passphrase set/);

    tree = app.tree();
    type(byTest(tree, 'backup-label'), 'Synced folder');
    type(byTest(tree, 'backup-path'), '/tmp/cc-sync');
    await press(app, 'backup-destination-set');
    const status = (await core.callAsUser('onboarding.status', {})) as {
      appOnly: { row: number; answered: boolean }[];
      profile: OnboardingProfile;
    };
    expect(status.appOnly.slice(0, 2)).toEqual([
      { row: 9, question: 'Backup passphrase', answered: true },
      { row: 10, question: 'Off-machine backup destination', answered: true },
    ]);
    expect(JSON.stringify(status.profile)).not.toContain('correct horse');
    const exported = (await core.callAsUser('onboarding.export', {})) as {
      profile: OnboardingProfile;
    };
    expect(exported.profile.workspace.backup).toBeUndefined();
  });
});

describe('S6 and the time budget (01 §6.4)', { timeout: SLOW_MS }, () => {
  it('AC-01-04 over the budget, Confirm stays disabled until one of the four fixes is picked', async () => {
    const scenario = fixture('scenario.json');
    const tight = {
      ...scenario,
      workspace: { ...scenario.workspace, weeklyManagementMinutes: 160 },
    };
    const { app } = await live((core) =>
      core.callAsUser('onboarding.save', { profile: tight }).then(() => undefined),
    );
    await open(app, 'commit');
    expect(textOf(byTest(app.tree(), 'commit-blockers'))).toMatch(/W-TIME-BUDGET/);
    expect(byTest(app.tree(), 'onboarding-confirm').props.disabled).toBe(true);

    await open(app, 'rhythm');
    const fix = byTest(app.tree(), 'time-budget-fix');
    expect(fix.children.map((option) => textOf(option))).toEqual([
      'Choose…',
      'Merge more meetings',
      'Shorten meetings to their minimums',
      'Move personal-os weekly reviews to every other week',
      'Raise the budget',
    ]);
    choose(fix, 'raise_budget');
    await settle(app);
    await open(app, 'commit');
    expect(queryByTest(app.tree(), 'commit-blockers')).toBeUndefined();
    expect(byTest(app.tree(), 'onboarding-confirm').props.disabled).toBe(false);
  });
});
