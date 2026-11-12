/**
 * Conclude and close (02 §6.4, §4.7).
 *
 * 1. Read-back. The conclude section lists every new action item and decision: owner,
 *    deliverable, due and done-means. The user presses "Read back done" in the app
 *    (`readBackConfirmedAt`); it is human-only (04 §4.3, `meetings.confirm`). Confirming accepts
 *    every draft whose owner is present (solo mode: the user), turning it `open`; a draft for an
 *    absent owner stays `draft` unless the user records that owner's acceptance with a note
 *    (02 §6.3, the external person case).
 * 2. Inform. For each item closed in this meeting with an inform list, a "tell when done" draft
 *    is prepared; nothing is sent (sending goes through the Policy Engine and a connector, P2).
 * 3. Close: C-02-04, then `in_progress → completed`, then the carry counts (02 §7.1, carry.ts)
 *    and the escalation job (02 §7.2, escalation.ts), all in one transaction (02 §4.7).
 */
import {
  acceptItem,
  type Caller,
  type Change,
  type DomainContext,
  forbidden,
  humanRequired,
  invariantError,
  isUser,
  type Outcome,
  touched,
} from '@cc/domain';
import type {
  ActionItem,
  AgendaSectionInstance,
  Decision,
  Goal,
  Issue,
  MeetingInstance,
  MeetingSeries,
} from '@cc/schemas';

import { findSection, type SectionKey, sameSection } from './capture.js';
import { carryForward } from './carry.js';
import { RHYTHM_CALLER } from './engine.js';
import {
  ESCALATION_CALLER,
  runEscalation,
  type EscalationInput,
  type EscalationResult,
} from './escalation.js';
import { completeMeeting, instanceChange } from './state.js';

/** The deep link that opens a meeting in the app (04 §4.3 rule 3). */
export function meetingLink(instance: Pick<MeetingInstance, 'ref'>): string {
  return `commandcenter://meeting/${instance.ref}`;
}

export interface ReadBackLine {
  readonly kind: 'action_item' | 'decision';
  readonly ref: string;
  /** The owner of an item, the decider of a decision. */
  readonly ownerId: string;
  readonly ownerPresent: boolean;
  /** The item's title or the decision's question. */
  readonly deliverable: string;
  readonly due?: string;
  readonly doneMeans?: string;
  /** Lifecycle of an item, status of a decision. */
  readonly state: string;
}

function requireInProgress(instance: MeetingInstance, what: string): void {
  if (instance.state !== 'in_progress') {
    throw invariantError({
      rule: '02 §6.4',
      message: `${instance.ref} is ${instance.state}; ${what} needs a meeting in progress`,
    });
  }
}

/** Whether the owner is at the meeting: an attendee, or the user (solo mode). */
export function ownerPresent(
  series: Pick<MeetingSeries, 'attendeeIds' | 'chairId'>,
  selfPersonId: string,
  ownerId: string,
): boolean {
  return ownerId === selfPersonId || series.attendeeIds.some((id) => id === ownerId);
}

function newRecords(
  instance: MeetingInstance,
  items: readonly ActionItem[],
  decisions: readonly Decision[],
): { items: ActionItem[]; decisions: Decision[] } {
  const itemIds = new Set<string>(instance.outputs.actionItemIds);
  const decisionIds = new Set<string>(instance.outputs.decisionIds);
  const found = {
    items: items.filter((item) => itemIds.has(item.id)),
    decisions: decisions.filter((decision) => decisionIds.has(decision.id)),
  };
  const missing = [
    ...[...itemIds].filter((id) => !found.items.some((item) => item.id === id)),
    ...[...decisionIds].filter((id) => !found.decisions.some((d) => d.id === id)),
  ];
  if (missing.length > 0) {
    throw invariantError({
      rule: '02 §6.4',
      message: `${instance.ref}: the read-back needs every new record; missing ${missing.join(', ')}`,
    });
  }
  return found;
}

/** The conclude section's list: every new action item and decision (02 §6.4 rule 1). */
export function readBackList(input: {
  readonly series: MeetingSeries;
  readonly instance: MeetingInstance;
  readonly selfPersonId: string;
  readonly items: readonly ActionItem[];
  readonly decisions: readonly Decision[];
}): ReadBackLine[] {
  const { items, decisions } = newRecords(input.instance, input.items, input.decisions);
  return [
    ...items.map((item): ReadBackLine => ({
      kind: 'action_item',
      ref: item.ref,
      ownerId: item.ownerId,
      ownerPresent: ownerPresent(input.series, input.selfPersonId, item.ownerId),
      deliverable: item.title,
      due: item.due.date,
      doneMeans: item.doneMeans,
      state: item.lifecycle,
    })),
    ...decisions.map((decision): ReadBackLine => ({
      kind: 'decision',
      ref: decision.ref,
      ownerId: decision.deciderId,
      ownerPresent: ownerPresent(input.series, input.selfPersonId, decision.deciderId),
      deliverable: decision.question,
      ...(decision.dueBy === undefined ? {} : { due: decision.dueBy }),
      state: decision.status,
    })),
  ].sort((a, b) => a.ref.localeCompare(b.ref));
}

export interface ReadBackOutcome extends Outcome<MeetingInstance> {
  /** Drafts accepted by this read-back. */
  readonly accepted: readonly string[];
  /** Drafts left for an absent owner to accept. */
  readonly pending: readonly string[];
}

/**
 * "Read back done" (02 §6.4 rule 1): human-only. Accepts every draft whose owner is present, and
 * the drafts of absent owners whose acceptance the user records with a note.
 */
export function confirmReadBack(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly series: MeetingSeries;
    readonly instance: MeetingInstance;
    readonly items: readonly ActionItem[];
    readonly decisions: readonly Decision[];
    /** Acceptance recorded by the user for an absent or external owner, by item ref. */
    readonly acceptances?: readonly { readonly ref: string; readonly note: string }[];
  },
): ReadBackOutcome {
  const { instance, series } = input;
  if (!isUser(caller)) throw humanRequired('Confirming meeting read-back', meetingLink(instance));
  requireInProgress(instance, 'read-back');
  const { items } = newRecords(instance, input.items, input.decisions);
  const self = ctx.registry.selfPersonId;
  const changes: Change[] = [];
  const accepted: string[] = [];
  const pending: string[] = [];
  for (const item of items) {
    if (item.lifecycle !== 'draft') continue;
    const acceptance = input.acceptances?.find((a) => a.ref === item.ref);
    if (ownerPresent(series, self, item.ownerId)) {
      changes.push(...acceptItem(ctx, caller, item).changes);
      accepted.push(item.ref);
    } else if (acceptance !== undefined && acceptance.note.trim() !== '') {
      changes.push(...acceptItem(ctx, caller, item, acceptance.note).changes);
      accepted.push(item.ref);
    } else {
      pending.push(item.ref);
    }
  }
  const next: MeetingInstance = {
    ...touched(ctx, instance, caller.actor),
    readBackConfirmedAt: ctx.clock.now(),
  };
  changes.push(
    instanceChange(ctx, caller, instance, next, 'read_back_confirmed', { accepted, pending }),
  );
  return { status: 'ok', record: next, changes, accepted, pending };
}

/** A "tell when done" draft (02 §6.4 rule 2). Nothing is sent from here. */
export interface InformDraft {
  readonly ref: string;
  readonly to: readonly string[];
  readonly text: string;
}

/** The inform drafts for items closed in this meeting (verified or dropped here). */
export function informDrafts(
  instance: MeetingInstance,
  items: readonly ActionItem[],
): InformDraft[] {
  const closedHere = new Set<string>([
    ...instance.outputs.verifications
      .filter((v) => v.result !== 'rejected')
      .map((v) => v.actionItemId as string),
  ]);
  const droppedRefs = new Set(
    instance.outputs.statusUpdates
      .filter((u) => u.field === 'lifecycle' && u.to === 'dropped')
      .map((u) => u.ref),
  );
  return items
    .filter((item) => closedHere.has(item.id) || droppedRefs.has(item.ref))
    .filter((item) => item.informIds.length > 0)
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((item) => ({
      ref: item.ref,
      to: [...item.informIds],
      text:
        item.lifecycle === 'dropped'
          ? `${item.ref} ${item.title} was dropped: ${item.dropReason ?? ''}`.trim()
          : `${item.ref} ${item.title} is done: ${item.doneMeans}`,
    }));
}

export interface CloseOutcome extends Outcome<MeetingInstance> {
  readonly informDrafts: readonly InformDraft[];
  /** Refs of the items this review carried (02 §7.1); empty without `review`. */
  readonly carried: readonly string[];
  /** The escalation job's run at this close (02 §7.2); absent without `review`. */
  readonly escalation?: EscalationResult;
}

/** What the close's carry and escalation steps read (02 §4.7 "close"). */
export interface CloseReview {
  readonly series: MeetingSeries;
  /** Every action item of the workspace, as the close reads them. */
  readonly items: readonly ActionItem[];
  readonly goals: readonly Goal[];
  /** Open issues, so an item's E2 issue is raised once. */
  readonly issues: readonly Issue[];
  readonly workspaceTimeZone: string;
  /** Items this instance already carried (C-02-05). */
  readonly counted?: (itemId: string) => boolean;
  readonly history?: EscalationInput['history'];
  readonly thresholds?: EscalationInput['thresholds'];
}

/**
 * C-02-04: every new action item has an owner, a due date and a done-means, every new decision
 * has a decider, and read-back is confirmed.
 */
export function closeProblems(input: {
  readonly instance: MeetingInstance;
  readonly items: readonly ActionItem[];
  readonly decisions: readonly Decision[];
  readonly isPerson: (id: string) => boolean;
}): string[] {
  const { items, decisions } = newRecords(input.instance, input.items, input.decisions);
  const problems: string[] = [];
  for (const item of items) {
    if (item.lifecycle === 'dropped') continue;
    const missing = [
      ...(input.isPerson(item.ownerId) ? [] : ['an owner']),
      ...(item.due.date.trim() === '' ? ['a due date'] : []),
      ...(item.doneMeans.trim() === '' ? ['a done-means'] : []),
    ];
    if (missing.length > 0) problems.push(`${item.ref} needs ${missing.join(', ')}`);
  }
  for (const decision of decisions) {
    if (!input.isPerson(decision.deciderId)) problems.push(`${decision.ref} needs a decider`);
  }
  if (input.instance.readBackConfirmedAt === undefined) {
    problems.push('read-back is not confirmed');
  }
  return problems;
}

/**
 * Close (02 §6.4 rule 3): the user only, after C-02-04 holds. With `review`, the same
 * transaction carries the items this review counts (02 §7.1, actor `system:rhythm`) and runs
 * the escalation job (02 §7.2, actor `system:escalation`) over the result (02 §4.7).
 */
export function closeMeeting(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly instance: MeetingInstance;
    /** The new items and decisions, and the items verified or dropped in the meeting. */
    readonly items: readonly ActionItem[];
    readonly decisions: readonly Decision[];
    readonly review?: CloseReview;
  },
): CloseOutcome {
  const { instance, review } = input;
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user concludes a meeting');
  requireInProgress(instance, 'close');
  const problems = closeProblems({
    ...input,
    isPerson: (id) => ctx.registry.person(id as ActionItem['ownerId']) !== undefined,
  });
  const [first, ...rest] = problems;
  if (first !== undefined) {
    throw invariantError({ rule: 'C-02-04', message: `${instance.ref} cannot close: ${first}` }, [
      ...rest,
      meetingLink(instance),
    ]);
  }
  const outcome = completeMeeting(ctx, caller, instance);
  const informs = informDrafts(instance, input.items);
  if (review === undefined) return { ...outcome, informDrafts: informs, carried: [] };
  const carry = carryForward(ctx, RHYTHM_CALLER, {
    series: review.series,
    instance: outcome.record,
    items: review.items,
    ...(review.counted === undefined ? {} : { counted: review.counted }),
  });
  const carriedIds = carry.items
    .filter((item, index) => item !== review.items[index])
    .map((item) => item.id);
  const escalation = runEscalation(ctx, ESCALATION_CALLER, {
    items: carry.items,
    goals: review.goals,
    issues: review.issues,
    workspaceTimeZone: review.workspaceTimeZone,
    review: { series: review.series, instance: outcome.record, carried: carriedIds },
    ...(review.history === undefined ? {} : { history: review.history }),
    ...(review.thresholds === undefined ? {} : { thresholds: review.thresholds }),
  });
  return {
    ...outcome,
    changes: [...outcome.changes, ...carry.changes, ...escalation.changes],
    informDrafts: informs,
    carried: carry.carried,
    escalation,
  };
}

/** Marks a section done or skipped while the meeting runs. The user only. */
export function setSectionStatus(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
  key: SectionKey,
  status: AgendaSectionInstance['status'],
): Outcome<MeetingInstance> {
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user runs the agenda');
  requireInProgress(instance, 'working the agenda');
  const row = findSection(instance, key);
  if (row.status === status) return { status: 'no-op', record: instance, changes: [] };
  const next: MeetingInstance = {
    ...touched(ctx, instance, caller.actor),
    agenda: instance.agenda.map((r) => (sameSection(r, key) ? { ...r, status } : r)),
  };
  const write = instanceChange(ctx, caller, instance, next, 'section_' + status, {
    sectionId: key.sectionId,
  });
  return { status: 'ok', record: next, changes: [write] };
}

/** The optional 1-10 rating at conclude. The user only. */
export function rateMeeting(
  ctx: DomainContext,
  caller: Caller,
  instance: MeetingInstance,
  rating: number,
): Outcome<MeetingInstance> {
  if (!isUser(caller)) throw forbidden('02 §4.2', 'only the user rates a meeting');
  requireInProgress(instance, 'a rating');
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    throw invariantError({ rule: '02 §6.4', message: 'a rating is a whole number from 1 to 10' });
  }
  if (instance.rating === rating) return { status: 'no-op', record: instance, changes: [] };
  const next: MeetingInstance = { ...touched(ctx, instance, caller.actor), rating };
  return {
    status: 'ok',
    record: next,
    changes: [instanceChange(ctx, caller, instance, next, 'rated')],
  };
}
