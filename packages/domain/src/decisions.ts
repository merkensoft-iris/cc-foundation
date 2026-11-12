/**
 * Decisions, docs/design/03-decisions-and-action-items.md §10.
 *
 * 1. `proposed` (agent or user drafted) → `open` (accepted onto the agenda, decider set) →
 *    `decided` → optionally `superseded` (by a later decision) or `reversed`. `dropped` needs
 *    a reason.
 * 2. Only the decider (a person) moves `open → decided`; in solo mode, the user.
 * 3. One-way doors need a memo, or a waiver note (see `oneWayDoorViolations`).
 * 4. Deciding creates the action items listed in the outcome in the same transaction, each
 *    with `source = { kind: 'decision' }`.
 * 5. `reviewOn` creates a `follow_up` item for the decider, due on that date (a trigger needs
 *    an ingest rule, which comes with connectors in P2).
 */
import type { ActionItem, Decision, ItemSource } from '@cc/schemas';

import { type Caller, type DomainContext, hasScope, isSystem, isUser } from './context.js';
import {
  assertNoViolations,
  DomainError,
  forbidden,
  humanRequired,
  invariantError,
  type Violation,
} from './errors.js';
import { type Change, change, created, type Outcome, touched } from './events.js';
import { checkDecision } from './invariants.js';
import { createActionItem, type NewActionItem } from './items.js';
import type { PersonId, WorkstreamId } from './types.js';

function decisionLink(decision: Decision): string {
  return `commandcenter://decisions/${decision.ref}`;
}

function writeDecision(
  ctx: DomainContext,
  caller: Caller,
  previous: Decision | undefined,
  next: Decision,
  verb: string,
  extra?: Record<string, unknown>,
): Change<Decision> {
  assertNoViolations(checkDecision(next, ctx.registry));
  const record = previous === undefined ? next : touched(ctx, next, caller.actor);
  return change(ctx, {
    kind: 'decision',
    verb,
    entity: { id: record.id, ref: record.ref },
    before: previous,
    after: record,
    actor: caller.actor,
    ...(extra === undefined ? {} : { extra }),
  });
}

function requireStatus(decision: Decision, operation: string, allowed: Decision['status'][]): void {
  if (!allowed.includes(decision.status)) {
    throw invariantError({
      rule: '03 §10',
      message: `${operation} is not allowed from ${decision.status} (allowed from ${allowed.join(', ')})`,
    });
  }
}

export interface NewDecision {
  readonly workstreamId: WorkstreamId;
  readonly question: string;
  readonly options?: readonly string[];
  /** Default: the workspace's self person (solo mode). */
  readonly deciderId?: PersonId;
  readonly driverId?: PersonId;
  readonly inputFromIds?: readonly PersonId[];
  readonly informIds?: readonly PersonId[];
  readonly reversibility?: Decision['reversibility'];
  readonly dueBy?: string;
  readonly reviewOn?: Decision['reviewOn'];
  readonly supersedesId?: Decision['id'];
  /** The one-way-door memo in the blob store (03 §10 rule 3). */
  readonly memoSha256?: Decision['memoSha256'];
  readonly source?: ItemSource;
}

/** Propose a decision (`[*] → proposed`). The user, or an agent with `decisions:propose`. */
export function proposeDecision(
  ctx: DomainContext,
  caller: Caller,
  input: NewDecision,
): Outcome<Decision> {
  if (!isUser(caller) && !hasScope(caller, 'decisions:propose')) {
    throw forbidden('03 §10', 'proposing decisions needs the decisions:propose scope');
  }
  if (ctx.registry.workstream(input.workstreamId) === undefined) {
    throw new DomainError('E_NOT_FOUND', '03 §10', `workstream ${input.workstreamId} not found`);
  }
  const decision: Decision = {
    id: ctx.ids.id('dec'),
    ref: ctx.ids.ref('D'),
    workstreamId: input.workstreamId,
    question: input.question,
    deciderId: input.deciderId ?? ctx.registry.selfPersonId,
    ...(input.driverId === undefined ? {} : { driverId: input.driverId }),
    inputFromIds: [...(input.inputFromIds ?? [])],
    informIds: [...(input.informIds ?? [])],
    reversibility: input.reversibility ?? 'two_way',
    ...(input.dueBy === undefined ? {} : { dueBy: input.dueBy }),
    options: (input.options ?? []).map((text, index) => ({
      id: `o${index + 1}`,
      text,
      proposedBy: caller.actor,
    })),
    actionItemIds: [],
    ...(input.reviewOn === undefined ? {} : { reviewOn: input.reviewOn }),
    ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
    ...(input.memoSha256 === undefined ? {} : { memoSha256: input.memoSha256 }),
    source: input.source ?? { kind: 'manual' },
    status: 'proposed',
    ...created(ctx, caller.actor),
  };
  const write = writeDecision(ctx, caller, undefined, decision, 'proposed');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Add an option or a recommendation (agents may recommend, never decide: INV-03-02). The
 * user or an agent with `decisions:propose`, while the decision is proposed or open.
 */
export function adviseDecision(
  ctx: DomainContext,
  caller: Caller,
  decision: Decision,
  advice: { option?: string; recommendation?: { optionId: string; rationale: string } },
): Outcome<Decision> {
  if (!isUser(caller) && !hasScope(caller, 'decisions:propose')) {
    throw forbidden('03 §10', 'advising on decisions needs the decisions:propose scope');
  }
  requireStatus(decision, 'advise', ['proposed', 'open']);
  const options =
    advice.option === undefined
      ? decision.options
      : [
          ...decision.options,
          { id: `o${decision.options.length + 1}`, text: advice.option, proposedBy: caller.actor },
        ];
  const recommendation = advice.recommendation;
  if (recommendation !== undefined && !options.some((o) => o.id === recommendation.optionId)) {
    throw invariantError({
      rule: '03 §10',
      message: `${decision.ref} has no option ${recommendation.optionId}`,
    });
  }
  const next: Decision = {
    ...decision,
    options,
    ...(recommendation === undefined
      ? {}
      : { recommendation: { ...recommendation, by: caller.actor } }),
  };
  const write = writeDecision(ctx, caller, decision, next, 'advised');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Open (`proposed → open`): accepted onto the agenda with its decider set. The user, or the
 * system when a meeting puts it on the agenda.
 */
export function openDecision(
  ctx: DomainContext,
  caller: Caller,
  decision: Decision,
  deciderId?: PersonId,
): Outcome<Decision> {
  if (!isUser(caller) && !isSystem(caller)) {
    throw forbidden('03 §10', 'only the user or the system opens a decision');
  }
  requireStatus(decision, 'open', ['proposed']);
  const next: Decision = {
    ...decision,
    status: 'open',
    ...(deciderId === undefined ? {} : { deciderId }),
  };
  const write = writeDecision(ctx, caller, decision, next, 'opened');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Rule 3: a one-way door needs a memo, unless memos for one-way doors are switched off
 * (`decision.memoForOneWayDoors`), in which case a waiver note stands in for it.
 */
export function oneWayDoorViolations(
  decision: Decision,
  settings: { memoForOneWayDoors: boolean },
  waiverNote: string | undefined,
): Violation[] {
  if (decision.reversibility !== 'one_way' || decision.memoSha256 !== undefined) return [];
  if (!settings.memoForOneWayDoors && waiverNote !== undefined && waiverNote.trim() !== '') {
    return [];
  }
  return [
    {
      rule: '03 §10',
      message: settings.memoForOneWayDoors
        ? 'a one-way door needs a memo'
        : 'a one-way door needs a memo or a waiver note',
    },
  ];
}

export interface DecideInput {
  readonly optionId?: string;
  readonly text: string;
  readonly why: string;
  readonly resourcesCommitted?: string;
  /** The action items the outcome lists; created open, with source decision (rule 4). */
  readonly actionItems?: readonly Omit<NewActionItem, 'source' | 'lifecycle' | 'workstreamId'>[];
  /** Framework parameter `decision.memoForOneWayDoors` (01 §5.2), default true. */
  readonly memoForOneWayDoors?: boolean;
  readonly waiverNote?: string;
  /** The decision this one supersedes (its `supersedesId`), marked superseded. */
  readonly superseded?: Decision;
}

/**
 * Decide (`open → decided`). Human-only (04 §4.3, INV-03-07): only the user, for the decider.
 * Creates the outcome's action items and the `reviewOn` follow-up in the same transaction, and
 * marks a superseded decision.
 */
export function decide(
  ctx: DomainContext,
  caller: Caller,
  decision: Decision,
  input: DecideInput,
): Outcome<Decision> {
  if (!isUser(caller)) throw humanRequired('Deciding a decision', decisionLink(decision));
  requireStatus(decision, 'decide', ['open']);
  if (input.optionId !== undefined && !decision.options.some((o) => o.id === input.optionId)) {
    throw invariantError({
      rule: '03 §10',
      message: `${decision.ref} has no option ${input.optionId}`,
    });
  }
  assertNoViolations(
    oneWayDoorViolations(
      decision,
      { memoForOneWayDoors: input.memoForOneWayDoors ?? true },
      input.waiverNote,
    ),
  );
  const source: ItemSource = { kind: 'decision', decisionId: decision.id };
  const items: Change[] = [];
  const created_: ActionItem[] = [];
  for (const item of input.actionItems ?? []) {
    const outcome = createActionItem(ctx, caller, {
      ...item,
      workstreamId: decision.workstreamId,
      source,
      lifecycle: 'open',
      links: { ...item.links, decisionIds: [...(item.links?.decisionIds ?? []), decision.id] },
      correlationId: decision.id,
    });
    created_.push(outcome.record);
    items.push(...outcome.changes);
  }
  const reviewDate = decision.reviewOn?.date;
  if (reviewDate !== undefined) {
    const workstream = ctx.registry.workstream(decision.workstreamId);
    const outcome = createActionItem(ctx, caller, {
      workstreamId: decision.workstreamId,
      kind: 'follow_up',
      title: `Review decision ${decision.ref}`.slice(0, 120),
      doneMeans: `The outcome of ${decision.ref} is reviewed: kept, superseded or reversed, and the review is recorded.`,
      evidenceRequirements: [
        {
          id: 'er1',
          description: `Review of ${decision.ref} recorded`,
          required: true,
          acceptedKinds: ['note', 'meeting_record'],
        },
      ],
      ownerId: decision.deciderId,
      due: { date: reviewDate, timeZone: workstream?.timeZone ?? 'UTC' },
      source,
      links: { decisionIds: [decision.id] },
      lifecycle: 'open',
      correlationId: decision.id,
    });
    created_.push(outcome.record);
    items.push(...outcome.changes);
  }
  const next: Decision = {
    ...decision,
    status: 'decided',
    outcome: {
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      text: input.text,
      why: input.why,
      decidedAt: ctx.clock.now(),
      ...(input.resourcesCommitted === undefined
        ? {}
        : { resourcesCommitted: input.resourcesCommitted }),
    },
    actionItemIds: [...decision.actionItemIds, ...created_.map((item) => item.id)],
  };
  const extra = input.waiverNote === undefined ? undefined : { waiverNote: input.waiverNote };
  const write = writeDecision(ctx, caller, decision, next, 'decided', extra);
  const superseded: Change[] = [];
  if (input.superseded !== undefined) {
    if (decision.supersedesId !== input.superseded.id) {
      throw invariantError({
        rule: '03 §10',
        message: `${decision.ref} does not supersede ${input.superseded.ref}`,
      });
    }
    requireStatus(input.superseded, 'supersede', ['decided']);
    superseded.push(
      writeDecision(
        ctx,
        caller,
        input.superseded,
        { ...input.superseded, status: 'superseded' },
        'superseded',
        {
          by: decision.id,
        },
      ),
    );
  }
  return { status: 'ok', record: write.record, changes: [write, ...items, ...superseded] };
}

/** Reverse (`decided → reversed`). The user only, with a reason in the event. */
export function reverseDecision(
  ctx: DomainContext,
  caller: Caller,
  decision: Decision,
  reason: string,
): Outcome<Decision> {
  if (!isUser(caller)) throw humanRequired('Reversing a decision', decisionLink(decision));
  requireStatus(decision, 'reverse', ['decided']);
  if (reason.trim() === '') {
    throw invariantError({ rule: '03 §10', message: 'reversing a decision needs a reason' });
  }
  const write = writeDecision(
    ctx,
    caller,
    decision,
    { ...decision, status: 'reversed' },
    'reversed',
    {
      reason,
    },
  );
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Drop (`proposed | open → dropped`) with a reason. The user; or the agent that proposed it,
 * while it is still only proposed.
 */
export function dropDecision(
  ctx: DomainContext,
  caller: Caller,
  decision: Decision,
  reason: string,
): Outcome<Decision> {
  const actor = caller.actor;
  const ownProposal =
    actor.kind === 'agent' &&
    decision.status === 'proposed' &&
    decision.createdBy.kind === 'agent' &&
    decision.createdBy.principalId === actor.principalId;
  if (!isUser(caller) && !ownProposal) {
    throw forbidden('INV-03-07', 'only the user drops a decision another actor created');
  }
  requireStatus(decision, 'drop', ['proposed', 'open']);
  const write = writeDecision(
    ctx,
    caller,
    decision,
    { ...decision, status: 'dropped', dropReason: reason },
    'dropped',
  );
  return { status: 'ok', record: write.record, changes: [write] };
}
