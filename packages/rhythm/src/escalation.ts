/**
 * The escalation ladder (02 §7.2), as the deterministic escalation job (actor
 * `system:escalation`) runs it at a review's close and nightly (rule 1). AI never escalates or
 * de-escalates.
 *
 * | Level | Trigger (any) | Effect |
 * |---|---|---|
 * | E0 | due within 1 day | a reminder to the owner at the next daily start; a nudge draft for an owner who is not the user |
 * | E1 | overdue, or health `at_risk` or worse | flagged; the owner updates the health note before the next review |
 * | E2 | carried `e2CarryCount` times (default 2), or `off_track` at two consecutive reviews | an issue (`raisedFrom.kind = 'escalation'`) on the item's workstream, which the next review's `issues` section lists |
 * | E3 | carried `e3CarryCount` times (default 4), overdue more than `e3OverdueDays` (default 30), or linked to an off-track priority or WIG | the home view and the monthly `register_health` list it |
 * | E4 | a quarter end passes with the item at E3 or above | quarterly planning's `register_health` must close, re-plan or drop it |
 *
 * E0 is level 0: it is a reminder, not a level. Levels never decrease (rule 2) except by
 * re-planning (`replanItem` resets the level to 0), verification or drop, which close the item.
 *
 * Readings taken where 02 §7.2 is silent (stated in 02 §7.2):
 *
 * - The job sees items being worked on (`open`, `in_progress`, `waiting`). A draft is not a
 *   commitment yet and a claimed item waits for its review, so neither rises.
 * - Carries and review sightings count from the item's last re-plan. Re-planning keeps
 *   `carryCount` as history (02 §7.1 rule 3); counting the whole history would raise a
 *   re-planned item straight back to E2 on the next run.
 * - "Off track at two consecutive reviews": the item's health at this review's close and at the
 *   previous review that saw it, each recorded as an `action_item.reviewed` event.
 * - "Quarter end": the end of a calendar quarter in the workspace time zone, passed after the
 *   item reached E3.
 * - The thresholds are the item's workstream's Q-T08 answers (01 §8), the defaults until they are
 *   stored (P1-12).
 *
 * Health rule 2 of 03 §7 (`off_track` past due, `at_risk` on a failed step or a long wait) is
 * applied by the same job first, so the levels read the health it sets.
 */
import {
  applyEscalationHealth,
  escalateItem,
  HEALTH_SEVERITY,
  raiseIssue,
  WORKING,
  type Caller,
  type Change,
  type DomainContext,
} from '@cc/domain';
import type {
  ActionItem,
  DomainEvent,
  Goal,
  Health,
  Issue,
  MeetingInstance,
  MeetingSeries,
  TailoringAnswers,
} from '@cc/schemas';

import { isReviewSeries } from './carry.js';
import {
  addDays,
  compareInstants,
  instant,
  localDate,
  startOfDay,
  wallClockInstantCompatible,
} from './time.js';

export const ESCALATION_CALLER: Caller = { actor: { kind: 'system', component: 'escalation' } };

export type EscalationThresholds = TailoringAnswers['escalation'];

/** The Q-T08 defaults (01 §8). */
export const DEFAULT_ESCALATION_THRESHOLDS: EscalationThresholds = {
  e2CarryCount: 2,
  e3CarryCount: 4,
  e3OverdueDays: 30,
};

export type EscalationLevel = ActionItem['escalationLevel'];

/** What the job knows about an item from its event history (`itemHistory`). */
export interface ItemHistory {
  /** Carries since the item's last re-plan; `carryCount` when it was never re-planned. */
  readonly carriesSinceReplan?: number;
  /** The item's health at the previous review that saw it, since its last re-plan. */
  readonly previousReviewHealth?: Health;
  /** When the item first reached E3 or above. */
  readonly e3Since?: string;
  /** The local date (workspace zone) of the item's last escalation notification. */
  readonly notifiedOn?: string;
}

/**
 * Reads an item's `ItemHistory` from its events, oldest first, as the store's `history` returns
 * them. Times come from the events' own fields (`escalatedAt`), not the store's event time.
 */
export function itemHistory(events: readonly DomainEvent[]): ItemHistory {
  let carries = 0;
  let previousReviewHealth: Health | undefined;
  let e3Since: string | undefined;
  let notifiedOn: string | undefined;
  for (const event of events) {
    const after = (event.after ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'action_item.replanned':
        carries = 0;
        previousReviewHealth = undefined;
        e3Since = undefined;
        break;
      case 'action_item.carried':
        carries += 1;
        break;
      case 'action_item.reviewed':
        previousReviewHealth = after['health'] as Health;
        break;
      case 'action_item.escalated': {
        const level = after['escalationLevel'];
        if (e3Since === undefined && typeof level === 'number' && level >= 3) {
          e3Since = after['escalatedAt'] as string;
        }
        if (typeof after['notifiedOn'] === 'string') notifiedOn = after['notifiedOn'];
        break;
      }
      default:
        break;
    }
  }
  return {
    carriesSinceReplan: carries,
    ...(previousReviewHealth === undefined ? {} : { previousReviewHealth }),
    ...(e3Since === undefined ? {} : { e3Since }),
    ...(notifiedOn === undefined ? {} : { notifiedOn }),
  };
}

/**
 * The instant from which an item is overdue (ADR 0001 decision 7): 00:00 of the day after a
 * date-only due date, in the item's zone; an explicit due time itself (`compatible`).
 */
export function overdueFrom(due: ActionItem['due']): string {
  return due.time === undefined
    ? startOfDay(addDays(due.date, 1), due.timeZone)
    : wallClockInstantCompatible(`${due.date}T${due.time}`, due.timeZone);
}

/** The start of the calendar quarter holding `now`, in a zone, as a UTC timestamp. */
export function quarterStart(now: string, timeZone: string): string {
  const date = localDate(now, timeZone);
  const month = Number(date.slice(5, 7));
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return startOfDay(`${date.slice(0, 4)}-${String(first).padStart(2, '0')}-01`, timeZone);
}

/** One trigger of the ladder that holds for an item, as the escalation event names it. */
export type EscalationTrigger =
  | 'overdue'
  | 'at_risk'
  | 'carried'
  | 'off_track_at_two_reviews'
  | 'overdue_long'
  | 'goal_off_track'
  | 'quarter_end';

export interface LadderFacts {
  readonly now: string;
  readonly workspaceTimeZone: string;
  readonly thresholds: EscalationThresholds;
  /** Carries counted since the last re-plan, this review's included. */
  readonly carries: number;
  /** Off track at this review and at the previous one that saw the item. */
  readonly offTrackAtTwoReviews: boolean;
  /** The active priorities and WIGs the item links to. */
  readonly goals: readonly Pick<Goal, 'id' | 'kind' | 'status' | 'health'>[];
  readonly e3Since?: string;
}

/** The level the ladder's triggers put an item at, and the triggers that hold (02 §7.2). */
export function ladderLevel(
  item: Pick<ActionItem, 'due' | 'health' | 'escalationLevel' | 'links'>,
  facts: LadderFacts,
): { level: EscalationLevel; triggers: EscalationTrigger[] } {
  const triggers: EscalationTrigger[] = [];
  let level: EscalationLevel = 0;
  const raise = (to: EscalationLevel, trigger: EscalationTrigger) => {
    triggers.push(trigger);
    if (to > level) level = to;
  };
  const late = instant(overdueFrom(item.due)).until(instant(facts.now)).total('days');
  if (late >= 0) raise(1, 'overdue');
  if (HEALTH_SEVERITY[item.health] >= HEALTH_SEVERITY.at_risk) raise(1, 'at_risk');
  if (facts.carries >= facts.thresholds.e3CarryCount) raise(3, 'carried');
  else if (facts.carries >= facts.thresholds.e2CarryCount) raise(2, 'carried');
  if (facts.offTrackAtTwoReviews) raise(2, 'off_track_at_two_reviews');
  if (late > facts.thresholds.e3OverdueDays) raise(3, 'overdue_long');
  const offTrackGoal = facts.goals.some(
    (goal) =>
      item.links.goalIds.includes(goal.id) &&
      (goal.kind === 'priority' || goal.kind === 'wig') &&
      goal.status === 'active' &&
      goal.health === 'off_track',
  );
  if (offTrackGoal) raise(3, 'goal_off_track');
  const atE3 = Math.max(level, item.escalationLevel) >= 3;
  const since = facts.e3Since;
  if (
    atE3 &&
    since !== undefined &&
    compareInstants(since, quarterStart(facts.now, facts.workspaceTimeZone)) < 0
  ) {
    raise(4, 'quarter_end');
  }
  return { level, triggers };
}

/** The E2 issue's title: the item, why it escalated, and what the issues section must do. */
export function escalationIssueTitle(item: Pick<ActionItem, 'ref' | 'title'>): string {
  return `${item.ref} ${item.title}: escalated (E2). Re-plan it with a new date and reason, re-scope it, change the owner or executor, or drop it with a reason.`;
}

/** An E0 reminder for the next daily start (02 §7.2). */
export interface EscalationReminder {
  readonly ref: string;
  readonly ownerId: string;
  readonly due: string;
}

/** A nudge draft for an owner who is not the user; nothing is sent (sending needs a confirmation). */
export interface NudgeDraft {
  readonly ref: string;
  readonly to: string;
  readonly text: string;
}

/** An item's health as a review saw it, for the next review's "two consecutive" check. */
export interface ReviewSighting {
  readonly itemId: string;
  readonly ref: string;
  readonly meetingId: string;
  readonly health: Health;
}

export interface EscalationResult {
  readonly status: 'ok' | 'no-op';
  readonly changes: readonly Change[];
  /** Every item given, with the changed ones updated. */
  readonly items: readonly ActionItem[];
  /** Level changes, by item ref. */
  readonly escalated: readonly {
    readonly ref: string;
    readonly from: EscalationLevel;
    readonly to: EscalationLevel;
    readonly triggers: readonly EscalationTrigger[];
  }[];
  /** E2 issues raised by this run. */
  readonly issues: readonly Issue[];
  readonly reminders: readonly EscalationReminder[];
  readonly nudgeDrafts: readonly NudgeDraft[];
  /** Items to push a notification for: E1 and above, at most once per item per day (rule 3). */
  readonly notify: readonly string[];
  /** The health each item had at the review that closed; empty for the nightly run. */
  readonly reviewed: readonly ReviewSighting[];
}

export interface EscalationInput {
  readonly items: readonly ActionItem[];
  readonly goals: readonly Goal[];
  /** Open issues, so an item's E2 issue is raised once. */
  readonly issues: readonly Issue[];
  readonly workspaceTimeZone: string;
  /** The review that closed, when the job runs at close (02 §4.7); absent for the nightly run. */
  readonly review?: {
    readonly series: Pick<MeetingSeries, 'cadence' | 'workstreamIds'>;
    readonly instance: Pick<MeetingInstance, 'id'>;
    /** IDs of the items this close carried; their carry is in `carryCount`, not yet in the history. */
    readonly carried: readonly string[];
  };
  /** Each item's history (`itemHistory`); nothing known by default. */
  readonly history?: (item: ActionItem) => ItemHistory;
  /** Q-T08 per workstream; the defaults otherwise. */
  readonly thresholds?: (workstreamId: string) => EscalationThresholds;
}

/** The escalation job (02 §7.2 rule 1): at a review's close and nightly. */
export function runEscalation(
  ctx: DomainContext,
  caller: Caller,
  input: EscalationInput,
): EscalationResult {
  const now = ctx.clock.now();
  const today = localDate(now, input.workspaceTimeZone);
  const self = ctx.registry.selfPersonId;
  const changes: Change[] = [];
  const escalated: EscalationResult['escalated'][number][] = [];
  const issues: Issue[] = [];
  const reminders: EscalationReminder[] = [];
  const nudgeDrafts: NudgeDraft[] = [];
  const notify: string[] = [];
  const reviewed: ReviewSighting[] = [];
  const review = input.review;
  const carriedNow = new Set(review?.carried ?? []);

  const items = input.items.map((original) => {
    if (!WORKING.has(original.lifecycle)) return original;
    let item = original;
    const health = applyEscalationHealth(ctx, caller, item);
    changes.push(...health.changes);
    item = health.record;

    const history = input.history?.(original) ?? {};
    const inReview =
      review !== undefined &&
      isReviewSeries(review.series) &&
      review.series.workstreamIds.includes(item.workstreamId);
    if (inReview) {
      reviewed.push({
        itemId: item.id,
        ref: item.ref,
        meetingId: review.instance.id,
        health: item.health,
      });
    }
    // The history was read before this close's carry; `carryCount` already holds it.
    const carries =
      history.carriesSinceReplan === undefined
        ? original.carryCount
        : history.carriesSinceReplan + (carriedNow.has(item.id) ? 1 : 0);
    const { level, triggers } = ladderLevel(item, {
      now,
      workspaceTimeZone: input.workspaceTimeZone,
      thresholds: input.thresholds?.(item.workstreamId) ?? DEFAULT_ESCALATION_THRESHOLDS,
      carries,
      offTrackAtTwoReviews:
        inReview && item.health === 'off_track' && history.previousReviewHealth === 'off_track',
      goals: input.goals,
      ...(history.e3Since === undefined ? {} : { e3Since: history.e3Since }),
    });

    const late = compareInstants(now, overdueFrom(item.due)) >= 0;
    if (
      !late &&
      instant(now)
        .until(instant(overdueFrom(item.due)))
        .total('days') <= 1
    ) {
      reminders.push({ ref: item.ref, ownerId: item.ownerId, due: item.due.date });
      if (item.ownerId !== self) {
        nudgeDrafts.push({
          ref: item.ref,
          to: item.ownerId,
          text: `A reminder that ${item.ref} "${item.title}" is due on ${item.due.date}.`,
        });
      }
    }

    if (level <= item.escalationLevel) return item;
    const from = item.escalationLevel;
    let links: ActionItem['links'] | undefined;
    const hasIssue = input.issues.some(
      (issue) =>
        issue.status === 'open' &&
        issue.raisedFrom.kind === 'escalation' &&
        issue.raisedFrom.actionItemId === item.id,
    );
    if (level >= 2 && from < 2 && !hasIssue) {
      const raised = raiseIssue(
        ctx,
        caller,
        {
          workstreamId: item.workstreamId,
          title: escalationIssueTitle(item),
          raisedFrom: { kind: 'escalation', actionItemId: item.id, level: 2 },
        },
        review?.instance.id,
      );
      changes.push(...raised.changes);
      issues.push(raised.record);
      links = { ...item.links, issueIds: [...item.links.issueIds, raised.record.id] };
    }
    const push = history.notifiedOn !== today;
    if (push) notify.push(item.ref);
    const outcome = escalateItem(ctx, caller, item, level, {
      ...(links === undefined ? {} : { links }),
      extra: { triggers, escalatedAt: now, ...(push ? { notifiedOn: today } : {}) },
    });
    changes.push(...outcome.changes);
    escalated.push({ ref: item.ref, from, to: level, triggers });
    return outcome.record;
  });

  return {
    status: changes.length === 0 ? 'no-op' : 'ok',
    changes,
    items,
    escalated,
    issues,
    reminders,
    nudgeDrafts,
    notify,
    reviewed,
  };
}
