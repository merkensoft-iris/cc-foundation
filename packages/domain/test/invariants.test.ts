/**
 * One behavioural test (or more) per invariant of docs/design/03-decisions-and-action-items.md
 * §6, INV-03-01 to INV-03-12, through the domain commands that enforce them.
 */
import { describe, expect, it } from 'vitest';

import {
  acceptItem,
  addEvidence,
  attestItem,
  calendarEventText,
  checkGoal,
  checkIssue,
  checkMeasureValue,
  checkVerification,
  claimItem,
  confirmItem,
  createActionItem,
  decide,
  dropItem,
  type FrameworkValidator,
  type StepInput,
  maySendToAi,
  openDecision,
  proposeDecision,
  resolveIssue,
  raiseIssue,
  setItemHealth,
  updateItem,
} from '@cc/domain';
import type { ActionItem, Goal, Issue, MeasureValue } from '@cc/schemas';

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

describe('INV-03-01 one owner, a person', () => {
  it('INV-03-01 an item owned by something that is not a person is refused', () => {
    const { ctx } = harness();
    expect(failure(() => createActionItem(ctx, user, newItem({ ownerId: 'per_ghost' }))).rule).toBe(
      'INV-03-01',
    );
    // An agent principal ID is not even a PersonId; the default owner is the self person.
    const item = checked(createActionItem(ctx, user, newItem())).record;
    expect(item.ownerId).toBe('per_self');
  });
});

describe('INV-03-02 the decider is a person, and agents never decide', () => {
  it('INV-03-02 a decision with a decider who is not a person is refused; an agent may propose and recommend but not decide', () => {
    const { ctx } = harness();
    expect(
      failure(() =>
        proposeDecision(ctx, user, {
          workstreamId: 'ws_ald',
          question: 'Which scheduler?',
          deciderId: 'per_nobody',
        }),
      ).rule,
    ).toBe('INV-03-02');
    const proposed = checked(
      proposeDecision(ctx, agent('decisions:propose'), {
        workstreamId: 'ws_ald',
        question: 'Which scheduler should run posting from week 3?',
        options: ['LinkedIn only', 'Hootsuite'],
      }),
    ).record;
    expect(proposed.deciderId).toBe('per_self');
    const open = checked(openDecision(ctx, user, proposed)).record;
    const refused = failure(() =>
      decide(ctx, agent('decisions:propose'), open, {
        optionId: 'o1',
        text: 'LinkedIn only',
        why: 'Cheapest',
      }),
    );
    expect(refused.code).toBe('E_HUMAN_REQUIRED');
    expect(refused.rule).toBe('INV-03-07');
  });
});

describe('INV-03-03 health other than on_track needs a note', () => {
  it('INV-03-03 setting at_risk without a note is refused, with a note it is kept; goals too', () => {
    const { ctx } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    expect(failure(() => setItemHealth(ctx, user, item, 'at_risk')).rule).toBe('INV-03-03');
    const atRisk = checked(setItemHealth(ctx, user, item, 'at_risk', 'Lead is travelling')).record;
    expect(atRisk.healthNote).toBe('Lead is travelling');
    const back = checked(setItemHealth(ctx, user, atRisk, 'on_track')).record;
    expect(back.healthNote).toBeUndefined();

    const goal: Goal = { ...fixture<Goal>('goal', 'priority'), health: 'off_track' };
    delete goal.healthNote;
    expect(checkGoal(goal).map((v) => v.rule)).toEqual(['INV-03-03']);
    expect(checkGoal({ ...goal, health: 'off_track', healthNote: 'Two weeks behind' })).toEqual([]);
  });
});

describe('INV-03-04 an item outside draft is a full commitment', () => {
  it('INV-03-04 outside draft an item needs a title, doneMeans, due and a required evidence requirement', () => {
    const { ctx } = harness();
    const noRequired = newItem({
      evidenceRequirements: [
        { id: 'er1', description: 'Optional link', required: false, acceptedKinds: ['url'] },
      ],
    });
    expect(failure(() => createActionItem(ctx, user, noRequired)).rule).toBe('INV-03-04');
    expect(failure(() => createActionItem(ctx, user, newItem({ title: '  ' }))).rule).toBe(
      'INV-03-04',
    );
    // As a draft, all of it may be missing; accepting checks it.
    const draft = checked(
      createActionItem(ctx, user, { ...noRequired, lifecycle: 'draft' }),
    ).record;
    expect(failure(() => acceptItem(ctx, user, draft)).rule).toBe('INV-03-04');
    // And editing an open item cannot take it away.
    const open = checked(createActionItem(ctx, user, newItem())).record;
    expect(failure(() => updateItem(ctx, user, open, { evidenceRequirements: [] })).rule).toBe(
      'INV-03-04',
    );
  });
});

describe('INV-03-05 dropped needs a reason, and nothing is deleted', () => {
  it('INV-03-05 dropping without a reason is refused; a drop keeps the record with its reason', () => {
    const { ctx } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    expect(failure(() => dropItem(ctx, user, item, ' ')).rule).toBe('INV-03-05');
    const dropped = checked(dropItem(ctx, user, item, 'The lead went with another vendor'));
    expect(dropped.record.lifecycle).toBe('dropped');
    expect(dropped.record.dropReason).toBe('The lead went with another vendor');
    expect(dropped.changes.map((c) => c.event.type)).toEqual(['action_item.dropped']);
  });
});

describe('INV-03-06 verified_done needs a decided verification record', () => {
  it('INV-03-06 auto needs the policy, system:review and a pass on every required check; manual methods need the user; attested needs a note', () => {
    const { ctx } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    const verified = (verification: ActionItem['verification'], extra: Partial<ActionItem> = {}) =>
      checkVerification({
        ...item,
        lifecycle: 'verified_done',
        ...extra,
        ...(verification ? { verification } : {}),
      }).map((v) => v.message);
    const at = '2026-11-12T05:00:00Z';
    expect(verified(undefined)).toHaveLength(1);
    expect(
      verified({
        method: 'auto',
        checks: [],
        decidedBy: { kind: 'system', component: 'review' },
        decidedAt: at,
        rejectedClaims: [],
      }),
    ).toEqual(['method auto needs verificationPolicy auto_close_on_checks']);
    expect(
      verified(
        {
          method: 'auto',
          checks: [],
          decidedBy: { kind: 'system', component: 'review' },
          decidedAt: at,
          rejectedClaims: [],
        },
        { verificationPolicy: 'auto_close_on_checks' },
      ),
    ).toEqual(['method auto needs a pass check for er1']);
    expect(
      verified(
        {
          method: 'auto',
          checks: [
            { requirementId: 'er1', status: 'inconclusive', at, detail: 'binding signed out' },
          ],
          decidedBy: { kind: 'system', component: 'review' },
          decidedAt: at,
          rejectedClaims: [],
        },
        { verificationPolicy: 'auto_close_on_checks' },
      ),
    ).toEqual(['method auto needs a pass check for er1']);
    expect(
      verified({
        method: 'confirmed',
        checks: [],
        decidedBy: { kind: 'agent', principalId: 'agt_x' },
        decidedAt: at,
        rejectedClaims: [],
      }),
    ).toEqual(['method confirmed is decided by the user only']);
    expect(
      verified({
        method: 'attested',
        checks: [],
        decidedBy: { kind: 'user' },
        decidedAt: at,
        rejectedClaims: [],
      }),
    ).toEqual(['method attested needs an attestationNote']);
    expect(
      verified({
        method: 'attested',
        checks: [],
        decidedBy: { kind: 'user' },
        decidedAt: at,
        attestationNote: 'The client contact confirmed by message',
        rejectedClaims: [],
      }),
    ).toEqual([]);
    // Through the commands: attesting with a blank note is refused with INV-03-06.
    const evidence = [
      checked(
        addEvidence(ctx, user, item, [], { requirementId: 'er1', kind: 'note', summary: 'Done' }),
      ).record,
    ];
    const claimed = checked(claimItem(ctx, user, item, evidence)).record;
    expect(failure(() => attestItem(ctx, user, claimed, '')).rule).toBe('INV-03-06');
  });
});

describe('INV-03-07 only the user does the human-only operations', () => {
  it('INV-03-07 confirm, attest, reject, decide, accept and drop return E_HUMAN_REQUIRED for any other actor; agents add evidence and claim with items:claim', () => {
    const { ctx } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    const cli = agent('read', 'items:write', 'items:claim');
    const evidence = [
      checked(
        addEvidence(ctx, cli, item, [], {
          requirementId: 'er1',
          kind: 'url',
          summary: 'Filed proposal',
          url: 'https://files.example/proposal.pdf',
        }),
      ).record,
    ];
    const claimed = checked(claimItem(ctx, cli, item, evidence)).record;
    expect(claimed.claim?.by).toEqual(cli.actor);
    for (const run of [
      () => confirmItem(ctx, cli, claimed, evidence),
      () => attestItem(ctx, cli, claimed, 'done'),
      () => confirmItem(ctx, connector, claimed, evidence),
      () => confirmItem(ctx, system('review'), claimed, evidence),
      () => dropItem(ctx, cli, item, 'not needed'),
    ]) {
      const refused = failure(run);
      expect(refused.code).toBe('E_HUMAN_REQUIRED');
      expect(refused.rule).toBe('INV-03-07');
      expect(refused.help).toContain(`commandcenter://items/${item.ref}`);
    }
    const draft = checked(createActionItem(ctx, cli, newItem())).record;
    expect(draft.lifecycle).toBe('draft'); // CLI and MCP items always start as draft
    expect(failure(() => acceptItem(ctx, cli, draft)).code).toBe('E_HUMAN_REQUIRED');
    // Without items:claim an agent can neither claim nor add evidence.
    expect(failure(() => claimItem(ctx, agent('read', 'items:write'), item, evidence)).code).toBe(
      'E_FORBIDDEN',
    );
    expect(
      failure(() =>
        addEvidence(ctx, agent('read'), item, [], {
          kind: 'url',
          summary: 'x',
          url: 'https://x.example/',
        }),
      ).code,
    ).toBe('E_FORBIDDEN');
  });
});

describe('INV-03-08 agent steps carry a budget and tools; connector steps name an installed action', () => {
  it('INV-03-08 a connector step whose action is not in the installed manifest is refused', () => {
    const { ctx, installed } = harness();
    const connectorStep = (action: string): StepInput => ({
      id: 's1',
      order: 1,
      title: 'Send the draft',
      dependsOn: [],
      satisfies: ['er1'],
      confirmation: 'always',
      performer: { kind: 'connector', bindingId: 'bnd_gmail_ald', action, input: {} },
    });
    const step = connectorStep('send_draft');
    const ok = checked(createActionItem(ctx, user, newItem({ steps: [step] }))).record;
    expect(ok.execution.mode).toBe('connector');
    expect(ok.execution.steps[0]?.status).toBe('ready');
    const unknown = connectorStep('delete_mailbox');
    const refused = failure(() => createActionItem(ctx, user, newItem({ steps: [unknown] })));
    expect(refused.rule).toBe('INV-03-08');
    // A manifest change does not block unrelated writes on an existing item (C-03-05 re-evaluates
    // the step at run time).
    installed.delete('bnd_gmail_ald.send_draft');
    expect(checked(setItemHealth(ctx, user, ok, 'at_risk', 'Connector being updated')).status).toBe(
      'ok',
    );
  });
});

describe('INV-03-09 every write appends exactly one event', () => {
  it('INV-03-09 each write a command returns carries exactly one event for its own record, with changed fields only', () => {
    const { ctx, clock } = harness();
    const item = checked(createActionItem(ctx, user, newItem())).record;
    clock.advance({ hours: 1 });
    const update = checked(
      updateItem(ctx, user, item, { title: 'Send the phased-pricing proposal' }),
    );
    expect(update.changes).toHaveLength(1);
    const event = update.changes[0]?.event;
    expect(event?.type).toBe('action_item.updated');
    expect(event?.before).toEqual({ title: 'Send the revised proposal to the consulting lead' });
    expect(event?.after).toEqual({ title: 'Send the phased-pricing proposal' });
    expect(event?.actor).toEqual({ kind: 'user' });
    expect(update.record.version).toBe(item.version + 1);
    expect(update.record.updatedAt).toBe('2026-11-11T06:00:00Z');
    // A write that changes nothing is a no-op with no event.
    expect(updateItem(ctx, user, update.record, { title: update.record.title })).toEqual({
      status: 'no-op',
      record: update.record,
      changes: [],
    });
  });
});

describe('INV-03-10 sensitive content stays out of calendars and follows the AI data policy', () => {
  it('INV-03-10 an item in a sensitive workstream is sensitive and cannot be lowered; its text never reaches calendar event text', () => {
    const { ctx } = harness();
    const clientItem = checked(
      createActionItem(
        ctx,
        user,
        newItem({ workstreamId: 'ws_private', ownerId: 'per_client', privacy: 'normal' }),
      ),
    ).record;
    expect(clientItem.privacy).toBe('sensitive');
    expect(failure(() => updateItem(ctx, user, clientItem, { privacy: 'normal' })).rule).toBe(
      'INV-03-10',
    );
    expect(calendarEventText(clientItem.privacy, clientItem.title)).toBe('Private');
    expect(calendarEventText('normal', 'Weekly review')).toBe('Weekly review');
    const raised = checked(
      updateItem(ctx, user, checked(createActionItem(ctx, user, newItem())).record, {
        privacy: 'sensitive',
      }),
    ).record;
    expect(raised.privacy).toBe('sensitive');
    expect(maySendToAi({ aiDataPolicy: 'deny' })).toBe(false);
    expect(maySendToAi({ aiDataPolicy: 'redact_people' })).toBe(true);
  });
});

describe('INV-03-11 a resolved issue says how', () => {
  it('INV-03-11 resolving an issue needs a decision or action item ref, or a re-plan or drop with a note', () => {
    const { ctx } = harness();
    const issue = checked(
      raiseIssue(ctx, user, { workstreamId: 'ws_ald', title: 'Proposal stalled' }),
    ).record;
    expect(
      failure(() => resolveIssue(ctx, user, issue, { kind: 'action', refs: [], note: '' })).rule,
    ).toBe('INV-03-11');
    expect(
      failure(() => resolveIssue(ctx, user, issue, { kind: 'replan', refs: [], note: ' ' })).rule,
    ).toBe('INV-03-11');
    expect(
      checked(resolveIssue(ctx, user, issue, { kind: 'decision', refs: ['D-0008'], note: '' }))
        .record.status,
    ).toBe('resolved');
    expect(checkIssue(fixture<Issue>('issue', 'i-0012'))).toEqual([]);
  });
});

describe('INV-03-12 framework validators run on every write that touches the item', () => {
  it('INV-03-12 an eos-lite E-4 style validator refuses a todo due beyond the horizon unless it links to a goal', () => {
    const { ctx, validators } = harness('2026-11-11T05:00:00Z');
    const horizonDays = 7;
    const e4: FrameworkValidator = (item, now) => {
      if (item.kind !== 'todo' || item.lifecycle === 'draft' || item.links.goalIds.length > 0)
        return [];
      const limit = new Date(Date.parse(item.createdAt) + horizonDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return item.due.date > limit && now !== ''
        ? [
            {
              rule: 'INV-03-12',
              message: `E-4: a todo is due within ${horizonDays} days unless it links to a goal`,
            },
          ]
        : [];
    };
    validators.set('ws_ald', [e4]);
    const late = newItem({ due: { date: '2026-11-30', timeZone: 'Asia/Kolkata' } });
    const refused = failure(() => createActionItem(ctx, user, late));
    expect(refused.rule).toBe('INV-03-12');
    expect(
      checked(createActionItem(ctx, user, { ...late, links: { goalIds: ['goal_g0004'] } })).status,
    ).toBe('ok');
    // It runs on edits too, and not for workstreams on another framework.
    const linked = checked(
      createActionItem(ctx, user, { ...late, links: { goalIds: ['goal_g0004'] } }),
    ).record;
    expect(
      failure(() => updateItem(ctx, user, linked, { links: { ...linked.links, goalIds: [] } }))
        .rule,
    ).toBe('INV-03-12');
    expect(
      checked(createActionItem(ctx, user, { ...late, workstreamId: 'ws_workspace' })).status,
    ).toBe('ok');
  });
});

describe('measure values (03 §5.4)', () => {
  it('a value read as not normal needs a note', () => {
    const value = fixture<MeasureValue>('measure_value', 'k-0003-w46');
    expect(checkMeasureValue({ ...value, normal: false, note: '' }).map((v) => v.rule)).toEqual([
      '03 §5.4',
    ]);
    expect(checkMeasureValue({ ...value, normal: false, note: 'Holiday week' })).toEqual([]);
  });
});
