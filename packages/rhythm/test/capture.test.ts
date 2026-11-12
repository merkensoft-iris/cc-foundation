/**
 * Output capture and validation (02 §6.3) and conclude and close (02 §6.4; C-02-04) (P1-08):
 * each output kind's validation at capture, who may capture what, read-back (human-only),
 * acceptance of drafts by owner presence, the inform drafts and the close.
 */
import { describe, expect, it } from 'vitest';

import type { Caller, Change, DomainContext } from '@cc/domain';
import {
  agendaTemplate,
  applyPreread,
  buildPreread,
  captureOutput,
  closeMeeting,
  confirmReadBack,
  findSection,
  informDrafts,
  meetingLink,
  packSection,
  rateMeeting,
  readBackList,
  sectionTemplateOf,
  setSectionStatus,
  startMeeting,
  type CaptureOutcome,
  type MeetingOutput,
  type SectionKey,
} from '@cc/rhythm';
import type {
  ActionItem,
  Decision,
  Goal,
  Issue,
  Measure,
  MeasureValue,
  MeetingInstance,
  MeetingSeries,
} from '@cc/schemas';

import { checkChanges, failure } from './harness.ts';
import {
  agent,
  fixtures,
  instanceOf,
  item,
  meetingData,
  meetingHarness,
  rhythmCaller,
  seriesById,
  sha256,
  user,
} from './meetings-harness.ts';

const marketing = [{ slot: 'after:headlines', section: packSection('content_review') }];

/** A meeting in progress and the records it touches, updated by every command's changes. */
class Meeting {
  readonly ctx: DomainContext;
  readonly series: MeetingSeries;
  readonly records = new Map<string, unknown>();
  instance: MeetingInstance;

  constructor(
    seriesId: string,
    localStart: string,
    now: string,
    extra: Partial<MeetingInstance> = {},
  ) {
    this.ctx = meetingHarness(now).ctx;
    this.series = seriesById(seriesId);
    const planned = instanceOf(seriesId, localStart, extra);
    const built = buildPreread({
      series: this.series,
      instance: planned,
      template: agendaTemplate(this.series.agendaTemplateId),
      packSections: seriesId === 'ser_ceo_weekly' ? marketing : [],
      data: meetingData(),
      now,
      sha256,
    });
    const prepared = applyPreread(this.ctx, rhythmCaller, this.series, planned, built).record;
    this.instance = startMeeting(this.ctx, user, prepared).record;
    for (const record of [
      ...fixtures<ActionItem>('action_item'),
      ...fixtures<Decision>('decision'),
      ...fixtures<Issue>('issue'),
      ...fixtures<Goal>('goal'),
    ]) {
      this.records.set(record.id, record);
    }
  }

  apply(changes: readonly Change[]): void {
    checkChanges(changes);
    for (const write of changes) {
      const record = write.record as { id: string };
      if (write.kind === 'meeting_instance') this.instance = write.record as MeetingInstance;
      else this.records.set(record.id, record);
    }
  }

  get<T>(id: string): T {
    const found = this.records.get(id);
    if (found === undefined) throw new Error(`no record ${id}`);
    return found as T;
  }

  byRef<T>(ref: string): T {
    const found = [...this.records.values()].find((r) => (r as { ref?: string }).ref === ref);
    if (found === undefined) throw new Error(`no record ${ref}`);
    return found as T;
  }

  capture(caller: Caller, key: SectionKey, output: MeetingOutput): CaptureOutcome {
    const row = findSection(this.instance, key);
    const template = sectionTemplateOf(row, {
      template: agendaTemplate(this.series.agendaTemplateId),
      packSections: this.series.id === 'ser_ceo_weekly' ? marketing : [],
    });
    const outcome = captureOutput(
      this.ctx,
      caller,
      {
        series: this.series,
        instance: this.instance,
        section: key,
        template,
        workstreamIds: this.series.workstreamIds,
      },
      output,
    );
    this.apply(outcome.changes);
    return outcome;
  }

  items(): ActionItem[] {
    return [...this.records.values()].filter((r) =>
      (r as { id: string }).id.startsWith('act_'),
    ) as ActionItem[];
  }

  decisions(): Decision[] {
    return [...this.records.values()].filter((r) =>
      (r as { id: string }).id.startsWith('dec_'),
    ) as Decision[];
  }
}

const weekly = () => new Meeting('ser_ceo_weekly', '2026-11-13T15:00', '2026-11-13T09:30:00Z');
const ISSUES: SectionKey = { sectionId: 'issues' };
const due = (date: string) => ({ date, timeZone: 'Asia/Kolkata' });

const newItem = (
  fields: Partial<Extract<MeetingOutput, { kind: 'action_item' }>['item']> = {},
): MeetingOutput => ({
  kind: 'action_item',
  item: {
    workstreamId: 'ws_ald',
    title: 'Send the consulting lead the phased plan',
    doneMeans: 'The consulting lead has the phased plan in their inbox.',
    due: due('2026-11-20'),
    ...fields,
  },
});

describe('02 §6.3 action items', () => {
  it('a captured item is a draft from the meeting section, with a prefilled evidence requirement', () => {
    const meeting = weekly();
    const outcome = meeting.capture(user, ISSUES, newItem());
    const created = outcome.record as ActionItem;
    expect(created.lifecycle).toBe('draft');
    expect(created.source).toEqual({
      kind: 'meeting',
      meetingId: meeting.instance.id,
      sectionId: 'issues',
    });
    expect(created.evidenceRequirements).toEqual([
      {
        id: 'er1',
        description: 'Shows: The consulting lead has the phased plan in their inbox.',
        required: true,
        acceptedKinds: ['url', 'file', 'connector_record', 'note'],
      },
    ]);
    expect(meeting.instance.outputs.actionItemIds).toEqual([created.id]);
    expect(outcome.changes.map((c) => c.event.type)).toEqual([
      'action_item.created',
      'meeting_instance.output_captured',
    ]);
  });

  it('INV-03-04 holds at capture even for a draft: done-means, due date and a required requirement', () => {
    const meeting = weekly();
    const blank = failure(() => meeting.capture(user, ISSUES, newItem({ doneMeans: ' ' })));
    expect([blank.code, blank.rule]).toEqual(['E_INVARIANT', 'INV-03-04']);
    const optional = failure(() =>
      meeting.capture(
        user,
        ISSUES,
        newItem({
          evidenceRequirements: [
            { id: 'er1', description: 'Nice to have', required: false, acceptedKinds: ['note'] },
          ],
        }),
      ),
    );
    expect(optional.rule).toBe('INV-03-04');
  });

  it('a section takes only its allowed outputs; a shared section of a merged meeting needs the workstream', () => {
    const meeting = weekly();
    const wrong = failure(() =>
      meeting.capture(user, { sectionId: 'action_review', workstreamId: 'ws_ald' }, newItem()),
    );
    expect([wrong.code, wrong.rule]).toEqual(['E_INVARIANT', '02 §5']);
    const unnamed = failure(() =>
      meeting.capture(user, ISSUES, newItem({ workstreamId: undefined as never })),
    );
    expect([unnamed.code, unnamed.rule]).toEqual(['E_USAGE', '02 §4.4']);
    const outside = failure(() =>
      meeting.capture(user, ISSUES, newItem({ workstreamId: 'ws_goal' })),
    );
    expect(outside.code).toBe('E_INVARIANT');
    const missing = failure(() =>
      meeting.capture(user, { sectionId: 'planning' }, { kind: 'note', text: 'x' }),
    );
    expect(missing.code).toBe('E_NOT_FOUND');
  });

  it('outputs are captured into a meeting in progress only', () => {
    const meeting = weekly();
    meeting.instance = { ...meeting.instance, state: 'prepared' };
    const refused = failure(() => meeting.capture(user, ISSUES, newItem()));
    expect([refused.code, refused.rule]).toEqual(['E_INVARIANT', '02 §6.3']);
  });
});

describe('02 §4.2 rule 1: agents capture drafts with meetings:capture', () => {
  it('an agent captures draft items, proposed decisions and notes', () => {
    const meeting = weekly();
    const draft = meeting.capture(agent, ISSUES, newItem()).record as ActionItem;
    expect([draft.lifecycle, draft.createdBy]).toEqual(['draft', agent.actor]);
    const proposed = meeting.capture(agent, ISSUES, {
      kind: 'decision',
      workstreamId: 'ws_ald',
      question: 'Phase the audit pricing?',
      reversibility: 'two_way',
    }).record as Decision;
    expect(proposed.status).toBe('proposed');
    meeting.capture(agent, { sectionId: 'headlines' }, { kind: 'note', text: 'Pilot signed' });
    expect(meeting.instance.notes).toBe('[headlines] Pilot signed');
  });

  it('agents cannot decide, verify, read measures or raise issues through the meeting', () => {
    const meeting = weekly();
    const decided = failure(() =>
      meeting.capture(agent, ISSUES, {
        kind: 'decision',
        workstreamId: 'ws_ald',
        question: 'Phase the audit pricing?',
        reversibility: 'two_way',
        outcome: { text: 'Yes', why: 'Lower entry price' },
      }),
    );
    expect(decided.code).toBe('E_FORBIDDEN');
    const claimed = item('A-0142', {
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-12T00:00:00Z', by: { kind: 'user' } },
    });
    for (const output of [
      { kind: 'verification', item: claimed, result: 'attested', note: 'Seen' },
      { kind: 'issue', workstreamId: 'ws_ald', title: 'Pricing' },
    ] as MeetingOutput[]) {
      const key =
        output.kind === 'verification'
          ? { sectionId: 'action_review', workstreamId: 'ws_ald' }
          : ISSUES;
      expect(failure(() => meeting.capture(agent, key, output)).code).toBe('E_FORBIDDEN');
    }
    const noScope = failure(() =>
      meeting.capture({ actor: agent.actor, scopes: ['read', 'items:write'] }, ISSUES, newItem()),
    );
    expect(noScope.code).toBe('E_FORBIDDEN');
  });
});

describe('02 §6.3 decisions', () => {
  const question = {
    kind: 'decision' as const,
    workstreamId: 'ws_ald' as const,
    question: 'Phase the audit pricing?',
  };

  it('the user decides on the spot: decided, with its action items created open', () => {
    const meeting = weekly();
    const outcome = meeting.capture(user, ISSUES, {
      ...question,
      reversibility: 'two_way',
      outcome: {
        text: 'Offer two phases',
        why: 'Lower entry price',
        actionItems: [
          {
            title: 'Write the two-phase offer',
            doneMeans: 'The two-phase offer is in the proposal folder.',
            due: due('2026-11-18'),
            evidenceRequirements: [
              { id: 'er1', description: 'Offer document', required: true, acceptedKinds: ['file'] },
            ],
          },
        ],
      },
    });
    const decision = outcome.record as Decision;
    expect(decision.status).toBe('decided');
    expect(decision.source).toEqual({
      kind: 'meeting',
      meetingId: meeting.instance.id,
      sectionId: 'issues',
    });
    expect(meeting.instance.outputs.decisionIds).toEqual([decision.id]);
    expect(meeting.instance.outputs.actionItemIds).toEqual(decision.actionItemIds);
    expect(meeting.get<ActionItem>(decision.actionItemIds[0] ?? '').lifecycle).toBe('open');
  });

  it('INV-03-02: the decider is a person', () => {
    const meeting = weekly();
    const error = failure(() =>
      meeting.capture(user, ISSUES, {
        ...question,
        reversibility: 'two_way',
        deciderId: 'per_nobody',
      }),
    );
    expect([error.code, error.rule]).toEqual(['E_INVARIANT', 'INV-03-02']);
  });

  it('03 §10 rule 3: a one-way door needs a memo, or a waiver note when memos are off', () => {
    const meeting = weekly();
    const refused = failure(() =>
      meeting.capture(user, ISSUES, { ...question, reversibility: 'one_way' }),
    );
    expect([refused.code, refused.rule]).toEqual(['E_INVARIANT', '03 §10']);
    const waived = failure(() =>
      meeting.capture(user, ISSUES, { ...question, reversibility: 'one_way', waiverNote: 'Small' }),
    );
    expect(waived.rule).toBe('03 §10');
    const withWaiver = meeting.capture(user, ISSUES, {
      ...question,
      reversibility: 'one_way',
      memoForOneWayDoors: false,
      waiverNote: 'Small and reversible in practice',
    });
    expect((withWaiver.record as Decision).status).toBe('open');
    const memo = 'a'.repeat(64);
    const withMemo = meeting.capture(user, ISSUES, {
      ...question,
      reversibility: 'one_way',
      memoSha256: memo as never,
    });
    expect((withMemo.record as Decision).memoSha256).toBe(memo);
  });
});

describe('02 §6.3 issues, verifications, measures, goals, status and notes', () => {
  it('E-6: a resolved issue links a decision or action, or is dropped with a note', () => {
    const meeting = weekly();
    const raised = meeting.capture(user, ISSUES, {
      kind: 'issue',
      workstreamId: 'ws_ald',
      title: 'Proposal stuck',
    }).record as Issue;
    expect(raised.raisedFrom).toEqual({
      kind: 'meeting',
      meetingId: meeting.instance.id,
      sectionId: 'issues',
    });
    const bare = failure(() =>
      meeting.capture(user, ISSUES, {
        kind: 'issue_resolution',
        issue: raised,
        resolution: { kind: 'action', refs: [], note: '' },
      }),
    );
    expect(bare.rule).toBe('INV-03-11');
    const dropped = meeting.capture(user, ISSUES, {
      kind: 'issue_resolution',
      issue: meeting.get<Issue>(raised.id),
      resolution: { kind: 'dropped', refs: [], note: 'Client moved on' },
    });
    expect((dropped.record as Issue).status).toBe('dropped');
    expect(meeting.instance.outputs.statusUpdates).toEqual([
      { ref: raised.ref, field: 'lifecycle', from: 'open', to: 'dropped' },
    ]);
  });

  it("INV-03-07: verifications are the user's, recorded on the instance", () => {
    const meeting = weekly();
    const claimed = item('A-0142', {
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-12T00:00:00Z', by: { kind: 'user' } },
    });
    const key = { sectionId: 'action_review', workstreamId: 'ws_ald' };
    const attested = meeting.capture(user, key, {
      kind: 'verification',
      item: claimed,
      result: 'attested',
      note: 'Saw the sent mail',
    });
    expect((attested.record as ActionItem).lifecycle).toBe('verified_done');
    const rejected = meeting.capture(user, key, {
      kind: 'verification',
      item: item('A-0160', {
        lifecycle: 'claimed_done',
        claim: { at: '2026-11-12T00:00:00Z', by: { kind: 'user' } },
      }),
      result: 'rejected',
      note: 'Only two posts went out',
    });
    expect((rejected.record as ActionItem).lifecycle).toBe('in_progress');
    expect(meeting.instance.outputs.verifications).toEqual([
      { actionItemId: claimed.id, result: 'attested' },
      { actionItemId: item('A-0160').id, result: 'rejected' },
    ]);
  });

  it('measure values: unit and period match the measure; a reading records the actor', () => {
    const meeting = weekly();
    const k3 = fixtures<Measure>('measure').find((m) => m.ref === 'K-0003');
    const w46 = fixtures<MeasureValue>('measure_value')[0];
    if (k3 === undefined || w46 === undefined) throw new Error('fixtures');
    const key = { sectionId: 'scorecard', workstreamId: 'ws_ald' };
    const wrongUnit = failure(() =>
      meeting.capture(user, key, {
        kind: 'measure_value',
        measure: k3,
        periodStart: '2026-11-02',
        value: true,
      }),
    );
    expect([wrongUnit.code, wrongUnit.rule]).toEqual(['E_INVARIANT', '02 §6.3']);
    const wrongPeriod = failure(() =>
      meeting.capture(user, key, {
        kind: 'measure_value',
        measure: k3,
        periodStart: '2026-11-03',
        value: 2,
      }),
    );
    expect(wrongPeriod.message).toContain('does not start a weekly period');
    const read = meeting.capture(user, key, {
      kind: 'measure_value',
      measure: k3,
      existing: w46,
      periodStart: '2026-11-09',
      normal: true,
    });
    expect(read.changes.map((c) => c.event.type)).toEqual([
      'measure_value.read',
      'meeting_instance.output_captured',
    ]);
    expect((read.record as MeasureValue).normal).toBe(true);
    const recorded = meeting.capture(user, key, {
      kind: 'measure_value',
      measure: k3,
      periodStart: '2026-11-02',
      value: 3,
    });
    expect((recorded.record as MeasureValue).recordedBy).toEqual({ kind: 'user' });
    expect(meeting.instance.outputs.measureValueIds).toEqual([
      w46.id,
      (recorded.record as MeasureValue).id,
    ]);
  });

  it('02 §5.1: a not-normal line with no explanation creates a draft follow-up', () => {
    const meeting = weekly();
    const k3 = fixtures<Measure>('measure').find((m) => m.ref === 'K-0003');
    if (k3 === undefined) throw new Error('fixtures');
    const outcome = meeting.capture(
      user,
      { sectionId: 'scorecard', workstreamId: 'ws_ald' },
      {
        kind: 'measure_value',
        measure: k3,
        periodStart: '2026-11-02',
        value: 0,
        normal: false,
      },
    );
    const followUp = meeting.get<ActionItem>(meeting.instance.outputs.actionItemIds[0] ?? '');
    expect([followUp.kind, followUp.lifecycle, followUp.ownerId, followUp.due.date]).toEqual([
      'follow_up',
      'draft',
      'per_self',
      '2026-11-20',
    ]);
    expect((outcome.record as MeasureValue).note).toBe(
      `Not normal, no explanation yet: follow-up ${followUp.ref}`,
    );
  });

  it('goal grades: rocks done or not done only; WIGs by the lag value at target.by', () => {
    const meeting = new Meeting('ser_ceo_quarterly', '2026-12-18T09:45', '2026-12-18T04:15:00Z');
    const goal = meeting.byRef<Goal>('G-0004');
    const key = { sectionId: 'planning_grade' };
    const partial = failure(() =>
      meeting.capture(user, key, { kind: 'goal_grade', goal, goalModel: 'rocks', grade: 0.9 }),
    );
    expect([partial.code, partial.message]).toEqual([
      'E_INVARIANT',
      'G-0004 (rocks) is graded done (1) or not done (0) only',
    ]);
    const graded = meeting.capture(user, key, {
      kind: 'goal_grade',
      goal,
      goalModel: 'rocks',
      grade: 1,
    });
    expect([(graded.record as Goal).grade, (graded.record as Goal).status]).toEqual([1, 'done']);
    const okr = failure(() =>
      meeting.capture(user, key, { kind: 'goal_grade', goal, goalModel: 'okr', grade: 1.2 }),
    );
    expect(okr.message).toContain('from 0.0 to 1.0');
  });

  it('02 §5.1 goals_review: an at-risk or off-track priority raises an issue from the meeting', () => {
    const meeting = weekly();
    const goal = { ...meeting.byRef<Goal>('G-0004'), health: 'on_track' as const };
    const outcome = meeting.capture(
      user,
      { sectionId: 'goals_review', workstreamId: 'ws_ald' },
      {
        kind: 'status_update',
        goal,
        field: 'health',
        health: 'off_track',
        note: 'Second client slipped',
      },
    );
    expect((outcome.record as Goal).health).toBe('off_track');
    const issue = meeting.get<Issue>(meeting.instance.outputs.issueIds[0] ?? '');
    expect(issue.raisedFrom).toEqual({
      kind: 'meeting',
      meetingId: meeting.instance.id,
      sectionId: 'goals_review',
    });
    const noNote = failure(() =>
      meeting.capture(
        user,
        { sectionId: 'goals_review', workstreamId: 'ws_ald' },
        { kind: 'status_update', goal, field: 'health', health: 'at_risk' },
      ),
    );
    expect(noNote.rule).toBe('INV-03-03');
  });

  it('a new due date is a re-plan with a reason (02 §7.1 rule 3)', () => {
    const meeting = weekly();
    const key = { sectionId: 'action_review', workstreamId: 'ws_ald' };
    const target = item('A-0160');
    expect(
      failure(() =>
        meeting.capture(user, key, {
          kind: 'status_update',
          item: target,
          field: 'due',
          due: '2026-11-26',
        }),
      ).code,
    ).toBe('E_USAGE');
    const replanned = meeting.capture(user, key, {
      kind: 'status_update',
      item: target,
      field: 'due',
      due: '2026-11-26',
      reason: 'Client asked',
    });
    expect((replanned.record as ActionItem).replannedCount).toBe(1);
    expect(meeting.instance.outputs.statusUpdates).toEqual([
      { ref: 'A-0160', field: 'due', from: '2026-11-19', to: '2026-11-26' },
    ]);
  });
});

describe('02 §6.4 conclude and close', () => {
  function withDrafts() {
    const meeting = weekly();
    const mine = meeting.capture(user, ISSUES, newItem()).record as ActionItem;
    const theirs = meeting.capture(
      user,
      ISSUES,
      newItem({ ownerId: 'per_client', title: 'Send the signed statement of work back' }),
    ).record as ActionItem;
    const decision = meeting.capture(user, ISSUES, {
      kind: 'decision',
      workstreamId: 'ws_ald',
      question: 'Phase the audit pricing?',
      reversibility: 'two_way',
    }).record as Decision;
    return { meeting, mine, theirs, decision };
  }

  it('the conclude section reads back every new item and decision: owner, deliverable, due, done-means', () => {
    const { meeting, mine, theirs, decision } = withDrafts();
    expect(
      readBackList({
        series: meeting.series,
        instance: meeting.instance,
        selfPersonId: 'per_self',
        items: meeting.items(),
        decisions: meeting.decisions(),
      }),
    ).toEqual([
      {
        kind: 'action_item',
        ref: mine.ref,
        ownerId: 'per_self',
        ownerPresent: true,
        deliverable: mine.title,
        due: '2026-11-20',
        doneMeans: mine.doneMeans,
        state: 'draft',
      },
      {
        kind: 'action_item',
        ref: theirs.ref,
        ownerId: 'per_client',
        ownerPresent: false,
        deliverable: theirs.title,
        due: '2026-11-20',
        doneMeans: theirs.doneMeans,
        state: 'draft',
      },
      {
        kind: 'decision',
        ref: decision.ref,
        ownerId: 'per_self',
        ownerPresent: true,
        deliverable: decision.question,
        state: 'open',
      },
    ]);
  });

  it('read-back is human-only: an agent gets E_HUMAN_REQUIRED with the meeting link', () => {
    const { meeting } = withDrafts();
    const error = failure(() =>
      confirmReadBack(meeting.ctx, agent, {
        series: meeting.series,
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      }),
    );
    expect([error.code, error.help.at(-1)]).toEqual([
      'E_HUMAN_REQUIRED',
      meetingLink(meeting.instance),
    ]);
    expect(meetingLink(meeting.instance)).toBe(`commandcenter://meeting/${meeting.instance.ref}`);
  });

  it("read-back accepts the drafts of present owners; an absent owner's draft waits unless the user records the acceptance", () => {
    const { meeting, mine, theirs } = withDrafts();
    const first = confirmReadBack(meeting.ctx, user, {
      series: meeting.series,
      instance: meeting.instance,
      items: meeting.items(),
      decisions: meeting.decisions(),
    });
    meeting.apply(first.changes);
    expect([first.accepted, first.pending]).toEqual([[mine.ref], [theirs.ref]]);
    expect(meeting.get<ActionItem>(mine.id).lifecycle).toBe('open');
    expect(meeting.get<ActionItem>(theirs.id).lifecycle).toBe('draft');
    expect(meeting.instance.readBackConfirmedAt).toBe('2026-11-13T09:30:00Z');
    const second = confirmReadBack(meeting.ctx, user, {
      series: meeting.series,
      instance: meeting.instance,
      items: meeting.items(),
      decisions: meeting.decisions(),
      acceptances: [{ ref: theirs.ref, note: 'The client contact agreed on the call' }],
    });
    meeting.apply(second.changes);
    expect(second.accepted).toEqual([theirs.ref]);
    expect(meeting.get<ActionItem>(theirs.id).lifecycle).toBe('open');
  });

  it('C-02-04 a meeting cannot close before read-back; a new item after read-back needs it again', () => {
    const { meeting } = withDrafts();
    const close = () =>
      closeMeeting(meeting.ctx, user, {
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      });
    const early = failure(close);
    expect([early.code, early.rule, early.message]).toEqual([
      'E_INVARIANT',
      'C-02-04',
      `${meeting.instance.ref} cannot close: read-back is not confirmed`,
    ]);
    meeting.apply(
      confirmReadBack(meeting.ctx, user, {
        series: meeting.series,
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      }).changes,
    );
    meeting.capture(user, ISSUES, newItem({ title: 'One more thing' }));
    expect(meeting.instance.readBackConfirmedAt).toBeUndefined();
    expect(failure(close).rule).toBe('C-02-04');
    meeting.apply(
      confirmReadBack(meeting.ctx, user, {
        series: meeting.series,
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      }).changes,
    );
    const closed = close();
    checkChanges(closed.changes);
    expect([closed.record.state, closed.record.actualEnd]).toEqual([
      'completed',
      '2026-11-13T09:30:00Z',
    ]);
    expect(closed.changes.map((c) => c.event.type)).toEqual(['meeting_instance.completed']);
  });

  it('C-02-04 every new decision has a decider, every new item an owner who is a person', () => {
    const { meeting, decision } = withDrafts();
    meeting.apply(
      confirmReadBack(meeting.ctx, user, {
        series: meeting.series,
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      }).changes,
    );
    meeting.records.set(decision.id, {
      ...meeting.get<Decision>(decision.id),
      deciderId: 'per_gone',
    });
    const error = failure(() =>
      closeMeeting(meeting.ctx, user, {
        instance: meeting.instance,
        items: meeting.items(),
        decisions: meeting.decisions(),
      }),
    );
    expect([error.rule, error.message]).toEqual([
      'C-02-04',
      `${meeting.instance.ref} cannot close: ${decision.ref} needs a decider`,
    ]);
  });

  it('only the user closes; agents never do', () => {
    const { meeting } = withDrafts();
    expect(
      failure(() =>
        closeMeeting(meeting.ctx, agent, { instance: meeting.instance, items: [], decisions: [] }),
      ).code,
    ).toBe('E_FORBIDDEN');
  });

  it('02 §6.4 rule 2: items closed in the meeting with an inform list get a "tell when done" draft', () => {
    const meeting = weekly();
    const claimed = item('A-0142', {
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-12T00:00:00Z', by: { kind: 'user' } },
      informIds: ['per_client'],
    });
    meeting.capture(
      user,
      { sectionId: 'action_review', workstreamId: 'ws_ald' },
      { kind: 'verification', item: claimed, result: 'attested', note: 'Seen' },
    );
    expect(informDrafts(meeting.instance, meeting.items())).toEqual([
      {
        ref: 'A-0142',
        to: ['per_client'],
        text: `A-0142 ${claimed.title} is done: ${claimed.doneMeans}`,
      },
    ]);
  });

  it('the user marks sections done or skipped and rates the meeting 1-10', () => {
    const meeting = weekly();
    const key = { sectionId: 'scorecard', workstreamId: 'ws_qlm' };
    const done = setSectionStatus(meeting.ctx, user, meeting.instance, key, 'done');
    checkChanges(done.changes);
    expect(findSection(done.record, key).status).toBe('done');
    expect(setSectionStatus(meeting.ctx, user, done.record, key, 'done').status).toBe('no-op');
    expect(
      failure(() => setSectionStatus(meeting.ctx, agent, meeting.instance, key, 'done')).code,
    ).toBe('E_FORBIDDEN');
    expect(rateMeeting(meeting.ctx, user, meeting.instance, 8).record.rating).toBe(8);
    expect(failure(() => rateMeeting(meeting.ctx, user, meeting.instance, 11)).code).toBe(
      'E_INVARIANT',
    );
  });
});
