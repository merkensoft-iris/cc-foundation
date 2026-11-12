/** Decisions (03 §10), issues and risks (03 §11). */
import { describe, expect, it } from 'vitest';

import {
  adviseDecision,
  closeRisk,
  decide,
  dropDecision,
  dropIssue,
  oneWayDoorViolations,
  openDecision,
  proposeDecision,
  raiseIssue,
  recordRisk,
  resolveIssue,
  reverseDecision,
  triggerRisk,
} from '@cc/domain';
import type { ActionItem, Decision } from '@cc/schemas';

import { agent, checked, failure, fixture, harness, system, user } from './harness.js';

const d0008 = (): Decision => ({
  ...fixture<Decision>('decision', 'd-0008'),
  reviewOn: { date: '2026-12-31' },
});

describe('03 §10 decisions', () => {
  it('D-0008: deciding creates the outcome action items and the reviewOn follow-up in the same transaction', () => {
    const { ctx } = harness('2026-11-27T09:00:00Z');
    const decision = d0008();
    const outcome = checked(
      decide(ctx, user, decision, {
        optionId: 'o2',
        text: 'Hootsuite from week 3',
        why: 'It has an API connector, so posts can be verified',
        resourcesCommitted: 'One paid seat',
        actionItems: [
          {
            title: 'Connect the chosen scheduler',
            doneMeans:
              'Hootsuite is connected and step 3 of the LinkedIn batch is a connector step.',
            due: { date: '2026-12-04', timeZone: 'Asia/Kolkata' },
            evidenceRequirements: [
              {
                id: 'er1',
                description: 'Scheduler connected',
                required: true,
                acceptedKinds: ['url', 'note'],
              },
            ],
          },
        ],
      }),
    );
    expect(outcome.changes.map((c) => c.event.type)).toEqual([
      'decision.decided',
      'action_item.created',
      'action_item.created',
    ]);
    const [connect, review] = outcome.changes.slice(1).map((c) => c.record as ActionItem);
    expect(connect).toMatchObject({
      lifecycle: 'open',
      title: 'Connect the chosen scheduler',
      source: { kind: 'decision', decisionId: 'dec_d0008' },
      links: { decisionIds: ['dec_d0008'] },
    });
    expect(review).toMatchObject({
      kind: 'follow_up',
      ownerId: 'per_self',
      lifecycle: 'open',
      due: { date: '2026-12-31', timeZone: 'Asia/Kolkata' },
      source: { kind: 'decision', decisionId: 'dec_d0008' },
    });
    expect(outcome.record).toMatchObject({
      status: 'decided',
      outcome: {
        optionId: 'o2',
        decidedAt: '2026-11-27T09:00:00Z',
        resourcesCommitted: 'One paid seat',
      },
      actionItemIds: [connect?.id, review?.id],
    });
    expect(
      outcome.changes.every(
        (c) => c.event.correlationId === undefined || c.event.correlationId === 'dec_d0008',
      ),
    ).toBe(true);
  });

  it('proposed → open → decided → superseded or reversed; only open decisions are decided', () => {
    const { ctx } = harness();
    const proposed = checked(
      proposeDecision(ctx, agent('decisions:propose'), {
        workstreamId: 'ws_ald',
        question: 'Raise prices?',
        options: ['Yes', 'No'],
      }),
    ).record;
    expect(failure(() => decide(ctx, user, proposed, { text: 'Yes', why: 'x' })).rule).toBe(
      '03 §10',
    );
    const advised = checked(
      adviseDecision(ctx, agent('decisions:propose'), proposed, {
        recommendation: { optionId: 'o1', rationale: 'Margins are thin' },
      }),
    ).record;
    expect(advised.recommendation?.by).toEqual(agent().actor);
    expect(
      failure(() =>
        adviseDecision(ctx, agent('decisions:propose'), proposed, {
          recommendation: { optionId: 'o9', rationale: 'x' },
        }),
      ).rule,
    ).toBe('03 §10');
    const first = checked(
      decide(ctx, user, checked(openDecision(ctx, user, advised)).record, {
        optionId: 'o1',
        text: 'Raise by 10%',
        why: 'Margins',
      }),
    ).record;
    const later = checked(
      proposeDecision(ctx, user, {
        workstreamId: 'ws_ald',
        question: 'Raise prices again?',
        supersedesId: first.id,
      }),
    ).record;
    const result = checked(
      decide(ctx, user, checked(openDecision(ctx, user, later)).record, {
        text: 'Raise by 5% instead',
        why: 'Churn',
        superseded: first,
      }),
    );
    expect(result.changes.map((c) => c.event.type)).toEqual([
      'decision.decided',
      'decision.superseded',
    ]);
    expect((result.changes[1]?.record as Decision).status).toBe('superseded');
    const reversed = checked(
      reverseDecision(ctx, user, result.record, 'The client renegotiated'),
    ).record;
    expect(reversed.status).toBe('reversed');
    expect(
      failure(() => reverseDecision(ctx, agent('decisions:propose'), result.record, 'x')).code,
    ).toBe('E_HUMAN_REQUIRED');
  });

  it('dropping needs a reason; an agent may withdraw only its own proposal', () => {
    const { ctx } = harness();
    const mine = checked(
      proposeDecision(ctx, agent('decisions:propose'), {
        workstreamId: 'ws_ald',
        question: 'Hire?',
      }),
    ).record;
    expect(failure(() => dropDecision(ctx, user, mine, '')).rule).toBe('03 §10');
    expect(
      checked(dropDecision(ctx, agent('decisions:propose'), mine, 'Asked by mistake')).record,
    ).toMatchObject({
      status: 'dropped',
      dropReason: 'Asked by mistake',
    });
    const users = checked(
      proposeDecision(ctx, user, { workstreamId: 'ws_ald', question: 'Hire?' }),
    ).record;
    expect(failure(() => dropDecision(ctx, agent('decisions:propose'), users, 'x')).code).toBe(
      'E_FORBIDDEN',
    );
    expect(
      failure(() => proposeDecision(ctx, agent('read'), { workstreamId: 'ws_ald', question: '?' }))
        .code,
    ).toBe('E_FORBIDDEN');
  });

  it('a one-way door needs a memo; with memos switched off, a waiver note stands in', () => {
    const { ctx } = harness();
    const oneWay: Decision = { ...d0008(), reversibility: 'one_way' };
    expect(failure(() => decide(ctx, user, oneWay, { text: 'Hootsuite', why: 'API' })).rule).toBe(
      '03 §10',
    );
    expect(
      oneWayDoorViolations(
        oneWay,
        { memoForOneWayDoors: false },
        'Small spend, cancellable monthly',
      ),
    ).toEqual([]);
    expect(
      oneWayDoorViolations(
        { ...oneWay, memoSha256: 'a'.repeat(64) },
        { memoForOneWayDoors: true },
        undefined,
      ),
    ).toEqual([]);
    expect(oneWayDoorViolations(d0008(), { memoForOneWayDoors: true }, undefined)).toEqual([]);
  });
});

describe('03 §11 issues and risks', () => {
  it('issues are raised by the user, an agent with items:write or the system, and resolved or dropped by the user', () => {
    const { ctx } = harness();
    const escalated = checked(
      raiseIssue(ctx, system('escalation'), {
        workstreamId: 'ws_ald',
        title: 'A-0142 carried twice',
        raisedFrom: { kind: 'escalation', actionItemId: 'act_a0142', level: 2 },
      }),
    ).record;
    expect(escalated).toMatchObject({
      status: 'open',
      raisedFrom: { kind: 'escalation', level: 2 },
    });
    const manual = checked(
      raiseIssue(ctx, agent('items:write'), {
        workstreamId: 'ws_ald',
        title: 'Website form broken',
      }),
    ).record;
    expect(manual.raisedFrom).toEqual({ kind: 'manual' });
    expect(
      failure(() => raiseIssue(ctx, agent('read'), { workstreamId: 'ws_ald', title: 'x' })).code,
    ).toBe('E_FORBIDDEN');
    expect(
      failure(() =>
        resolveIssue(ctx, agent('items:write'), manual, {
          kind: 'action',
          refs: ['A-0144'],
          note: '',
        }),
      ).code,
    ).toBe('E_FORBIDDEN');
    const replanned = checked(
      resolveIssue(ctx, user, escalated, {
        kind: 'replan',
        refs: ['A-0142'],
        note: 'Due moved to 2026-11-20: lead away',
      }),
    ).record;
    expect(replanned.resolution).toMatchObject({ kind: 'replan', by: { kind: 'user' } });
    expect(failure(() => dropIssue(ctx, user, manual, '')).rule).toBe('INV-03-11');
    expect(checked(dropIssue(ctx, user, manual, 'Fixed by the host')).record).toMatchObject({
      status: 'dropped',
      resolution: { kind: 'dropped', refs: [], note: 'Fixed by the host' },
    });
    expect(failure(() => dropIssue(ctx, user, replanned, 'x')).rule).toBe('03 §11');
  });

  it('a workspace risk is recorded on the Workspace pseudo-workstream; when it triggers, an issue is raised there', () => {
    const { ctx } = harness();
    const risk = checked(
      recordRisk(ctx, user, {
        workstreamId: 'ws_workspace',
        description: 'Backups fail silently',
        trigger: 'No good backup for 3 days',
      }),
    ).record;
    expect(risk).toMatchObject({
      status: 'watching',
      watcherId: 'per_self',
      reviewCadence: 'monthly',
    });
    const triggered = checked(
      triggerRisk(ctx, user, risk, {
        kind: 'meeting',
        meetingId: 'mtg_m0040',
        sectionId: 'risk_review',
      }),
    );
    expect(triggered.record.status).toBe('triggered');
    expect(triggered.changes.map((c) => c.event.type)).toEqual(['risk.triggered', 'issue.raised']);
    expect(triggered.changes[1]?.record).toMatchObject({
      workstreamId: 'ws_workspace',
      title: `Risk ${risk.ref} triggered: Backups fail silently`,
      raisedFrom: { kind: 'meeting', sectionId: 'risk_review' },
      status: 'open',
    });
    expect(failure(() => triggerRisk(ctx, user, triggered.record)).rule).toBe('03 §11');
    expect(checked(closeRisk(ctx, user, triggered.record)).record.status).toBe('closed');
    expect(failure(() => closeRisk(ctx, agent('items:write'), risk)).code).toBe('E_FORBIDDEN');
  });
});
