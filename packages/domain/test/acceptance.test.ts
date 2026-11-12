/**
 * The acceptance criteria of P1-03 (09 §6.1): AC-03-01, AC-03-05 and AC-03-08 of
 * docs/design/03-decisions-and-action-items.md §15. Each test name starts with its ID, so
 * `pnpm cc:trace` maps it (08 §8 item 8).
 */
import { describe, expect, it } from 'vitest';

import {
  acceptItem,
  actionReviewInput,
  addEvidence,
  claimItem,
  closedOnTime,
  closedOnTimePct,
  createActionItem,
  dropItem,
  registerHealth,
  rejectClaim,
  verifiedShare,
} from '@cc/domain';
import type { ActionItem, Actor, Evidence } from '@cc/schemas';

import { checked, failure, harness, newItem, user } from './harness.js';

describe('AC-03-01 an open item needs doneMeans (INV-03-04)', () => {
  it('AC-03-01 creating an open item without doneMeans fails with E_INVARIANT INV-03-04; creating it as draft succeeds', () => {
    const { ctx } = harness();
    const refused = failure(() =>
      createActionItem(ctx, user, newItem({ doneMeans: '', lifecycle: 'open' })),
    );
    expect(refused.code).toBe('E_INVARIANT');
    expect(refused.rule).toBe('INV-03-04');
    expect(refused.help[0]).toBe('INV-03-04');

    const draft = checked(
      createActionItem(ctx, user, newItem({ doneMeans: '', lifecycle: 'draft' })),
    );
    expect(draft.status).toBe('ok');
    expect(draft.record.lifecycle).toBe('draft');
    expect(draft.record.doneMeans).toBe('');
    expect(draft.changes.map((write) => write.event.type)).toEqual(['action_item.created']);

    // The draft cannot become a commitment until it has a done-means.
    expect(failure(() => acceptItem(ctx, user, draft.record)).rule).toBe('INV-03-04');
  });
});

describe('AC-03-05 a rejected claim goes back to work and to the next action_review', () => {
  it('AC-03-05 rejecting a claim moves the item to in_progress with health at_risk, and the next weekly action_review input includes it', () => {
    // First weekly review on Fri 2026-11-13 (09 §6.1 P1-15); the item is due the next week,
    // so only its claim brings it into the 2026-11-20 review.
    const { ctx, clock } = harness('2026-11-13T05:00:00Z');
    const weekly13End = '2026-11-13T10:30:00Z'; // 16:00 IST
    const weekly20End = '2026-11-20T10:30:00Z';
    const item = checked(
      createActionItem(
        ctx,
        user,
        newItem({ due: { date: '2026-11-25', timeZone: 'Asia/Kolkata' } }),
      ),
    ).record;

    clock.set('2026-11-16T06:00:00Z');
    const evidence: Evidence[] = [
      checked(
        addEvidence(ctx, user, item, [], {
          requirementId: 'er1',
          kind: 'url',
          summary: 'Proposal filed in the client folder',
          url: 'https://files.example/alderwick/proposal-v2.pdf',
        }),
      ).record,
    ];
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    expect(claimed.lifecycle).toBe('claimed_done');

    clock.set('2026-11-17T04:00:00Z');
    const rejected = checked(
      rejectClaim(ctx, user, claimed, 'The proposal is filed but was never sent to the lead'),
    );
    const after = rejected.record;
    expect(after.lifecycle).toBe('in_progress');
    expect(after.health).toBe('at_risk');
    expect(after.healthNote).toBe(
      'Claim rejected: The proposal is filed but was never sent to the lead',
    );
    expect(after.verification?.rejectedClaims).toEqual([
      {
        at: '2026-11-17T04:00:00Z',
        by: { kind: 'user' },
        reason: 'The proposal is filed but was never sent to the lead',
      },
    ]);
    expect(after.verification?.method).toBeUndefined();
    expect(rejected.changes.map((write) => write.event.type)).toEqual([
      'action_item.claim_rejected',
    ]);
    expect(rejected.changes[0]?.event.before).toMatchObject({
      lifecycle: 'claimed_done',
      health: 'on_track',
    });
    expect(rejected.changes[0]?.event.after).toMatchObject({
      lifecycle: 'in_progress',
      health: 'at_risk',
    });

    const input = actionReviewInput([after], {
      workstreamIds: ['ws_ald'],
      instanceEnd: weekly20End,
      previousInstanceEnd: weekly13End,
    });
    expect(input.map((row) => row.ref)).toEqual([after.ref]);

    // Out of scope: another workstream's review does not list it.
    expect(
      actionReviewInput([after], {
        workstreamIds: ['ws_private'],
        instanceEnd: weekly20End,
        previousInstanceEnd: weekly13End,
      }),
    ).toEqual([]);

    // Dropped after the rejection, it leaves the input.
    const dropped = checked(dropItem(ctx, user, after, 'The lead chose another vendor')).record;
    expect(
      actionReviewInput([dropped], {
        workstreamIds: ['ws_ald'],
        instanceEnd: weekly20End,
        previousInstanceEnd: weekly13End,
      }),
    ).toEqual([]);
  });

  it('AC-03-05 a rejected item that falls due before the review ends stays in its input until it is closed', () => {
    const { ctx, clock } = harness('2026-11-13T05:00:00Z');
    const item = checked(createActionItem(ctx, user, newItem())).record; // due 2026-11-13
    const evidence = [
      checked(
        addEvidence(ctx, user, item, [], {
          requirementId: 'er1',
          kind: 'note',
          summary: 'Sent it',
        }),
      ).record,
    ];
    clock.set('2026-11-13T06:00:00Z');
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    const rejected = checked(rejectClaim(ctx, user, claimed, 'No sent message attached')).record;
    // The next weekly review, two weeks on: the claim is older than the previous review, but the
    // item is still in progress and due before the review ends (carry-forward, 02 §7.1 rule 1).
    expect(
      actionReviewInput([rejected], {
        workstreamIds: ['ws_ald'],
        instanceEnd: '2026-11-27T10:30:00Z',
        previousInstanceEnd: '2026-11-20T10:30:00Z',
      }).map((row) => row.ref),
    ).toEqual([rejected.ref]);
  });
});

/**
 * The fixture month: November 2026 in Alderwick (Asia/Kolkata, UTC+05:30), computed the
 * morning after the month ends. Hand computation, per 03 §9.6 as read in metrics.ts:
 *
 * | Item   | Due          | State at asOf                    | Closed (IST)      | On time? | Method    |
 * |--------|--------------|----------------------------------|-------------------|----------|-----------|
 * | A-0301 | 11-05        | verified                         | 11-05 15:30       | yes      | confirmed |
 * | A-0302 | 11-10        | verified                         | 11-09 15:30       | yes      | auto      |
 * | A-0303 | 11-12        | verified                         | 11-13 01:30       | no       | attested  |
 * | A-0304 | 11-20 17:00  | verified                         | 11-20 16:30       | yes      | confirmed |
 * | A-0305 | 11-25        | in_progress (overdue)            |                   | no       |           |
 * | A-0306 | 11-28        | dropped                          |                   | excluded |           |
 * | A-0307 | 10-30        | verified                         | 11-03 15:30       | Oct item | confirmed |
 * | A-0308 | 12-05        | verified                         | 11-27 15:30       | Dec item | confirmed |
 * | A-0309 | 11-30        | claimed_done, not yet reviewed   |                   | excluded |           |
 * | A-0310 | 11-15        | draft                            |                   | excluded |           |
 * | A-0311 | 11-18        | verified (1 rejected claim 11-17)| 11-19 15:30       | no       | confirmed |
 * | A-0312 | 12-02        | in_progress (rejected 12-01 IST) |                   | Dec item |           |
 * | A-0313 | 11-22        | verified (1 rejected claim 11-21)| 11-22 09:30       | yes      | confirmed |
 * | A-0314 | 11-30        | verified                         | 12-01 00:30       | no       | confirmed |
 *
 * Closed on time: items due in November that are verified or overdue: A-0301, -0302, -0303,
 * -0304, -0305, -0311, -0313, -0314 = 8; on time: A-0301, -0302, -0304, -0313 = 4. 4/8 = 50%.
 * Verified share: items verified in November (IST): A-0301, -0302, -0303, -0304, -0307,
 * -0308, -0311, -0313 = 8; auto 1 + confirmed 6 = 7. 7/8; attested 1, reported apart.
 * Rejected claims in November (IST): A-0311 (11-17) and A-0313 (11-21) = 2; A-0312's falls on
 * 12-01 IST.
 */
function monthFixture(): ActionItem[] {
  const self: Actor = { kind: 'user' };
  const review: Actor = { kind: 'system', component: 'review' };
  const base: Omit<ActionItem, 'id' | 'ref' | 'title' | 'due' | 'lifecycle' | 'createdAt'> = {
    workstreamId: 'ws_ald',
    kind: 'todo',
    doneMeans: 'Synthetic fixture item.',
    evidenceRequirements: [
      { id: 'er1', description: 'Evidence', required: true, acceptedKinds: ['url', 'note'] },
    ],
    verificationPolicy: 'require_review',
    ownerId: 'per_self',
    reviewerId: 'per_self',
    informIds: [],
    health: 'on_track',
    execution: { mode: 'manual', steps: [] },
    source: { kind: 'manual' },
    links: { goalIds: [], measureIds: [], decisionIds: [], issueIds: [] },
    carryCount: 0,
    replannedCount: 0,
    escalationLevel: 0,
    privacy: 'normal',
    externalRefs: [],
    createdBy: self,
    updatedAt: '2026-12-01T00:00:00Z',
    updatedBy: self,
    version: 3,
  };
  const item = (
    n: number,
    due: string,
    lifecycle: ActionItem['lifecycle'],
    extra: Partial<ActionItem> = {},
  ): ActionItem => ({
    ...base,
    id: `act_t${n}`,
    ref: `A-0${n}`,
    title: `Fixture item ${n}`,
    due: { date: due, timeZone: 'Asia/Kolkata' },
    lifecycle,
    createdAt: '2026-11-02T04:00:00Z',
    ...extra,
  });
  const done = (
    method: 'auto' | 'confirmed' | 'attested',
    closedAt: string,
    rejectedAt: string[] = [],
  ): Partial<ActionItem> => ({
    verification: {
      method,
      checks:
        method === 'auto'
          ? [{ requirementId: 'er1', status: 'pass', at: closedAt, detail: '1 matched' }]
          : [],
      decidedBy: method === 'auto' ? review : self,
      decidedAt: closedAt,
      ...(method === 'attested' ? { attestationNote: 'Done; the lead confirmed on a call' } : {}),
      rejectedClaims: rejectedAt.map((at) => ({ at, by: self, reason: 'Missing proof' })),
    },
    closedAt,
    closedBy: method === 'auto' ? review : self,
    ...(method === 'auto' ? { verificationPolicy: 'auto_close_on_checks' as const } : {}),
  });
  return [
    item(301, '2026-11-05', 'verified_done', done('confirmed', '2026-11-05T10:00:00Z')),
    item(302, '2026-11-10', 'verified_done', done('auto', '2026-11-09T10:00:00Z')),
    item(303, '2026-11-12', 'verified_done', done('attested', '2026-11-12T20:00:00Z')),
    {
      ...item(304, '2026-11-20', 'verified_done', done('confirmed', '2026-11-20T11:00:00Z')),
      due: { date: '2026-11-20', time: '17:00', timeZone: 'Asia/Kolkata' },
    },
    item(305, '2026-11-25', 'in_progress', {
      carryCount: 2,
      createdAt: '2026-11-01T04:00:00Z',
      health: 'off_track',
      healthNote: 'Overdue',
    }),
    item(306, '2026-11-28', 'dropped', {
      dropReason: 'Superseded by D-0012',
      closedAt: '2026-11-20T05:00:00Z',
      closedBy: self,
    }),
    item(307, '2026-10-30', 'verified_done', done('confirmed', '2026-11-03T10:00:00Z')),
    item(308, '2026-12-05', 'verified_done', done('confirmed', '2026-11-27T10:00:00Z')),
    item(309, '2026-11-30', 'claimed_done', {
      claim: { at: '2026-11-30T12:00:00Z', by: self },
      verification: { checks: [], rejectedClaims: [] },
    }),
    item(310, '2026-11-15', 'draft'),
    item(
      311,
      '2026-11-18',
      'verified_done',
      done('confirmed', '2026-11-19T10:00:00Z', ['2026-11-17T09:00:00Z']),
    ),
    item(312, '2026-12-02', 'in_progress', {
      health: 'at_risk',
      healthNote: 'Claim rejected: Missing proof',
      verification: {
        checks: [],
        rejectedClaims: [{ at: '2026-11-30T20:00:00Z', by: self, reason: 'Missing proof' }],
      },
    }),
    item(
      313,
      '2026-11-22',
      'verified_done',
      done('confirmed', '2026-11-22T04:00:00Z', ['2026-11-21T09:00:00Z']),
    ),
    item(314, '2026-11-30', 'verified_done', done('confirmed', '2026-11-30T19:00:00Z')),
  ];
}

describe('AC-03-08 register metrics over a fixture month', () => {
  const november = { start: '2026-11-01', end: '2026-11-30' };
  const asOf = '2026-12-01T00:30:00Z'; // the nightly run, 06:00 IST on 2026-12-01

  it('AC-03-08 verified share and closed on time computed over a fixture month match hand-computed values', () => {
    const items = monthFixture();
    expect(closedOnTime(items, november, asOf)).toEqual({
      numerator: 4,
      denominator: 8,
      value: 0.5,
    });
    expect(closedOnTimePct(items, november, asOf)).toBe(50);
    expect(verifiedShare(items, november, asOf)).toEqual({
      share: { numerator: 7, denominator: 8, value: 0.875 },
      auto: 1,
      confirmed: 6,
      attested: 1,
    });
  });

  it('AC-03-08 register health lists rejected claims, items carried twice and the oldest open item', () => {
    const health = registerHealth(monthFixture(), november, asOf);
    expect(health.rejectedClaims).toBe(2);
    expect(health.carriedTwiceOrMore).toEqual(['A-0305']);
    expect(health.oldestOpen).toEqual({ ref: 'A-0305', createdAt: '2026-11-01T04:00:00Z' });
    expect(health.closedOnTime.value).toBe(0.5);
    expect(health.verifiedShare.share.value).toBe(0.875);
  });

  it('AC-03-08 a metric over a window with no items is null, not zero', () => {
    const empty = { start: '2026-08-01', end: '2026-08-31' };
    expect(closedOnTime(monthFixture(), empty, asOf).value).toBeNull();
    expect(verifiedShare(monthFixture(), empty, asOf).share.value).toBeNull();
    expect(closedOnTimePct([], empty, asOf)).toBeNull();
  });
});
