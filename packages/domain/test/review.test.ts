/**
 * Evidence and the review loop, 03 §9: claim, idempotency (C-03-01), check results, the auto
 * decision (only the review job, C-03-02), and the user's confirm, attest and reject with the
 * Confirm rule of owner decision Q5.
 */
import { describe, expect, it } from 'vitest';

import {
  addEvidence,
  attestItem,
  autoVerify,
  claimItem,
  confirmItem,
  createActionItem,
  type EvidenceInput,
  rejectClaim,
  recordCheckResult,
  reviewOptions,
} from '@cc/domain';
import type { ActionItem, Evidence, EvidenceRequirement } from '@cc/schemas';

import { agent, checked, connector, failure, harness, newItem, system, user } from './harness.js';

const sentMail: EvidenceRequirement = {
  id: 'er1',
  description: 'Sent message to the lead',
  required: true,
  acceptedKinds: ['connector_record'],
  check: {
    type: 'connector_query',
    bindingId: 'bnd_gmail_ald',
    action: 'search_messages',
    input: { query: 'in:sent subject:"Revised proposal"' },
    expect: { path: 'messages.length', op: 'gte', value: 1 },
    retry: { attempts: 3, intervalMinutes: 30 },
  },
};
const filed: EvidenceRequirement = {
  id: 'er2',
  description: 'Proposal filed in the client folder',
  required: true,
  acceptedKinds: ['url', 'note'],
};
const record: EvidenceInput = {
  requirementId: 'er1',
  kind: 'connector_record',
  summary: 'Sent message to the lead',
  record: { bindingId: 'bnd_gmail_ald', recordType: 'message', externalId: 'msg-1' },
};

function setup(
  requirements: EvidenceRequirement[],
  policy: ActionItem['verificationPolicy'] = 'require_review',
) {
  const h = harness('2026-11-12T04:00:00Z');
  const item = checked(
    createActionItem(
      h.ctx,
      user,
      newItem({ evidenceRequirements: requirements, verificationPolicy: policy }),
    ),
  ).record;
  const evidence: Evidence[] = [];
  const add = (caller: Parameters<typeof addEvidence>[1], input: EvidenceInput) => {
    const outcome = checked(addEvidence(h.ctx, caller, item, evidence, input));
    if (outcome.status === 'ok') evidence.push(outcome.record);
    return outcome;
  };
  return { ...h, item, evidence, add };
}

describe('03 §9.2 claim', () => {
  it('a claim without evidence for each required requirement fails with E_EVIDENCE_MISSING listing them', () => {
    const { ctx, item, add, evidence } = setup([sentMail, filed]);
    add(user, { requirementId: 'er2', kind: 'note', summary: 'Filed' });
    const refused = failure(() => claimItem(ctx, user, item, evidence));
    expect(refused).toMatchObject({ code: 'E_EVIDENCE_MISSING', rule: '03 §9.2' });
    expect(refused.help).toEqual(['03 §9.2', 'er1']);
  });

  it('C-03-01 claiming an already claimed item with the same evidence set is a no-op; new evidence makes a fresh claim', () => {
    const { ctx, clock, item, add, evidence } = setup([sentMail]);
    const cli = agent('items:claim');
    add(cli, record);
    const first = checked(claimItem(ctx, cli, item, evidence));
    expect(first.record.verification).toEqual({
      checks: [{ requirementId: 'er1', status: 'pending', at: clock.now(), detail: 'queued' }],
      rejectedClaims: [],
    });
    clock.advance({ minutes: 5 });
    // The repeat hands in the same evidence: adding it again is a no-op, and so is the claim.
    expect(addEvidence(ctx, cli, first.record, evidence, record).status).toBe('no-op');
    expect(claimItem(ctx, cli, first.record, evidence)).toEqual({
      status: 'no-op',
      record: first.record,
      changes: [],
    });
    add(cli, { ...record, record: { ...record.record!, externalId: 'msg-2' } });
    const again = checked(claimItem(ctx, cli, first.record, evidence));
    expect(again.status).toBe('ok');
    expect(again.record.claim?.at).toBe(clock.now());
  });

  it('evidence must answer a requirement of the item in a kind it accepts; an unnamed one is matched by kind', () => {
    const { ctx, item, add } = setup([sentMail, filed]);
    expect(
      failure(() =>
        addEvidence(ctx, user, item, [], {
          requirementId: 'er9',
          kind: 'url',
          summary: 'x',
          url: 'https://x.example/',
        }),
      ).rule,
    ).toBe('03 §9.1');
    expect(
      failure(() =>
        addEvidence(ctx, user, item, [], {
          requirementId: 'er1',
          kind: 'note',
          summary: 'I sent it',
        }),
      ).rule,
    ).toBe('03 §9.1');
    const matched = add(user, {
      kind: 'url',
      summary: 'Client folder',
      url: 'https://files.example/p.pdf',
    });
    expect(matched.record.requirementId).toBe('er2');
    expect(matched.changes[0]?.event.type).toBe('evidence.added');
  });

  it('only the user, an agent with items:claim or system:review claims', () => {
    const { ctx, item, add, evidence } = setup([filed]);
    add(user, { requirementId: 'er2', kind: 'note', summary: 'Filed' });
    expect(failure(() => claimItem(ctx, connector, item, evidence)).code).toBe('E_FORBIDDEN');
    expect(failure(() => claimItem(ctx, system('escalation'), item, evidence)).code).toBe(
      'E_FORBIDDEN',
    );
    expect(checked(claimItem(ctx, system('review'), item, evidence)).record.claim?.by).toEqual({
      kind: 'system',
      component: 'review',
    });
  });
});

describe('03 §9.2 checks and the auto decision', () => {
  it('auto_close_on_checks is allowed only when every required requirement has a check (03 §9.4)', () => {
    expect(failure(() => setup([sentMail, filed], 'auto_close_on_checks')).rule).toBe('03 §9.4');
  });

  it('C-03-02 only the review job verifies with method auto, and only when every required check passed under auto_close_on_checks', () => {
    const { ctx, clock, item, add, evidence } = setup([sentMail], 'auto_close_on_checks');
    add(connector, record);
    const claimed = checked(claimItem(ctx, agent('items:claim'), item, evidence)).record;
    expect(autoVerify(ctx, system('review'), claimed).status).toBe('no-op'); // still pending
    const pass = {
      requirementId: 'er1',
      status: 'pass' as const,
      at: clock.advance({ minutes: 30 }),
      detail: '1 sent message matched',
      runId: 'run_t9' as const,
    };
    const checkedItem = checked(recordCheckResult(ctx, connector, claimed, pass)).record;
    expect(checkedItem.lifecycle).toBe('claimed_done'); // recording a pass does not close it
    for (const caller of [user, agent('items:claim'), connector, system('escalation')]) {
      expect(failure(() => autoVerify(ctx, caller, checkedItem)).code).toBe('E_FORBIDDEN');
    }
    const verified = checked(autoVerify(ctx, system('review'), checkedItem));
    expect(verified.record).toMatchObject({
      lifecycle: 'verified_done',
      health: 'on_track',
      closedAt: clock.now(),
      verification: { method: 'auto', decidedBy: { kind: 'system', component: 'review' } },
    });
    expect(verified.changes[0]?.event.type).toBe('action_item.verified');
  });

  it('an inconclusive check is never a pass: the item stays claimed and waits for the user', () => {
    const { ctx, clock, item, add, evidence } = setup([sentMail], 'auto_close_on_checks');
    add(connector, record);
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    const signedOut = checked(
      recordCheckResult(ctx, system('review'), claimed, {
        requirementId: 'er1',
        status: 'inconclusive',
        at: clock.now(),
        detail: 'binding signed out',
      }),
    ).record;
    expect(autoVerify(ctx, system('review'), signedOut).status).toBe('no-op');
    expect(signedOut.lifecycle).toBe('claimed_done');
    expect(
      failure(() =>
        recordCheckResult(ctx, user, claimed, {
          requirementId: 'er1',
          status: 'pass',
          at: clock.now(),
          detail: '',
        }),
      ).code,
    ).toBe('E_FORBIDDEN');
  });

  it('under require_review, passing checks leave the item in the review queue', () => {
    const { ctx, clock, item, add, evidence } = setup([sentMail]);
    add(connector, record);
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    const passed = checked(
      recordCheckResult(ctx, system('review'), claimed, {
        requirementId: 'er1',
        status: 'pass',
        at: clock.now(),
        detail: 'ok',
      }),
    ).record;
    expect(autoVerify(ctx, system('review'), passed).status).toBe('no-op');
    const confirmed = checked(confirmItem(ctx, user, passed, evidence)).record;
    expect(confirmed.verification).toMatchObject({
      method: 'confirmed',
      decidedBy: { kind: 'user' },
    });
  });
});

describe('03 §9.2 the user decides: confirm, attest or reject (owner decision Q5)', () => {
  it('a note-only requirement disables Confirm with its reason and offers Attest; attesting records method attested', () => {
    const { ctx, clock, item, add, evidence } = setup([filed]);
    add(user, {
      requirementId: 'er2',
      kind: 'note',
      summary: 'The client contact said it is filed',
    });
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    const options = reviewOptions(claimed, evidence);
    expect(options).toEqual({
      confirm: {
        enabled: false,
        reason: 'No checkable evidence for er2: only a note. Attest instead.',
      },
      attest: { enabled: true },
      reject: { enabled: true },
      notCheckable: ['er2'],
    });
    expect(failure(() => confirmItem(ctx, user, claimed, evidence)).rule).toBe('03 §9.2');
    clock.advance({ hours: 2 });
    const attested = checked(
      attestItem(ctx, user, claimed, 'Client contact confirmed by message on 2026-11-12'),
    ).record;
    expect(attested).toMatchObject({
      lifecycle: 'verified_done',
      closedAt: clock.now(),
      closedBy: { kind: 'user' },
      verification: {
        method: 'attested',
        attestationNote: 'Client contact confirmed by message on 2026-11-12',
        decidedAt: clock.now(),
      },
    });
  });

  it('checkable evidence (a URL) enables Confirm; confirming records method confirmed and clears at_risk', () => {
    const { ctx, item, add, evidence } = setup([filed]);
    add(user, {
      requirementId: 'er2',
      kind: 'url',
      summary: 'Client folder',
      url: 'https://files.example/p.pdf',
    });
    const claimed = {
      ...checked(claimItem(ctx, user, item, evidence)).record,
      health: 'at_risk' as const,
      healthNote: 'Late',
    };
    expect(reviewOptions(claimed, evidence).confirm).toEqual({ enabled: true });
    const confirmed = checked(confirmItem(ctx, user, claimed, evidence)).record;
    expect(confirmed).toMatchObject({
      lifecycle: 'verified_done',
      health: 'on_track',
      verification: { method: 'confirmed' },
    });
    expect(confirmed.healthNote).toBeUndefined();
  });

  it('rejecting needs a reason; a later claim keeps the earlier rejections', () => {
    const { ctx, clock, item, add, evidence } = setup([filed]);
    add(user, { requirementId: 'er2', kind: 'note', summary: 'Filed' });
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    expect(failure(() => rejectClaim(ctx, user, claimed, ' ')).rule).toBe('03 §7');
    const rejected = checked(rejectClaim(ctx, user, claimed, 'Not in the folder')).record;
    clock.advance({ hours: 1 });
    const reclaimed = checked(claimItem(ctx, user, rejected, evidence)).record;
    expect(reclaimed.verification?.rejectedClaims).toHaveLength(1);
    expect(reviewOptions(rejected, evidence).confirm.enabled).toBe(false); // not claimed
  });
});
