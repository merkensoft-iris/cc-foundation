/**
 * The Items screen (09 P1-11; 03 §7, §9.2): the review queue's Confirm, Attest and Reject with
 * owner decision Q5 (AC-03-09), drafts, the list and the detail.
 */
import type { ActionItem, Evidence } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import type { ItemReview } from '../../src/renderer/app/api.js';
import { byTest, queryByTest, textOf } from '../../src/renderer/ui/vnode.js';
import { apiError, click, startApp, type } from './harness.js';

function claimed(ref: string, extra: Partial<ActionItem> = {}): ActionItem {
  return {
    id: `act_${ref}`,
    ref,
    title: 'Send the revised proposal',
    doneMeans: 'The lead has the proposal',
    lifecycle: 'claimed_done',
    health: 'on_track',
    due: { date: '2026-11-12', timeZone: 'Asia/Kolkata' },
    carryCount: 0,
    escalationLevel: 0,
    evidenceRequirements: [
      { id: 'er1', description: 'The sent message', required: true, acceptedKinds: ['note'] },
    ],
    claim: { at: '2026-11-12T05:30:00Z', by: { kind: 'user' } },
    ...extra,
  } as unknown as ActionItem;
}

const note: Evidence = {
  id: 'evd_1',
  actionItemId: 'act_A-0142',
  kind: 'note',
  summary: 'Sent from my phone',
  requirementId: 'er1',
} as unknown as Evidence;

const noteOnly: ItemReview = {
  item: claimed('A-0142'),
  evidence: [note],
  review: {
    confirm: {
      enabled: false,
      reason: 'No checkable evidence for er1: only a note. Attest instead.',
    },
    attest: { enabled: true },
    reject: { enabled: true },
    notCheckable: ['er1'],
  },
};

function queue(reviews: ItemReview[]) {
  return {
    'items.list': (params: Record<string, unknown>) =>
      params['state'] === 'claimed_done'
        ? {
            items: reviews.map((r) => ({
              ref: r.item.ref,
              title: r.item.title,
              due: r.item.due.date,
              state: 'claimed_done',
            })),
            total: reviews.length,
          }
        : { items: [], total: 0 },
    'items.review': (params: Record<string, unknown>) =>
      reviews.find((r) => r.item.ref === params['ref']) ?? noteOnly,
  };
}

describe('the review queue (owner decision Q5)', () => {
  it('AC-03-09 a claim backed only by a note: Confirm is disabled with its reason shown, Attest is enabled and records the attestation with its note', async () => {
    const answers = {
      ...queue([noteOnly]),
      'items.attest': () => ({
        status: 'ok',
        item: claimed('A-0142', { lifecycle: 'verified_done' }),
      }),
    };
    const app = await startApp(answers, { screen: 'items', tab: 'review' });
    const card = byTest(app.tree(), 'review-A-0142');

    const confirm = byTest(card, 'confirm');
    expect(confirm.props.disabled).toBe(true);
    expect(confirm.props.title).toMatch(/No checkable evidence for er1/);
    expect(textOf(byTest(card, 'confirm-reason'))).toBe(
      'No checkable evidence for er1: only a note. Attest instead.',
    );
    expect(byTest(card, 'attest').props.disabled).toBe(false);
    expect(textOf(card)).toMatch(
      /Attested items count as done and are reported apart from verified ones/,
    );

    // Attest needs its note.
    await click(app, byTest(card, 'attest'));
    expect(app.callsOf('items.attest')).toEqual([]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/needs a note/);

    type(byTest(byTest(app.tree(), 'review-A-0142'), 'attest-note'), 'Checked the sent folder');
    await click(app, byTest(byTest(app.tree(), 'review-A-0142'), 'attest'));
    expect(app.callsOf('items.attest')).toEqual([
      { ref: 'A-0142', note: 'Checked the sent folder' },
    ]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/attested: done, counted apart/);
  });

  it('Confirm is enabled with checkable evidence and confirms; Reject needs a reason', async () => {
    const checkable: ItemReview = {
      item: claimed('A-0160'),
      evidence: [{ ...note, kind: 'url', summary: 'https://example.com/post' } as Evidence],
      review: {
        confirm: { enabled: true },
        attest: { enabled: true },
        reject: { enabled: true },
        notCheckable: [],
      },
    };
    const answers = {
      ...queue([checkable]),
      'items.confirm': () => ({
        status: 'ok',
        item: claimed('A-0160', { lifecycle: 'verified_done' }),
      }),
      'items.reject': () => ({
        status: 'ok',
        item: claimed('A-0160', { lifecycle: 'in_progress' }),
      }),
    };
    const app = await startApp(answers, { screen: 'items', tab: 'review' });
    const card = byTest(app.tree(), 'review-A-0160');
    expect(queryByTest(card, 'confirm-reason')).toBeUndefined();
    await click(app, byTest(card, 'confirm'));
    expect(app.callsOf('items.confirm')).toEqual([{ ref: 'A-0160' }]);

    await click(app, byTest(byTest(app.tree(), 'review-A-0160'), 'reject'));
    expect(app.callsOf('items.reject')).toEqual([]);
    type(byTest(byTest(app.tree(), 'review-A-0160'), 'reject-reason'), 'Wrong post');
    await click(app, byTest(byTest(app.tree(), 'review-A-0160'), 'reject'));
    expect(app.callsOf('items.reject')).toEqual([{ ref: 'A-0160', reason: 'Wrong post' }]);
  });

  it('shows an empty queue, and an API refusal as the message', async () => {
    const empty = await startApp(queue([]), { screen: 'items', tab: 'review' });
    expect(empty.text()).toMatch(/Nothing is waiting for review/);

    const checkable: ItemReview = {
      ...noteOnly,
      review: { ...noteOnly.review, confirm: { enabled: true } },
    };
    const app = await startApp(
      {
        ...queue([checkable]),
        'items.confirm': () => {
          throw apiError('E_INVARIANT', 'No checkable evidence for er1');
        },
      },
      { screen: 'items', tab: 'review' },
    );
    await click(app, byTest(byTest(app.tree(), 'review-A-0142'), 'confirm'));
    expect(textOf(byTest(app.tree(), 'flash'))).toBe('No checkable evidence for er1');
  });
});

describe('drafts, the list and the detail', () => {
  it('accepts a draft, and drops one only with a reason', async () => {
    const answers = {
      'items.list': () => ({
        items: [
          {
            ref: 'A-0201',
            title: 'Book the venue',
            due: '2026-11-20',
            state: 'draft',
            owner: 'self',
          },
        ],
        total: 1,
      }),
      'items.accept': () => ({ status: 'ok' }),
      'items.drop': () => ({ status: 'ok' }),
    };
    const app = await startApp(answers, { screen: 'items', tab: 'drafts' });
    await click(app, byTest(byTest(app.tree(), 'draft-card-A-0201'), 'accept'));
    expect(app.callsOf('items.accept')).toEqual([{ ref: 'A-0201' }]);

    await click(app, byTest(byTest(app.tree(), 'draft-card-A-0201'), 'drop'));
    expect(app.callsOf('items.drop')).toEqual([]);
    type(byTest(byTest(app.tree(), 'draft-card-A-0201'), 'drop-reason'), 'Venue not needed');
    await click(app, byTest(byTest(app.tree(), 'draft-card-A-0201'), 'drop'));
    expect(app.callsOf('items.drop')).toEqual([{ ref: 'A-0201', reason: 'Venue not needed' }]);
  });

  it('lists active items with owner, workstream and health, and opens an item with its history', async () => {
    const answers = {
      'items.list': () => ({
        items: [
          {
            ref: 'A-0142',
            title: 'Send the revised proposal',
            due: '2026-11-12',
            state: 'overdue',
            owner: 'self',
            workstream: 'alderwick',
            health: 'at_risk',
          },
        ],
        total: 1,
      }),
      'items.review': () => noteOnly,
      'items.history': () => ({
        events: [
          {
            id: 'evt_1',
            at: '2026-11-12T05:30:00Z',
            type: 'action_item.claimed',
            actor: { kind: 'user' },
            entity: { kind: 'action_item', id: 'act_A-0142' },
          },
        ],
        total: 1,
      }),
    };
    const app = await startApp(answers, { screen: 'items' });
    expect(app.callsOf('items.list')[0]).toMatchObject({
      state: 'active',
      fields: ['owner', 'health', 'workstream'],
    });
    const row = byTest(app.tree(), 'item-A-0142');
    expect(textOf(row)).toMatch(/alderwick.*self.*2026-11-12.*overdue.*at risk/);

    const open = row.children[0] as never as { children: { props: { onClick: () => void } }[] };
    open.children[0]?.props.onClick();
    await app.settle();
    expect(app.app.route).toEqual({ screen: 'items', ref: 'A-0142' });
    expect(textOf(byTest(app.tree(), 'history'))).toMatch(/action_item.claimed by user/);
    // A claimed item's detail carries the review card (the deep link commandcenter://items/<ref>).
    expect(byTest(app.tree(), 'confirm').props.disabled).toBe(true);
  });
});
