/**
 * The action-item lifecycle and transition table of 03 §7, the health rules, and the step
 * rules of 03 §8.2 and §8.3.
 */
import { describe, expect, it } from 'vitest';

import {
  acceptItem,
  addEvidence,
  applyEscalationHealth,
  claimItem,
  completeStep,
  createActionItem,
  deriveMode,
  dropItem,
  escalationHealth,
  failStep,
  raiseIssue,
  readyForAutoClaim,
  rejectClaim,
  replanItem,
  resumeItem,
  setItemHealth,
  type StepInput,
  startItem,
  updateItem,
  waitItem,
} from '@cc/domain';
import type { ActionItem } from '@cc/schemas';

import {
  agent,
  checked,
  connector,
  failure,
  fixture,
  harness,
  newItem,
  system,
  user,
} from './harness.js';

const userStep = (id: string, satisfies: string[] = [], dependsOn: string[] = []): StepInput => ({
  id,
  order: Number(id.slice(1)),
  title: `Step ${id}`,
  performer: { kind: 'user' },
  dependsOn,
  satisfies,
  confirmation: 'policy',
});

describe('03 §7 action-item lifecycle', () => {
  it('draft → open → in_progress → waiting → in_progress → claimed_done → verified_done, each by its allowed actor', () => {
    const { ctx, clock } = harness();
    const draft = checked(createActionItem(ctx, agent('items:write'), newItem())).record;
    expect(draft.lifecycle).toBe('draft');
    const open = checked(acceptItem(ctx, user, draft, 'Accepted at read-back')).record;
    expect(open.lifecycle).toBe('open');
    const started = checked(startItem(ctx, system('scheduler'), open)).record;
    expect(started.lifecycle).toBe('in_progress');
    const waiting = checked(
      waitItem(ctx, system('scheduler'), started, { kind: 'person', ref: 'per_client' }),
    ).record;
    expect(waiting.waitingOn).toEqual({ kind: 'person', ref: 'per_client', since: clock.now() });
    const resumed = checked(resumeItem(ctx, system('scheduler'), waiting)).record;
    expect(resumed.lifecycle).toBe('in_progress');
    expect(resumed.waitingOn).toBeUndefined();
    expect(failure(() => startItem(ctx, agent('items:write'), open)).code).toBe('E_FORBIDDEN');
    expect(failure(() => waitItem(ctx, user, started, { kind: 'date' })).code).toBe('E_FORBIDDEN');
  });

  it('claim is refused from draft, drop from claimed_done, and every transition from verified_done or dropped', () => {
    const { ctx } = harness();
    const draft = checked(createActionItem(ctx, user, newItem({ lifecycle: 'draft' }))).record;
    const ev = (item: ActionItem) => [
      checked(
        addEvidence(ctx, user, item, [], {
          requirementId: 'er1',
          kind: 'url',
          summary: 'Link',
          url: 'https://x.example/p',
        }),
      ).record,
    ];
    const fromDraft = failure(() => claimItem(ctx, user, draft, ev(draft)));
    expect(fromDraft).toMatchObject({ code: 'E_INVARIANT', rule: '03 §7' });
    const open = checked(acceptItem(ctx, user, draft)).record;
    const evidence = ev(open);
    const claimed = checked(claimItem(ctx, user, open, evidence)).record;
    expect(failure(() => dropItem(ctx, user, claimed, 'no')).rule).toBe('03 §7');
    const dropped = checked(
      dropItem(ctx, user, checked(createActionItem(ctx, user, newItem())).record, 'Not needed'),
    ).record;
    expect(dropped.closedAt).toBeDefined();
    for (const run of [
      () => acceptItem(ctx, user, dropped),
      () => startItem(ctx, user, dropped),
      () => claimItem(ctx, user, dropped, []),
      () => setItemHealth(ctx, user, dropped, 'at_risk', 'x'),
      () => updateItem(ctx, user, dropped, { title: 'x' }),
    ]) {
      expect(failure(run).code).toBe('E_INVARIANT');
    }
  });

  it('a draft discarded by the user is dropped with its reason, even when it is incomplete', () => {
    const { ctx } = harness();
    const incomplete = checked(
      createActionItem(
        ctx,
        agent('items:write'),
        newItem({ doneMeans: '', evidenceRequirements: [] }),
      ),
    ).record;
    expect(checked(dropItem(ctx, user, incomplete, 'Not a real task')).record.lifecycle).toBe(
      'dropped',
    );
    const draft = checked(createActionItem(ctx, agent('items:write'), newItem())).record;
    expect(checked(dropItem(ctx, user, draft, 'Duplicate of A-0142')).record.lifecycle).toBe(
      'dropped',
    );
  });

  it('items from agent suggestions and ingest rules start as draft even when the user creates them', () => {
    const { ctx } = harness();
    const suggested = checked(
      createActionItem(
        ctx,
        user,
        newItem({ source: { kind: 'agent_suggestion', runId: 'run_01' } }),
      ),
    ).record;
    expect(suggested.lifecycle).toBe('draft');
    const ingested = checked(
      createActionItem(
        ctx,
        system('ingest'),
        newItem({ source: { kind: 'ingest_rule', bindingId: 'bnd_gmail_ald', recordId: 'm1' } }),
      ),
    ).record;
    expect(ingested.lifecycle).toBe('draft');
    expect(failure(() => createActionItem(ctx, agent('read'), newItem())).code).toBe('E_FORBIDDEN');
  });

  it('a due-date change on an accepted item is a re-plan with a reason (02 §7.1 rule 3, 03 §11 rule 2)', () => {
    const { ctx } = harness();
    const item = {
      ...checked(createActionItem(ctx, user, newItem())).record,
      carryCount: 2,
      escalationLevel: 2 as const,
    };
    expect(
      failure(() =>
        updateItem(ctx, user, item, { due: { date: '2026-11-20', timeZone: 'Asia/Kolkata' } }),
      ).rule,
    ).toBe('02 §7.1');
    expect(failure(() => replanItem(ctx, user, item, { date: '2026-11-20' }, '')).rule).toBe(
      '02 §7.1',
    );
    const replanned = checked(
      replanItem(ctx, user, item, { date: '2026-11-20' }, 'Lead is away until the 18th'),
    );
    expect(replanned.record).toMatchObject({
      due: { date: '2026-11-20', timeZone: 'Asia/Kolkata' },
      carryCount: 2,
      escalationLevel: 0,
      replannedCount: 1,
    });
    expect(replanned.changes[0]?.event.after).toMatchObject({
      reason: 'Lead is away until the 18th',
    });
    expect(
      failure(() => replanItem(ctx, agent('items:write'), item, { date: '2026-11-21' }, 'x')).code,
    ).toBe('E_FORBIDDEN');
  });

  it("dropping an issue's last open action resolves the issue (03 §7 drop side effect)", () => {
    const { ctx } = harness();
    const issue = checked(
      raiseIssue(ctx, user, { workstreamId: 'ws_ald', title: 'Proposal stalled' }),
    ).record;
    const a = checked(
      createActionItem(ctx, user, newItem({ source: { kind: 'issue', issueId: issue.id } })),
    ).record;
    const b = checked(
      createActionItem(ctx, user, newItem({ links: { issueIds: [issue.id] } })),
    ).record;
    const first = checked(
      dropItem(ctx, user, a, 'Merged into the other action', { issues: [issue], items: [a, b] }),
    );
    expect(first.changes.map((c) => c.event.type)).toEqual(['action_item.dropped']);
    const second = checked(
      dropItem(ctx, user, b, 'Lead chose another vendor', {
        issues: [issue],
        items: [first.record, b],
      }),
    );
    expect(second.changes.map((c) => c.event.type)).toEqual([
      'action_item.dropped',
      'issue.resolved',
    ]);
    expect(second.changes[1]?.record).toMatchObject({
      status: 'resolved',
      resolution: {
        kind: 'action',
        refs: [a.ref, b.ref],
        note: `Last open action ${b.ref} dropped: Lead chose another vendor`,
      },
    });
  });
});

describe('03 §7 health rules', () => {
  it('rule 1: the user or an agent with items:write sets health with a note', () => {
    const { ctx } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    const set = checked(
      setItemHealth(ctx, agent('items:write'), item, 'at_risk', 'Lead has not replied'),
    ).record;
    expect(set.health).toBe('at_risk');
    expect(failure(() => setItemHealth(ctx, agent('read'), item, 'at_risk', 'x')).code).toBe(
      'E_FORBIDDEN',
    );
  });

  it('rule 2: the escalation job sets off_track when overdue and unclaimed, at_risk on a failed step or a wait over 3 days', () => {
    const { ctx, clock } = harness('2026-11-11T05:00:00Z');
    const item = checked(createActionItem(ctx, user, newItem())).record; // due 2026-11-13 IST
    expect(escalationHealth(item, '2026-11-13T18:29:00Z')).toBeUndefined(); // 23:59 IST on the due date
    expect(escalationHealth(item, '2026-11-13T18:31:00Z')).toEqual({
      health: 'off_track',
      healthNote: 'Due 2026-11-13 has passed and the item is not claimed',
    });
    const waiting = checked(
      waitItem(ctx, system('scheduler'), item, { kind: 'external_agent' }),
    ).record;
    expect(escalationHealth(waiting, clock.advance({ days: 1 }))).toBeUndefined();
    expect(escalationHealth(waiting, '2026-11-14T05:00:01Z')?.health).toBe('off_track'); // overdue comes first
    const longWait = { ...waiting, due: { date: '2026-11-30', timeZone: 'Asia/Kolkata' } };
    expect(escalationHealth(longWait, '2026-11-14T05:00:00Z')).toBeUndefined(); // exactly 3 days
    expect(escalationHealth(longWait, '2026-11-14T05:00:01Z')).toEqual({
      health: 'at_risk',
      healthNote: 'Waiting on external_agent for more than 3 days',
    });
    clock.set('2026-11-14T06:00:00Z');
    const flagged = checked(applyEscalationHealth(ctx, system('escalation'), item));
    expect(flagged.record.health).toBe('off_track');
    expect(flagged.changes[0]?.event.actor).toEqual({ kind: 'system', component: 'escalation' });
    expect(failure(() => applyEscalationHealth(ctx, user, item)).code).toBe('E_FORBIDDEN');
    // A claimed item is not escalated for being past due.
    expect(
      escalationHealth({ ...item, lifecycle: 'claimed_done' }, '2026-11-20T00:00:00Z'),
    ).toBeUndefined();
  });

  it('rule 3: nothing but the user or a verified claim clears at_risk or off_track', () => {
    const { ctx, clock } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    const offTrack = checked(
      setItemHealth(ctx, user, item, 'off_track', 'Lead went silent'),
    ).record;
    // The escalation job has nothing to raise, and never lowers off_track: no-op.
    clock.advance({ hours: 1 });
    expect(applyEscalationHealth(ctx, system('escalation'), offTrack).status).toBe('no-op');
    // An agent cannot clear it either.
    expect(failure(() => setItemHealth(ctx, agent('items:write'), offTrack, 'on_track')).rule).toBe(
      '03 §7',
    );
    expect(
      failure(() => setItemHealth(ctx, system('escalation'), offTrack, 'at_risk', 'x')).rule,
    ).toBe('03 §7');
    // The user can.
    expect(checked(setItemHealth(ctx, user, offTrack, 'on_track')).record.health).toBe('on_track');
  });
});

describe('03 §8.2 and §8.3 steps', () => {
  it('the mode is derived from the performers (03 §8.3), as in the worked examples', () => {
    for (const name of ['a-0142', 'a-0144', 'a-0152', 'a-0160']) {
      const item = fixture<ActionItem>('action_item', name);
      expect(deriveMode(item.execution.steps), name).toBe(item.execution.mode);
    }
    const step = (performer: StepInput['performer']) => ({
      ...userStep('s1'),
      performer,
      status: 'pending' as const,
      runIds: [],
    });
    expect(deriveMode([])).toBe('manual');
    expect(
      deriveMode([step({ kind: 'user' }), step({ kind: 'person', personId: 'per_client' })]),
    ).toBe('manual');
    expect(
      deriveMode([step({ kind: 'connector', bindingId: 'bnd_x', action: 'a', input: {} })]),
    ).toBe('connector');
    expect(
      deriveMode([step({ kind: 'external_agent', system: 'firstmate', handoff: 'brief' })]),
    ).toBe('agent');
  });

  it('steps become ready when their dependencies succeed; completing one starts the item; failing one sets at_risk', () => {
    const { ctx } = harness();
    const draft = checked(
      createActionItem(
        ctx,
        agent('items:write'),
        newItem({ steps: [userStep('s1'), userStep('s2', ['er1'], ['s1'])] }),
      ),
    ).record;
    expect(draft.execution.steps.map((s) => s.status)).toEqual(['pending', 'pending']); // drafts stay pending
    const open = checked(acceptItem(ctx, user, draft)).record;
    expect(open.execution.steps.map((s) => s.status)).toEqual(['ready', 'pending']);
    expect(
      failure(() => completeStep(ctx, agent('items:claim'), open, 's1', { status: 'succeeded' }))
        .code,
    ).toBe('E_FORBIDDEN');
    const one = checked(
      completeStep(ctx, user, open, 's1', { status: 'succeeded', note: 'Drafted' }),
    ).record;
    expect(one.lifecycle).toBe('in_progress');
    expect(one.execution.steps.map((s) => s.status)).toEqual(['succeeded', 'ready']);
    expect(readyForAutoClaim(one)).toBe(false);
    expect(completeStep(ctx, user, one, 's1', { status: 'succeeded' }).status).toBe('no-op');
    const two = checked(completeStep(ctx, user, one, 's2', { status: 'succeeded' })).record;
    expect(readyForAutoClaim(two)).toBe(true);

    const failed = checked(
      failStep(ctx, connector, one, 's2', {
        code: 'E_SIGNED_OUT',
        detail: 'binding signed out',
        retriable: true,
      }),
    ).record;
    expect(failed.execution.steps[1]).toMatchObject({
      status: 'failed',
      failure: { code: 'E_SIGNED_OUT' },
    });
    expect(failed).toMatchObject({ health: 'at_risk', healthNote: 'Step s2 failed: E_SIGNED_OUT' });
    expect(
      failure(() => failStep(ctx, user, one, 's2', { code: 'x', detail: '', retriable: false }))
        .code,
    ).toBe('E_FORBIDDEN');
  });

  it('a rejected claim leaves the steps as they were and the item keeps carrying forward', () => {
    const { ctx } = harness();
    const item = checked(
      createActionItem(ctx, user, newItem({ steps: [userStep('s1', ['er1'])] })),
    ).record;
    const done = checked(completeStep(ctx, user, item, 's1', { status: 'succeeded' })).record;
    const evidence = [
      checked(
        addEvidence(ctx, user, done, [], { requirementId: 'er1', kind: 'note', summary: 'Sent' }),
      ).record,
    ];
    const claimed = checked(claimItem(ctx, system('review'), done, evidence)).record;
    const rejected = checked(rejectClaim(ctx, user, claimed, 'Wrong recipient')).record;
    expect(rejected.execution).toEqual(done.execution);
    expect(rejected.lifecycle).toBe('in_progress');
  });
});
