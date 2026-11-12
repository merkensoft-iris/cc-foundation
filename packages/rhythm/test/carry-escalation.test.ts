/**
 * Carry-forward and escalation (02 §7; P1-09): which reviews count an item (02 §7.1 rule 2 as
 * decided, key p1-09-carry-rule), the close transaction's carry step (C-02-05), the escalation
 * ladder E0 to E4 and its rules (02 §7.2, C-02-06), and AC-02-05 on the pure close path.
 */
import { describe, expect, it } from 'vitest';

import { carryItem, escalateItem, replanItem, type Change } from '@cc/domain';
import {
  agendaTemplate,
  buildPreread,
  carryForward,
  closeMeeting,
  DEFAULT_ESCALATION_THRESHOLDS,
  ESCALATION_CALLER,
  escalationIssueTitle,
  incrementsCarryCount,
  isReviewSeries,
  itemHistory,
  ladderLevel,
  overdueFrom,
  quarterStart,
  RHYTHM_CALLER,
  runEscalation,
  type ReviewSighting,
} from '@cc/rhythm';
import type { ActionItem, DomainEvent, Goal, Issue, MeetingSeries } from '@cc/schemas';

import { checkChanges, failure } from './harness.ts';
import {
  fixtures,
  instanceOf,
  item,
  meetingData,
  meetingHarness,
  seriesById,
  sha256,
  user,
} from './meetings-harness.ts';

const IST = 'Asia/Kolkata';
const weekly = seriesById('ser_ceo_weekly');
const monthly = seriesById('ser_ceo_monthly');
const dailyStart = seriesById('ser_daily_start');

/** An open Alderwick item due on `date` (IST), as the reference item A-0160 with fields set. */
function openItem(date: string, fields: Partial<ActionItem> = {}): ActionItem {
  return item('A-0160', {
    lifecycle: 'open',
    due: { date, timeZone: IST },
    links: { goalIds: [], measureIds: [], decisionIds: [], issueIds: [] },
    ...fields,
  });
}

const completed = (seriesId: string, local: string) =>
  instanceOf(seriesId, local, { state: 'completed' });

describe('02 §7.1 rule 2 which completed instances count an item (key p1-09-carry-rule)', () => {
  it('counts a review only when the item was overdue at its local start date, not on its due day', () => {
    const review = completed('ser_ceo_weekly', '2026-11-13T15:00');
    expect(incrementsCarryCount(weekly, review, openItem('2026-11-13'))).toBe(false);
    expect(incrementsCarryCount(weekly, review, openItem('2026-11-12'))).toBe(true);
    expect(incrementsCarryCount(weekly, review, openItem('2026-11-14'))).toBe(false);
  });

  it('counts reviews only: weekly or slower series, never the daily start or shutdown', () => {
    expect(isReviewSeries(dailyStart)).toBe(false);
    expect(isReviewSeries(seriesById('ser_daily_shutdown'))).toBe(false);
    for (const id of ['ser_ceo_weekly', 'ser_goal_wig', 'ser_ceo_monthly', 'ser_ceo_yearly']) {
      expect(isReviewSeries(seriesById(id))).toBe(true);
    }
    const daily = completed('ser_daily_start', '2026-11-16T09:00');
    expect(incrementsCarryCount(dailyStart, daily, openItem('2026-11-13'))).toBe(false);
  });

  it('counts only completed instances, items in scope, and accepted unsettled items', () => {
    const local = '2026-11-20T15:00';
    const due = openItem('2026-11-13');
    for (const state of ['missed', 'skipped', 'absorbed', 'cancelled', 'prepared'] as const) {
      expect(
        incrementsCarryCount(weekly, instanceOf('ser_ceo_weekly', local, { state }), due),
      ).toBe(false);
    }
    const review = completed('ser_ceo_weekly', local);
    expect(incrementsCarryCount(weekly, review, { ...due, workstreamId: 'ws_goal' as never })).toBe(
      false,
    );
    for (const lifecycle of ['draft', 'claimed_done', 'verified_done', 'dropped'] as const) {
      expect(incrementsCarryCount(weekly, review, { ...due, lifecycle })).toBe(false);
    }
    for (const lifecycle of ['open', 'in_progress', 'waiting'] as const) {
      expect(incrementsCarryCount(weekly, review, { ...due, lifecycle })).toBe(true);
    }
  });

  it("reads the review's local start date in the item's time zone (ADR 0001)", () => {
    // A weekly review on Friday 09:00 IST is still Thursday 22:30 in New York.
    const morning: MeetingSeries = {
      ...weekly,
      workstreamIds: ['ws_us'] as MeetingSeries['workstreamIds'],
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
      dtstart: '2026-11-13T09:00',
    };
    const review = { state: 'completed' as const, scheduledStart: '2026-11-20T03:30:00Z' };
    const friend = (date: string, timeZone: string) =>
      openItem(date, { workstreamId: 'ws_us' as never, due: { date, timeZone } });
    expect(incrementsCarryCount(morning, review, friend('2026-11-19', 'America/New_York'))).toBe(
      false,
    );
    expect(incrementsCarryCount(morning, review, friend('2026-11-19', IST))).toBe(true);
    expect(incrementsCarryCount(morning, review, friend('2026-11-18', 'America/New_York'))).toBe(
      true,
    );
  });
});

describe('C-02-05 the carry step of a close', () => {
  it('C-02-05 increments carryCount once per (item, completed instance) pair, with one event naming the meeting', () => {
    const { ctx } = meetingHarness('2026-11-20T10:30:00Z');
    const review = completed('ser_ceo_weekly', '2026-11-20T15:00');
    const items = [
      openItem('2026-11-13'),
      openItem('2026-11-20', { id: 'act_due_today' as never }),
    ];
    const first = carryForward(ctx, RHYTHM_CALLER, { series: weekly, instance: review, items });
    checkChanges(first.changes);
    expect(first.carried).toEqual(['A-0160']);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.event.type).toBe('action_item.carried');
    expect(first.changes[0]?.event.after).toMatchObject({ carryCount: 1, meetingId: review.id });
    expect(first.items[0]?.carryCount).toBe(1);
    expect(first.items[1]?.carryCount).toBe(0);

    const counted = new Set(
      first.changes
        .filter(
          (c) => (c.event.after as { meetingId?: string } | undefined)?.meetingId === review.id,
        )
        .map((c) => c.event.entity.id),
    );
    const again = carryForward(ctx, RHYTHM_CALLER, {
      series: weekly,
      instance: review,
      items: first.items,
      counted: (id) => counted.has(id),
    });
    expect(again.changes).toEqual([]);
    expect(again.items[0]?.carryCount).toBe(1);
  });

  it('AC-02-06 skipping the 2026-12-25 weekly instance with the reason "holiday" carries nothing', () => {
    const { ctx } = meetingHarness('2026-12-25T10:30:00Z');
    const skipped = instanceOf('ser_ceo_weekly', '2026-12-25T15:00', {
      state: 'skipped',
      skipReason: 'holiday',
    });
    const result = carryForward(ctx, RHYTHM_CALLER, {
      series: weekly,
      instance: skipped,
      items: [openItem('2026-11-13', { carryCount: 2 })],
    });
    expect(result.changes).toEqual([]);
    expect(result.carried).toEqual([]);
    expect(result.items[0]?.carryCount).toBe(2);
  });

  it('only the rhythm engine sets carry counts', () => {
    const { ctx } = meetingHarness();
    expect(failure(() => carryItem(ctx, user, openItem('2026-11-13'), 'mtg_x')).code).toBe(
      'E_FORBIDDEN',
    );
    expect(failure(() => carryItem(ctx, ESCALATION_CALLER, openItem('2026-11-13'), 'x')).code).toBe(
      'E_FORBIDDEN',
    );
  });
});

const NOW = '2026-11-20T10:30:00Z';

function ladder(
  target: ActionItem,
  facts: Partial<Parameters<typeof ladderLevel>[1]> = {},
): ReturnType<typeof ladderLevel> {
  return ladderLevel(target, {
    now: NOW,
    workspaceTimeZone: IST,
    thresholds: DEFAULT_ESCALATION_THRESHOLDS,
    carries: target.carryCount,
    offTrackAtTwoReviews: false,
    goals: [],
    ...facts,
  });
}

describe('02 §7.2 the escalation ladder', () => {
  it('E1: overdue, or health at_risk or worse', () => {
    expect(ladder(openItem('2026-11-20')).level).toBe(0);
    expect(ladder(openItem('2026-11-19'))).toEqual({ level: 1, triggers: ['overdue'] });
    expect(
      ladder(openItem('2026-11-25', { health: 'at_risk', healthNote: 'Waiting on the client' })),
    ).toEqual({ level: 1, triggers: ['at_risk'] });
  });

  it('E1 counts from 00:00 the day after a date-only due date, or from an explicit due time (ADR 0001 decision 7)', () => {
    expect(overdueFrom({ date: '2026-11-19', timeZone: IST })).toBe('2026-11-19T18:30:00Z');
    expect(overdueFrom({ date: '2026-11-19', timeZone: 'America/New_York' })).toBe(
      '2026-11-20T05:00:00Z',
    );
    expect(overdueFrom({ date: '2026-11-20', time: '15:00', timeZone: IST })).toBe(
      '2026-11-20T09:30:00Z',
    );
    const friend = openItem('2026-11-19', {
      due: { date: '2026-11-19', timeZone: 'America/New_York' },
    });
    // 10:29 IST on 11-20 is still 11-19 23:59 in New York.
    expect(ladder(friend, { now: '2026-11-20T04:59:00Z' }).level).toBe(0);
    expect(ladder(friend, { now: '2026-11-20T05:00:00Z' }).level).toBe(1);
    expect(ladder(openItem('2026-11-19'), { now: '2026-11-20T04:59:00Z' }).level).toBe(1);
  });

  it('E2: carried e2CarryCount times, or off track at two consecutive reviews', () => {
    expect(ladder(openItem('2026-11-30'), { carries: 1 }).level).toBe(0);
    expect(ladder(openItem('2026-11-30'), { carries: 2 })).toEqual({
      level: 2,
      triggers: ['carried'],
    });
    expect(ladder(openItem('2026-11-30'), { offTrackAtTwoReviews: true }).level).toBe(2);
    const strict = { ...DEFAULT_ESCALATION_THRESHOLDS, e2CarryCount: 1 };
    expect(ladder(openItem('2026-11-30'), { carries: 1, thresholds: strict }).level).toBe(2);
  });

  it('E3: carried e3CarryCount times, overdue more than e3OverdueDays, or linked to an off-track priority or WIG', () => {
    expect(ladder(openItem('2026-11-30'), { carries: 4 }).level).toBe(3);
    expect(ladder(openItem('2026-10-21')).level).toBe(1); // 29 days and 16 hours late
    expect(ladder(openItem('2026-10-20'))).toEqual({
      level: 3,
      triggers: ['overdue', 'overdue_long'],
    });
    const [priority, wig] = fixtures<Goal>('goal');
    const linked = openItem('2026-11-30', {
      links: { goalIds: [priority!.id], measureIds: [], decisionIds: [], issueIds: [] },
    });
    const offTrack = { ...priority!, health: 'off_track' as const };
    expect(ladder(linked, { goals: [priority!] }).level).toBe(0);
    expect(ladder(linked, { goals: [offTrack] })).toEqual({
      level: 3,
      triggers: ['goal_off_track'],
    });
    expect(ladder(linked, { goals: [{ ...offTrack, status: 'done' }] }).level).toBe(0);
    expect(ladder(linked, { goals: [{ ...offTrack, kind: 'annual' }] }).level).toBe(0);
    void wig;
  });

  it('E4: a quarter end passes with the item at E3 or above', () => {
    expect(quarterStart('2027-01-01T00:00:00Z', IST)).toBe('2026-12-31T18:30:00Z');
    expect(quarterStart('2026-12-31T18:00:00Z', IST)).toBe('2026-09-30T18:30:00Z');
    const e3 = openItem('2026-11-30', { escalationLevel: 3 });
    const at = '2027-01-01T00:00:00Z';
    expect(ladder(e3, { now: at, e3Since: '2026-12-31T17:00:00Z' }).level).toBe(4);
    expect(ladder(e3, { now: at, e3Since: '2026-12-31T19:00:00Z' }).triggers).not.toContain(
      'quarter_end',
    );
    expect(ladder(openItem('2026-12-30'), { now: at, e3Since: '2026-10-01T00:00:00Z' }).level).toBe(
      1,
    );
  });
});

function run(
  at: string,
  items: readonly ActionItem[],
  extra: Partial<Parameters<typeof runEscalation>[2]> = {},
) {
  const { ctx } = meetingHarness(at);
  return runEscalation(ctx, ESCALATION_CALLER, {
    items,
    goals: [],
    issues: [],
    workspaceTimeZone: IST,
    ...extra,
  });
}

describe('02 §7.2 the escalation job', () => {
  it('applies health rule 2 first, raises the level with one event naming its triggers, and asks to notify once', () => {
    const result = run('2026-11-14T18:35:00Z', [openItem('2026-11-13')]);
    checkChanges(result.changes);
    expect(result.changes.map((c) => c.event.type)).toEqual([
      'action_item.health_set',
      'action_item.escalated',
    ]);
    const [escalated] = result.items;
    expect(escalated?.health).toBe('off_track');
    expect(escalated?.escalationLevel).toBe(1);
    expect(result.escalated).toEqual([
      { ref: 'A-0160', from: 0, to: 1, triggers: ['overdue', 'at_risk'] },
    ]);
    expect(result.changes[1]?.event.after).toMatchObject({
      escalationLevel: 1,
      from: 0,
      notifiedOn: '2026-11-15',
      escalatedAt: '2026-11-14T18:35:00Z',
    });
    expect(result.notify).toEqual(['A-0160']);
    expect(result.reviewed).toEqual([]);

    const again = run('2026-11-15T18:35:00Z', result.items);
    expect(again.status).toBe('no-op');
    expect(again.changes).toEqual([]);
  });

  it('notifies E1 and above at most once per item per day (02 §7.2 rule 3)', () => {
    const history = { notifiedOn: '2026-11-15' };
    const raised = run('2026-11-15T10:00:00Z', [openItem('2026-11-13', { escalationLevel: 1 })], {
      history: () => ({ ...history, carriesSinceReplan: 2 }),
    });
    expect(raised.escalated.map((e) => e.to)).toEqual([2]);
    expect(raised.notify).toEqual([]);
    expect(
      (raised.changes.find((c) => c.event.type === 'action_item.escalated')?.event
        .after as object) ?? {},
    ).not.toHaveProperty('notifiedOn');
  });

  it("E2 raises one issue on the item's workstream and links it; an open one is not raised twice", () => {
    const due = openItem('2026-11-13', { carryCount: 2, escalationLevel: 1 });
    const result = run('2026-11-27T11:00:00Z', [due]);
    checkChanges(result.changes);
    const [issue] = result.issues;
    expect(issue).toMatchObject({
      workstreamId: 'ws_ald',
      status: 'open',
      raisedFrom: { kind: 'escalation', actionItemId: due.id, level: 2 },
      title: escalationIssueTitle(due),
    });
    expect(result.items[0]?.links.issueIds).toEqual([issue!.id]);
    expect(result.items[0]?.escalationLevel).toBe(2);

    const open: Issue[] = [issue!];
    const replanned = run('2026-11-27T11:00:00Z', [{ ...due, escalationLevel: 0 }], {
      issues: open,
    });
    expect(replanned.issues).toEqual([]);
    expect(replanned.items[0]?.escalationLevel).toBe(2);
  });

  it('E0: a reminder at the next daily start, and a nudge draft for an owner who is not the user; nothing is sent', () => {
    const mine = openItem('2026-11-21');
    const friends = item('A-0152', { due: { date: '2026-11-21', timeZone: IST } });
    const later = openItem('2026-11-23', { id: 'act_later' as never, ref: 'A-0170' });
    const result = run('2026-11-20T18:35:00Z', [mine, friends, later]);
    expect(result.reminders.map((r) => r.ref)).toEqual(['A-0160', 'A-0152']);
    expect(result.nudgeDrafts).toEqual([
      {
        ref: 'A-0152',
        to: 'per_client',
        text: `A reminder that A-0152 "${friends.title}" is due on 2026-11-21.`,
      },
    ]);
    expect(result.changes).toEqual([]);
  });

  it('leaves drafts, claimed and closed items alone', () => {
    const items = (['draft', 'claimed_done', 'verified_done', 'dropped'] as const).map(
      (lifecycle) => openItem('2026-10-01', { lifecycle, carryCount: 5 }),
    );
    const result = run('2026-11-20T18:35:00Z', items);
    expect(result.changes).toEqual([]);
    expect(result.items).toEqual(items);
  });

  it('C-02-06 escalation levels are set only by system:escalation, and never lowered by it', () => {
    const { ctx } = meetingHarness();
    const target = openItem('2026-11-13', { escalationLevel: 2 });
    expect(failure(() => escalateItem(ctx, user, target, 3)).code).toBe('E_FORBIDDEN');
    expect(failure(() => escalateItem(ctx, RHYTHM_CALLER, target, 3)).code).toBe('E_FORBIDDEN');
    expect(failure(() => escalateItem(ctx, ESCALATION_CALLER, target, 1)).rule).toBe('02 §7.2');
    expect(escalateItem(ctx, ESCALATION_CALLER, target, 2).status).toBe('no-op');
    const result = run('2026-11-20T18:35:00Z', [target]);
    expect(result.items[0]?.escalationLevel).toBe(2);
  });

  it('02 §7.1 rule 3 re-planning resets the level, and carries count again from the re-plan', () => {
    const { ctx } = meetingHarness('2026-11-27T11:00:00Z');
    const carried = openItem('2026-11-13', { carryCount: 2, escalationLevel: 2 });
    const replanned = replanItem(ctx, user, carried, { date: '2026-12-11' }, 'Client moved it');
    expect(replanned.record).toMatchObject({
      carryCount: 2,
      escalationLevel: 0,
      replannedCount: 1,
    });
    const events: DomainEvent[] = [
      event('action_item.carried', {}),
      event('action_item.carried', {}),
      event('action_item.escalated', { escalationLevel: 2 }),
      ...replanned.changes.map((c) => c.event),
    ];
    expect(itemHistory(events)).toEqual({ carriesSinceReplan: 0 });
    const result = run('2026-11-28T18:35:00Z', [replanned.record], {
      history: () => itemHistory(events),
    });
    expect(result.items[0]?.escalationLevel).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it("E2 at two consecutive off-track reviews uses the previous review's recorded health", () => {
    const offTrack = openItem('2026-12-30', {
      health: 'off_track',
      healthNote: 'Blocked on the vendor',
    });
    const review = {
      series: weekly,
      instance: completed('ser_ceo_weekly', '2026-11-27T15:00'),
      carried: [],
    };
    const first = run('2026-11-27T11:00:00Z', [offTrack], { review });
    expect(first.reviewed).toEqual([
      { itemId: offTrack.id, ref: 'A-0160', meetingId: review.instance.id, health: 'off_track' },
    ]);
    expect(first.items[0]?.escalationLevel).toBe(1);
    const history = itemHistory(first.reviewed.map(sightingEvent));
    expect(history.previousReviewHealth).toBe('off_track');
    const second = run('2026-12-04T11:00:00Z', first.items, { review, history: () => history });
    expect(second.escalated).toEqual([
      { ref: 'A-0160', from: 1, to: 2, triggers: ['at_risk', 'off_track_at_two_reviews'] },
    ]);
    // The nightly run is no review: it records no sighting and reads no review trigger.
    expect(run('2026-12-04T11:00:00Z', first.items, { history: () => history }).escalated).toEqual(
      [],
    );
  });
});

let eventCounter = 0;
function event(type: string, after: Record<string, unknown>): DomainEvent {
  eventCounter++;
  return {
    id: `evt_${String(eventCounter).padStart(26, '0')}`,
    at: '2026-11-20T00:00:00Z',
    actor: { kind: 'system', component: 'escalation' },
    type,
    entity: { kind: 'action_item', id: 'act_a0160' },
    after,
  };
}

const sightingEvent = (s: ReviewSighting): DomainEvent =>
  event('action_item.reviewed', { health: s.health, meetingId: s.meetingId });

describe('AC-02-05 on the close path', () => {
  it('AC-02-05 an open item due 2026-11-13 has carryCount 1 after the 2026-11-20 review and 2 after the 2026-11-27 monthly review, whose close creates an E2 issue on the 2026-12-04 weekly agenda', () => {
    const { ctx, clock } = meetingHarness('2026-11-13T09:30:00Z');
    let items: ActionItem[] = [openItem('2026-11-13')];
    let issues: Issue[] = [];
    const events = new Map<string, DomainEvent[]>();
    const record = (changes: readonly Change[], sightings: readonly ReviewSighting[] = []) => {
      checkChanges(changes);
      for (const c of changes) {
        if (c.kind === 'action_item') {
          const next = c.record as ActionItem;
          items = items.map((i) => (i.id === next.id ? next : i));
        } else if (c.kind === 'issue') {
          const next = c.record as Issue;
          issues = [...issues.filter((i) => i.id !== next.id), next];
        }
        events.set(c.event.entity.id, [...(events.get(c.event.entity.id) ?? []), c.event]);
      }
      for (const s of sightings) {
        events.set(s.itemId, [...(events.get(s.itemId) ?? []), sightingEvent(s)]);
      }
    };
    const history = (target: ActionItem) => itemHistory(events.get(target.id) ?? []);
    const close = (seriesId: string, local: string, end: string) => {
      const series = seriesById(seriesId);
      clock.set(end);
      const instance = instanceOf(seriesId, local, {
        state: 'in_progress',
        actualStart: end,
        readBackConfirmedAt: end,
      });
      const outcome = closeMeeting(ctx, user, {
        instance,
        items: [],
        decisions: [],
        review: {
          series,
          items,
          goals: [],
          issues: issues.filter((i) => i.status === 'open'),
          workspaceTimeZone: IST,
          history,
        },
      });
      record(outcome.changes, outcome.escalation?.reviewed);
      return outcome;
    };
    const nightly = (from: string, to: string) => {
      for (let day = from; day <= to; day = nextDay(day)) {
        clock.set(`${day}T18:35:00Z`); // 00:05 IST the next day
        record(
          runEscalation(ctx, ESCALATION_CALLER, {
            items,
            goals: [],
            issues: issues.filter((i) => i.status === 'open'),
            workspaceTimeZone: IST,
            history,
          }).changes,
        );
      }
    };

    const first = close('ser_ceo_weekly', '2026-11-13T15:00', '2026-11-13T10:30:00Z');
    expect(first.carried).toEqual([]); // due that day: not yet overdue
    expect(items[0]?.carryCount).toBe(0);
    nightly('2026-11-13', '2026-11-19');
    expect(items[0]).toMatchObject({ escalationLevel: 1, health: 'off_track' });

    const second = close('ser_ceo_weekly', '2026-11-20T15:00', '2026-11-20T10:30:00Z');
    expect(second.carried).toEqual(['A-0160']);
    expect(items[0]?.carryCount).toBe(1);
    expect(issues).toEqual([]);
    nightly('2026-11-20', '2026-11-26');
    expect(items[0]?.escalationLevel).toBe(1);
    expect(issues).toEqual([]);

    // The last Friday: the monthly review absorbs the weekly one (AC-02-02) and closes for both.
    const third = close('ser_ceo_monthly', '2026-11-27T15:00', '2026-11-27T11:30:00Z');
    expect(third.carried).toEqual(['A-0160']);
    expect(items[0]?.carryCount).toBe(2);
    expect(items[0]?.escalationLevel).toBe(2);
    const [issue] = third.escalation?.issues ?? [];
    expect(issue?.raisedFrom).toEqual({ kind: 'escalation', actionItemId: items[0]?.id, level: 2 });
    expect(third.changes.filter((c) => c.kind === 'issue')).toHaveLength(1);
    nightly('2026-11-27', '2026-12-03');
    expect(issues).toHaveLength(1);

    const next = instanceOf('ser_ceo_weekly', '2026-12-04T15:00');
    const built = buildPreread({
      series: weekly,
      instance: next,
      template: agendaTemplate(weekly.agendaTemplateId),
      data: meetingData({ actionItems: items, issues, measureValues: [], goals: [] }),
      now: '2026-12-03T09:30:00Z',
      sha256,
    });
    const issuesSection = built.agenda.find((row) => row.sectionId === 'issues');
    const listed = issuesSection?.inputResults.flatMap((r) => r.itemRefs) ?? [];
    expect(listed).toContain(issue?.ref);
    void monthly;
  });
});

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
