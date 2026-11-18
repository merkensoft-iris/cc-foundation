/**
 * P1-15, the review queue in the app (03 §9.2; owner decision Q5; 08 §8 item 4): confirming,
 * attesting, rejecting and accepting are human-only (04 §4.3), so the app is the only place they
 * happen. The profile is the reference scenario on Tue 2026-11-10, after the scenario's agent
 * claimed three items and drafted a fourth through the local API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHeadless } from '@cc/core/headless';
import { createProfileDir, FakeTimerClock, seedScenario, type ProfileDir } from '@cc/test-kit';

import { flashSays, launchApp, type RunningApp } from './electron.ts';

let profile: ProfileDir;
let running: RunningApp;
const refs = { proposal: '', form: '', batch: '', draft: '' };

beforeAll(async () => {
  profile = createProfileDir();
  const s = await seedScenario({ profileDir: profile.path });
  try {
    await s.advanceTo('2026-11-10T11:00');
    refs.proposal = s.ref('A-0142');
    refs.form = s.ref('A-0144');
    refs.batch = s.ref('A-0160');
    await s.agent('items.claim', {
      ref: refs.form,
      evidence: [
        {
          kind: 'url',
          url: 'https://example.invalid/quillmarsh/site/pull/12',
          requirementId: 'er1',
        },
        {
          kind: 'url',
          url: 'https://example.invalid/quillmarsh/contact?sent=1',
          requirementId: 'er2',
        },
      ],
    });
    await s.agent('items.claim', {
      ref: refs.batch,
      evidence: [{ kind: 'note', text: 'Three posts are scheduled.', requirementId: 'er1' }],
    });
    await s.agent('items.claim', {
      ref: refs.proposal,
      evidence: [
        { kind: 'url', url: 'https://example.invalid/alderwick/proposal-v2', requirementId: 'er1' },
      ],
    });
    const drafted = await s.agent<{ item: { ref: string } }>('items.create', {
      workstream: 'quillmarsh',
      title: 'Write the pilot onboarding checklist',
      due: '2026-11-20',
      doneMeans: 'The checklist is in the Quillmarsh folder and covers sign-up to first use.',
      evidence: ['The checklist file in the Quillmarsh folder'],
    });
    refs.draft = drafted.item.ref;
  } finally {
    await s.stop();
  }
  running = await launchApp(profile.path);
  await running.byTest('nav-items').click();
  await running.byTest('tab-review').click();
});

afterAll(async () => {
  await running?.close();
  profile?.cleanup();
});

/** What the store holds once the app is closed, read through the local API as the user. */
async function itemsAfter(...items: string[]) {
  await running.close();
  const core = await startHeadless({
    profileDir: profile.path,
    clock: new FakeTimerClock('2026-11-10T06:00:00Z'),
    env: {},
  });
  try {
    return await Promise.all(
      items.map(
        async (ref) =>
          ((await core.callAsUser('items.get', { ref })) as { item: Record<string, unknown> }).item,
      ),
    );
  } finally {
    await core.stop();
  }
}

describe('P1-15 the review queue in the app', () => {
  it('AC-03-09 a claim backed only by a note: Confirm is disabled with its reason shown, and Attest with a note closes it as attested', async () => {
    const card = running.byTest(`review-${refs.batch}`);
    await expect(card.locator('[data-test="confirm"]').isDisabled()).resolves.toBe(true);
    await expect(card.locator('[data-test="confirm-reason"]').textContent()).resolves.toMatch(
      /only a note/,
    );
    await card
      .locator('[data-test="attest-note"]')
      .fill('Seen in the scheduler: three posts queued.');
    await card.locator('[data-test="attest"]').click();
    await flashSays(running, `${refs.batch} attested`);
  });

  it('a claim with checkable evidence for every requirement is confirmed: verified done', async () => {
    const card = running.byTest(`review-${refs.form}`);
    await expect(card.locator('[data-test="confirm"]').isEnabled()).resolves.toBe(true);
    await card.locator('[data-test="confirm"]').click();
    await flashSays(running, `${refs.form} confirmed: verified done.`);
  });

  it('AC-03-05 rejecting a claim with a reason puts the item back in progress, at risk', async () => {
    const card = running.byTest(`review-${refs.proposal}`);
    await card
      .locator('[data-test="reject-reason"]')
      .fill('The proposal was filed but not sent to the lead.');
    await card.locator('[data-test="reject"]').click();
    await flashSays(running, `${refs.proposal} rejected: back in progress, at risk.`);
  });

  it("accepting the agent's draft makes it open", async () => {
    await running.byTest('tab-drafts').click();
    await running.byTest(`draft-${refs.draft}`).locator('[data-test="accept"]').click();
    await flashSays(running, `${refs.draft} accepted: now open.`);
  });

  it('the store holds each outcome after the app closes', async () => {
    const [batch, form, proposal, draft] = await itemsAfter(
      refs.batch,
      refs.form,
      refs.proposal,
      refs.draft,
    );
    expect(batch).toMatchObject({
      lifecycle: 'verified_done',
      verification: { method: 'attested' },
    });
    expect(form).toMatchObject({
      lifecycle: 'verified_done',
      verification: { method: 'confirmed' },
    });
    expect(proposal).toMatchObject({ lifecycle: 'in_progress', health: 'at_risk' });
    expect(draft).toMatchObject({ lifecycle: 'open' });
  });
});
