/**
 * P1-15, the meeting runner in the app (02 §4.7, §6.3, §6.4; 08 §8 item 4): only the user
 * starts a meeting, confirms its read-back and closes it (02 §4.2 rule 1, 04 §4.3). The profile
 * is the reference scenario on Fri 2026-11-13 at 14:59, the first weekly review prepared by its
 * pre-read job; a `commandcenter://meeting/<ref>` link opens the app on it (02 §9.2 rule 2).
 * The scorecard's Goals tab edit is on the same profile (owner decision Q2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHeadless } from '@cc/core/headless';
import { createProfileDir, FakeTimerClock, seedScenario, type ProfileDir } from '@cc/test-kit';

import { flashSays, launchApp, type RunningApp } from './electron.ts';

let profile: ProfileDir;
let running: RunningApp;
let weekly = '';

beforeAll(async () => {
  profile = createProfileDir();
  const s = await seedScenario({ profileDir: profile.path });
  try {
    await s.advanceTo('2026-11-13T14:59');
    const { meetings } = await s.user<{
      meetings: { ref: string; title: string; state: string }[];
    }>('meetings.list', { from: '2026-11-13', to: '2026-11-13' });
    const found = meetings.find((m) => m.title === 'Weekly CEO review');
    expect(found?.state).toBe('prepared');
    weekly = found?.ref ?? '';
  } finally {
    await s.stop();
  }
  running = await launchApp(profile.path, `commandcenter://meeting/${weekly}`);
});

afterAll(async () => {
  await running?.close();
  profile?.cleanup();
});

describe('P1-15 the meeting runner in the app', () => {
  it('the deep link opens the weekly review with its merged agenda, and only the user starts it', async () => {
    await expect(running.page.locator('h1').textContent()).resolves.toBe(
      `Weekly CEO review ${weekly}`,
    );
    await expect(running.byTest('meeting-header').textContent()).resolves.toMatch(
      /Fri 13 Nov, 15:00 · 60 min/,
    );
    const agenda = running.byTest('agenda');
    await expect(agenda.locator('[data-test^="section-action_review-"]').count()).resolves.toBe(2);
    await running.byTest('start-meeting').click();
    await flashSays(running, 'Meeting started.');
  });

  it('C-02-04 working the agenda in order, an item captured in the issues section is read back before the meeting can close, then the user closes it', async () => {
    // Sections are worked in order (02 §4.7): Next section moves the timer to the next one.
    const current = running.page.locator('[aria-current="step"]');
    for (let step = 0; step < 20; step += 1) {
      if ((await current.getAttribute('data-test')) === 'section-issues') break;
      await current.locator('[data-test="next-section"]').click();
    }
    await expect(current.getAttribute('data-test')).resolves.toBe('section-issues');
    const capture = current.locator('[data-test="capture-issues"]');
    await capture
      .locator('[data-test="capture-title"]')
      .fill('Set up the posting calendar for weeks 48 to 50');
    await capture.locator('[data-test="capture-due"]').fill('2026-11-18');
    await capture
      .locator('[data-test="capture-done-means"]')
      .fill('Each Alderwick and Quillmarsh post for weeks 48 to 50 has a date in the calendar.');
    await capture.locator('[data-test="capture-workstream"]').selectOption('alderwick');
    await capture.locator('[data-test="capture-item"]').click();
    await flashSays(running, 'Item captured as a draft; the read-back accepts it.');

    const readBack = running.byTest('read-back');
    await expect(readBack.textContent()).resolves.toMatch(
      /Set up the posting calendar.*self.*due 2026-11-18/,
    );
    // C-02-04: no Close before the read-back is confirmed.
    await expect(running.byTest('close-meeting').count()).resolves.toBe(0);
    await running.byTest('read-back-done').click();
    await flashSays(running, 'Read-back confirmed: the drafts read back are accepted.');
    await running.byTest('close-meeting').click();
    await flashSays(running, 'Meeting closed.');
  });

  it("AC-03-10 the Goals tab changes a goal's title and target outside any meeting, and its history shows the one change", async () => {
    await running.byTest('nav-scorecard').click();
    await running.byTest('tab-goals').click();
    await running.byTest('goal-G-0001').locator('button.link').click();
    const form = running.byTest('goal-form');
    await form
      .locator('[data-test="goal-title"]')
      .fill('Win two consulting clients by the end of the quarter');
    await form.locator('[data-test="target-from"]').fill('0');
    await form.locator('[data-test="target-to"]').fill('2');
    await form.locator('[data-test="target-unit"]').fill('clients');
    await form.locator('[data-test="target-by"]').fill('2026-12-31');
    await running.byTest('save-goal').click();
    await flashSays(running, 'G-0001 saved; the change is in its history.');
    const history = running.byTest('goal-history');
    await expect(history.locator('[data-test="goal-event-goal.updated"]').count()).resolves.toBe(1);
    await expect(history.locator('[data-test="change-title"]').count()).resolves.toBe(1);
    await expect(history.locator('[data-test="change-target"]').count()).resolves.toBe(1);
  });

  it('the store holds the closed meeting, the accepted item and the goal change after the app closes', async () => {
    await running.close();
    const core = await startHeadless({
      profileDir: profile.path,
      clock: new FakeTimerClock('2026-11-13T11:00:00Z'),
      env: {},
    });
    try {
      const view = (await core.callAsUser('meetings.get', { ref: weekly })) as {
        meeting: { state: string; outputs: { actionItemIds: string[] } };
      };
      expect(view.meeting.state).toBe('completed');
      const [id] = view.meeting.outputs.actionItemIds;
      const { item } = (await core.callAsUser('items.get', { ref: id })) as {
        item: { lifecycle: string; title: string };
      };
      expect(item).toMatchObject({
        lifecycle: 'open',
        title: 'Set up the posting calendar for weeks 48 to 50',
      });
      const { goals } = (await core.callAsUser('goals.list', {})) as { goals: { title: string }[] };
      expect(goals.map((goal) => goal.title)).toContain(
        'Win two consulting clients by the end of the quarter',
      );
    } finally {
      await core.stop();
    }
  });
});
