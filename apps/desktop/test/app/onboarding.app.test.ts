/**
 * P1-15, onboarding in the app (01 §3; 08 §8 item 4): on a fresh profile the app opens the
 * wizard, and the reference scenario typed into S1 to S9 commits the workspace of 01 §7 with
 * the rhythm of 01 §7.3 (02 §8.1). Confirming S9 is the user's alone (04 §4.3). After a restart
 * the committed profile opens Home.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHeadless } from '@cc/core/headless';
import { createProfileDir, FakeTimerClock, type ProfileDir } from '@cc/test-kit';

import { launchApp, type RunningApp } from './electron.ts';

let profile: ProfileDir;
let running: RunningApp;

beforeAll(async () => {
  profile = createProfileDir();
  running = await launchApp(profile.path);
});

afterAll(async () => {
  await running?.close();
  profile?.cleanup();
});

/** Fills an input by its `data-test`. */
const type = (id: string, value: string) => running.byTest(id).fill(value);
const press = (id: string) => running.byTest(id).click();
const choose = (id: string, value: string) => running.byTest(id).selectOption(value);
const heading = () => running.page.locator('h1, h2').allTextContents();

describe('P1-15 onboarding in the app', () => {
  it('a fresh profile opens the wizard at S1', async () => {
    await running.byTest('workspace-zone').waitFor();
    await expect(heading()).resolves.toContain('Set up Command Center');
  });

  it('the scenario typed into S1 to S9 commits the workspace of 01 §7 with the rhythm of 01 §7.3, and the app opens Home', async () => {
    // S1: the workspace, its second working range, the protected blocks and quiet hours
    await type('workspace-zone', 'Asia/Kolkata');
    await type('hours-new-start', '18:00');
    await type('hours-new-end', '23:00');
    await press('hours-add');
    for (const [label, start, minutes, policy] of [
      ['Evening block', '18:00', '300', 'hard'],
      ['Afternoon break', '14:00', '60', 'hard'],
      ['Deep block A', '09:45', '180', 'soft'],
    ] as const) {
      await type('block-label', label);
      await type('block-start', start);
      await type('block-minutes', minutes);
      await choose('block-policy', policy);
      await press('block-add');
    }
    await type('quiet-new-start', '23:30');
    await type('quiet-new-end', '08:00');
    await press('quiet-add');
    await press('onboarding-save');

    // S2: the two companies
    for (const name of ['Alderwick', 'Quillmarsh']) {
      await type('stream-name', name);
      await press('stream-add');
    }
    await running.page.getByText('quillmarsh').first().waitFor();
    await press('onboarding-save');

    // S3: their profiles
    await choose('business-alderwick', 'mixed_services_product');
    await choose('goal-alderwick', 'grow_revenue');
    await choose('stage-quillmarsh', 'pre_revenue');
    await choose('business-quillmarsh', 'product');
    await choose('goal-quillmarsh', 'launch');
    await press('onboarding-save');

    // S4: the recommendation of 01 §7.2
    await expect(running.byTest('rec-alderwick').textContent()).resolves.toMatch(/eos-lite.*solo/);
    await press('onboarding-save');

    // S5: a scorecard line a pack suggests, with its target, and a priority with its done-means
    await press('suggest-alderwick-client_hours_vs_plan');
    await type('measure-value-alderwick', '90');
    await press('measure-add-alderwick');
    await expect(running.byTest('measure-alderwick-0').textContent()).resolves.toMatch(
      /Client hours logged against plan.*gte 90/,
    );
    await type('goal-title-alderwick', 'Win two consulting clients');
    await type('goal-done-alderwick', 'Two signed engagements');
    await press('goal-add-alderwick');
    await press('onboarding-save');

    // S6: about 174 minutes a week; the quarterly and annual sessions sit in the soft block
    await expect(running.byTest('time-budget').textContent()).resolves.toMatch(
      /About 174 minutes a week/,
    );
    const confirmations = running.page.locator('[data-test^="confirm-placement-"]');
    await expect(confirmations.count()).resolves.toBe(2);
    for (const left of [1, 0]) {
      await press('confirm-placement-0');
      await expect.poll(() => confirmations.count()).toBe(left);
    }
    await press('onboarding-save');

    // S7: LinkedIn for both, later; the team task tracker (owner decision C2)
    await choose('tool-category', 'social');
    await type('tool-name', 'LinkedIn');
    await running.byTest('tool-workstream-alderwick').check();
    await running.byTest('tool-workstream-quillmarsh').check();
    await choose('tool-choice', 'later');
    await press('tool-add');
    await choose('tracker', 'sheet');
    await running.byTest('tracker-workstream-alderwick').check();
    await press('tracker-set');
    await press('onboarding-save');

    // S8: the AI choice is recorded; nothing runs until P3
    await choose('ai-provider', 'claude_cli');
    await press('onboarding-save');

    // S9: the full preview, then the user's Confirm
    await expect(running.byTest('preview-alderwick').textContent()).resolves.toMatch(/eos-lite/);
    await expect(running.byTest('onboarding-confirm').isEnabled()).resolves.toBe(true);
    await press('onboarding-confirm');
    await running.byTest('nav-home').and(running.page.locator('[aria-current="page"]')).waitFor();
  });

  it('after a restart the committed profile opens Home, and the store holds the 02 §8.1 series', async () => {
    await running.close();
    running = await launchApp(profile.path);
    await running.byTest('nav-home').and(running.page.locator('[aria-current="page"]')).waitFor();
    await running.close();

    const core = await startHeadless({
      profileDir: profile.path,
      clock: new FakeTimerClock(new Date()),
      env: {},
    });
    try {
      const series = core.store
        .read((tx) => tx.list('meeting_series'))
        .map((s) => [s.name, s.rrule, s.durationMinutes] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
      expect(series).toEqual([
        ['Annual review', 'FREQ=YEARLY;BYMONTH=12;BYDAY=2FR;BYHOUR=9;BYMINUTE=45', 240],
        ['Daily shutdown', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=17;BYMINUTE=20', 10],
        ['Daily start', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', 10],
        ['Monthly review', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0', 90],
        ['Quarterly planning', 'FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-2FR;BYHOUR=9;BYMINUTE=45', 240],
        ['Weekly CEO review', 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0', 60],
      ]);
      const workstreams = core.store
        .read((tx) => tx.list('workstreams'))
        .map((w) => w.slug)
        .sort();
      expect(workstreams).toEqual(['alderwick', 'quillmarsh', 'workspace']);
    } finally {
      await core.stop();
    }
  });
});
