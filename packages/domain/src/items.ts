/**
 * The action-item lifecycle of docs/design/03-decisions-and-action-items.md §7: creation,
 * accept, start, wait, resume, drop, health, edits and re-planning, and the manual step
 * records of §8.2. The review-loop transitions (claim, verify, reject) are in review.ts.
 *
 * Each command takes the current record and returns the next one with its one domain event
 * (INV-03-09). It refuses a write that breaks an invariant (`E_INVARIANT`), a human-only
 * operation from any actor but the user (`E_HUMAN_REQUIRED`, 04 §4.3), and an agent without
 * the scope the operation needs (`E_FORBIDDEN`, 07 §5).
 */
import type {
  ActionItem,
  ActionKind,
  EvidenceRequirement,
  ExecutionStep,
  ExternalRef,
  Issue,
  ItemSource,
  Privacy,
  VerificationPolicy,
} from '@cc/schemas';

import { type Caller, type DomainContext, hasScope, isSystem, isUser } from './context.js';
import {
  assertNoViolations,
  DomainError,
  forbidden,
  humanRequired,
  invariantError,
  itemLink,
  type Violation,
} from './errors.js';
import { type Change, change, created, type Outcome, omitKeys, touched } from './events.js';
import { escalationHealth, HEALTH_SEVERITY, isActive, WORKING } from './health.js';
import { checkActionItem } from './invariants.js';
import { resolveAfterLastAction } from './issues.js';
import { newPlan, refreshReadiness } from './steps.js';
import type { EvidenceId } from './types.js';

/** A step as given when an item is created: the runtime fields start empty (03 §8.4). */
export type StepInput = Omit<ExecutionStep, 'status' | 'runIds' | 'output' | 'failure'>;

/** The content of a new action item; everything else starts at its default. */
export interface NewActionItem {
  readonly workstreamId: ActionItem['workstreamId'];
  readonly title: string;
  readonly doneMeans: string;
  readonly due: ActionItem['due'];
  readonly kind?: ActionKind;
  readonly evidenceRequirements?: readonly EvidenceRequirement[];
  readonly verificationPolicy?: VerificationPolicy;
  /** Default: the workspace's self person. */
  readonly ownerId?: ActionItem['ownerId'];
  /** Default: the workspace's self person (03 §5.7, "default the user"). */
  readonly reviewerId?: ActionItem['reviewerId'];
  readonly informIds?: ActionItem['informIds'];
  readonly steps?: readonly StepInput[];
  /** Default: manual. */
  readonly source?: ItemSource;
  readonly links?: Partial<ActionItem['links']>;
  /** Default and minimum: the workstream's privacy (03 §5.7). */
  readonly privacy?: Privacy;
  readonly externalRefs?: readonly ExternalRef[];
  /**
   * `open` only for the user and the system. Items created through the CLI or MCP (agent
   * actors), by connectors, from agent suggestions and from ingest rules always start as
   * `draft` (03 §5.7, §7).
   */
  readonly lifecycle?: 'draft' | 'open';
  readonly correlationId?: string;
}

function lifecycleError(
  item: ActionItem,
  operation: string,
  allowed: readonly string[],
): DomainError {
  return invariantError(
    {
      rule: '03 §7',
      message: `${operation} is not allowed from ${item.lifecycle} (allowed from ${allowed.join(', ')})`,
    },
    [itemLink(item.ref)],
  );
}

export function requireLifecycle(
  item: ActionItem,
  operation: string,
  allowed: readonly ActionItem['lifecycle'][],
): void {
  if (!allowed.includes(item.lifecycle)) throw lifecycleError(item, operation, allowed);
}

/** 03 §9.4: auto_close_on_checks only when every required requirement has a check. */
function checkPolicy(item: ActionItem): Violation[] {
  if (item.verificationPolicy !== 'auto_close_on_checks') return [];
  const unchecked = item.evidenceRequirements.filter((r) => r.required && r.check === undefined);
  return unchecked.length === 0
    ? []
    : [
        {
          rule: '03 §9.4',
          message: `auto_close_on_checks needs a check on every required requirement (${unchecked.map((r) => r.id).join(', ')})`,
        },
      ];
}

/** Checks the next state of an item and returns it as one write with its event. */
export function writeItem(
  ctx: DomainContext,
  caller: Caller,
  previous: ActionItem | undefined,
  next: ActionItem,
  verb: string,
  options: { extra?: Record<string, unknown>; correlationId?: string } = {},
): Change<ActionItem> {
  const now = ctx.clock.now();
  assertNoViolations([...checkActionItem(next, ctx.registry, now, previous), ...checkPolicy(next)]);
  const record = previous === undefined ? next : touched(ctx, next, caller.actor);
  return change(ctx, {
    kind: 'action_item',
    verb,
    entity: { id: record.id, ref: record.ref },
    before: previous,
    after: record,
    actor: caller.actor,
    ...(options.extra === undefined ? {} : { extra: options.extra }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  });
}

function ok(write: Change<ActionItem>, more: readonly Change[] = []): Outcome<ActionItem> {
  return { status: 'ok', record: write.record, changes: [write, ...more] };
}

/** Create (03 §7 `[*] → draft`, or `open` when the user or the system creates it whole). */
export function createActionItem(
  ctx: DomainContext,
  caller: Caller,
  input: NewActionItem,
): Outcome<ActionItem> {
  const actor = caller.actor;
  if (actor.kind === 'agent' && !hasScope(caller, 'items:write')) {
    throw forbidden('03 §7', 'creating items needs the items:write scope');
  }
  const workstream = ctx.registry.workstream(input.workstreamId);
  if (workstream === undefined) {
    throw new DomainError('E_NOT_FOUND', '03 §5.7', `workstream ${input.workstreamId} not found`);
  }
  const source = input.source ?? { kind: 'manual' };
  const draftOnly =
    actor.kind === 'agent' ||
    actor.kind === 'connector' ||
    source.kind === 'agent_suggestion' ||
    source.kind === 'ingest_rule';
  const lifecycle = input.lifecycle === 'open' && !draftOnly ? 'open' : 'draft';
  const self = ctx.registry.selfPersonId;
  const steps: ExecutionStep[] = (input.steps ?? []).map((step) => ({
    ...step,
    status: 'pending',
    runIds: [],
  }));
  const privacy: Privacy =
    input.privacy === 'sensitive' || workstream.privacy === 'sensitive' ? 'sensitive' : 'normal';
  const draft: ActionItem = {
    id: ctx.ids.id('act'),
    ref: ctx.ids.ref('A'),
    workstreamId: input.workstreamId,
    kind: input.kind ?? 'todo',
    title: input.title,
    doneMeans: input.doneMeans,
    evidenceRequirements: [...(input.evidenceRequirements ?? [])],
    verificationPolicy: input.verificationPolicy ?? 'require_review',
    ownerId: input.ownerId ?? self,
    reviewerId: input.reviewerId ?? self,
    informIds: [...(input.informIds ?? [])],
    due: input.due,
    lifecycle,
    health: 'on_track',
    execution: newPlan(steps),
    source,
    links: {
      goalIds: [...(input.links?.goalIds ?? [])],
      measureIds: [...(input.links?.measureIds ?? [])],
      decisionIds: [...(input.links?.decisionIds ?? [])],
      issueIds: [...(input.links?.issueIds ?? [])],
      ...(input.links?.parentActionId === undefined
        ? {}
        : { parentActionId: input.links.parentActionId }),
    },
    carryCount: 0,
    replannedCount: 0,
    escalationLevel: 0,
    privacy,
    externalRefs: [...(input.externalRefs ?? [])],
    ...created(ctx, actor),
  };
  const item: ActionItem = { ...draft, execution: refreshReadiness(draft) };
  return ok(
    writeItem(ctx, caller, undefined, item, 'created', {
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    }),
  );
}

/**
 * Accept: `draft → open` (03 §7). Human-only (04 §4.3), also on behalf of an absent or
 * external owner, with a note. INV-03-04 must hold; the first steps become ready.
 */
export function acceptItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  note?: string,
): Outcome<ActionItem> {
  if (!isUser(caller)) throw humanRequired('Accepting a draft item', itemLink(item.ref));
  requireLifecycle(item, 'accept', ['draft']);
  const opened: ActionItem = { ...item, lifecycle: 'open' };
  const next: ActionItem = { ...opened, execution: refreshReadiness(opened) };
  return ok(
    writeItem(ctx, caller, item, next, 'accepted', note === undefined ? {} : { extra: { note } }),
  );
}

/** Start: `open → in_progress` when a step starts (03 §7). The scheduler or the user. */
export function startItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
): Outcome<ActionItem> {
  if (!isUser(caller) && !isSystem(caller, 'scheduler')) {
    throw forbidden('03 §7', 'only the user or system:scheduler starts an item');
  }
  requireLifecycle(item, 'start', ['open']);
  return ok(writeItem(ctx, caller, item, { ...item, lifecycle: 'in_progress' }, 'started'));
}

/**
 * Wait: `open | in_progress → waiting` when a step waits on a person, a confirmation, an
 * external agent, a dependency or a date (03 §7). The system sets it, with `waitingOn`; the
 * E1 timer counts from `since`.
 */
export function waitItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  waitingOn: { kind: NonNullable<ActionItem['waitingOn']>['kind']; ref?: string },
): Outcome<ActionItem> {
  if (!isSystem(caller)) throw forbidden('03 §7', 'only the system moves an item to waiting');
  requireLifecycle(item, 'wait', ['open', 'in_progress']);
  const next: ActionItem = {
    ...item,
    lifecycle: 'waiting',
    waitingOn: { ...waitingOn, since: ctx.clock.now() },
  };
  return ok(writeItem(ctx, caller, item, next, 'waiting'));
}

/** Resume: `waiting → in_progress` when the wait clears (03 §7). The system or the user. */
export function resumeItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
): Outcome<ActionItem> {
  if (!isUser(caller) && !isSystem(caller)) {
    throw forbidden('03 §7', 'only the system or the user clears a wait');
  }
  requireLifecycle(item, 'resume', ['waiting']);
  const next: ActionItem = { ...omitKeys(item, 'waitingOn'), lifecycle: 'in_progress' };
  return ok(writeItem(ctx, caller, item, next, 'resumed'));
}

/**
 * Drop: `draft | open | in_progress | waiting → dropped` with a reason (03 §7, INV-03-05).
 * Human-only (04 §4.3). Each linked open issue is resolved if this was its last open action:
 * pass the issues linked to the item and every action item linked to those issues.
 */
export function dropItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  reason: string,
  linked: { issues: readonly Issue[]; items: readonly ActionItem[] } = { issues: [], items: [] },
): Outcome<ActionItem> {
  if (!isUser(caller)) throw humanRequired('Dropping an item', itemLink(item.ref));
  requireLifecycle(item, 'drop', ['draft', 'open', 'in_progress', 'waiting']);
  const now = ctx.clock.now();
  const next: ActionItem = {
    ...omitKeys(item, 'waitingOn'),
    lifecycle: 'dropped',
    dropReason: reason,
    closedAt: now,
    closedBy: caller.actor,
  };
  const write = writeItem(ctx, caller, item, next, 'dropped');
  const others = linked.items.map((other) => (other.id === item.id ? write.record : other));
  const issueChanges = linked.issues.flatMap((issue) => {
    const resolved = resolveAfterLastAction(ctx, caller, issue, others, {
      ref: item.ref,
      reason,
    });
    return resolved === undefined ? [] : [resolved];
  });
  return ok(write, issueChanges);
}

/**
 * Health rule 1 (03 §7): the user, or an agent with `items:write` (07 §5), sets health with a
 * note. Rule 3: only the user lowers health; verification is the other way back to on_track.
 */
export function setItemHealth(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  health: ActionItem['health'],
  note?: string,
): Outcome<ActionItem> {
  if (!isUser(caller) && !hasScope(caller, 'items:write') && !isSystem(caller)) {
    throw forbidden('03 §7', 'setting health needs the items:write scope');
  }
  if (!isActive(item)) throw lifecycleError(item, 'set health', ['an active lifecycle']);
  if (!isUser(caller) && HEALTH_SEVERITY[health] < HEALTH_SEVERITY[item.health]) {
    throw invariantError({
      rule: '03 §7',
      message: `only the user lowers health from ${item.health} to ${health} (health rule 3)`,
    });
  }
  const base = omitKeys(item, 'healthNote');
  const next: ActionItem =
    note === undefined || note.trim() === ''
      ? { ...base, health }
      : { ...base, health, healthNote: note };
  if (next.health === item.health && next.healthNote === item.healthNote) {
    return { status: 'no-op', record: item, changes: [] };
  }
  return ok(writeItem(ctx, caller, item, next, 'health_set'));
}

/** The editable content fields of an item. Due changes outside draft are re-plans. */
export type ItemEdit = Partial<
  Pick<
    ActionItem,
    | 'kind'
    | 'title'
    | 'doneMeans'
    | 'evidenceRequirements'
    | 'verificationPolicy'
    | 'ownerId'
    | 'reviewerId'
    | 'informIds'
    | 'due'
    | 'links'
    | 'privacy'
    | 'externalRefs'
  >
>;

/**
 * Edit an item's content. The user edits any active item; an agent with `items:write` edits
 * drafts only (07 §5: it creates drafts). A changed due date on an accepted item is a re-plan
 * (`replanItem`). Every invariant runs on the result (INV-03-12 included).
 */
export function updateItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  edit: ItemEdit,
): Outcome<ActionItem> {
  if (!isUser(caller) && !(hasScope(caller, 'items:write') && item.lifecycle === 'draft')) {
    throw forbidden('03 §7', 'only the user edits an accepted item; agents edit drafts');
  }
  if (!isActive(item)) throw lifecycleError(item, 'edit', ['an active lifecycle']);
  if (
    edit.due !== undefined &&
    item.lifecycle !== 'draft' &&
    JSON.stringify(edit.due) !== JSON.stringify(item.due)
  ) {
    throw invariantError({
      rule: '02 §7.1',
      message: 'a new due date for an accepted item is a re-plan, with a reason',
    });
  }
  const next: ActionItem = { ...item, ...edit };
  if (JSON.stringify(next) === JSON.stringify(item)) {
    return { status: 'no-op', record: item, changes: [] };
  }
  return ok(writeItem(ctx, caller, item, next, 'updated'));
}

/**
 * Re-plan (02 §7.1 rule 3, 03 §11 rule 2): a new due date with a reason, set by the user in
 * `issues`. Keeps `carryCount` as history, resets `escalationLevel` to 0 and increments
 * `replannedCount`.
 */
export function replanItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  due: Pick<ActionItem['due'], 'date'> & Partial<ActionItem['due']>,
  reason: string,
): Outcome<ActionItem> {
  if (!isUser(caller)) throw forbidden('02 §7.1', 'only the user re-plans an item');
  requireLifecycle(item, 're-plan', ['open', 'in_progress', 'waiting']);
  if (reason.trim() === '') {
    throw invariantError({ rule: '02 §7.1', message: 'a re-plan needs a reason' });
  }
  const next: ActionItem = {
    ...item,
    due: { ...item.due, ...due },
    escalationLevel: 0,
    replannedCount: item.replannedCount + 1,
  };
  return ok(writeItem(ctx, caller, item, next, 'replanned', { extra: { reason } }));
}

/**
 * Records a step as done (`succeeded` or `skipped`) with its output (03 §8.2). The user
 * records any step, including a connector step done by hand (03 §13.1); the system, a
 * connector or an agent records connector, agent and external-agent steps. An `open` item
 * becomes `in_progress`, and the steps that depended on it become ready.
 */
export function completeStep(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  stepId: string,
  result: { status: 'succeeded' | 'skipped'; evidenceIds?: EvidenceId[]; note?: string },
): Outcome<ActionItem> {
  requireLifecycle(item, 'complete a step', ['open', 'in_progress', 'waiting']);
  const step = item.execution.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new DomainError('E_NOT_FOUND', '03 §8.2', `${item.ref} has no step ${stepId}`);
  }
  const humanStep = step.performer.kind === 'user' || step.performer.kind === 'person';
  if (humanStep && !isUser(caller)) {
    throw forbidden('03 §8.1', `only the user records ${step.performer.kind} step ${stepId}`);
  }
  if (step.status === 'succeeded' || step.status === 'skipped') {
    return { status: 'no-op', record: item, changes: [] };
  }
  const output = {
    evidenceIds: [...(result.evidenceIds ?? [])],
    ...(result.note === undefined ? {} : { note: result.note }),
  };
  const steps = item.execution.steps.map((candidate) =>
    candidate.id === stepId
      ? { ...omitKeys(candidate, 'failure'), status: result.status, output }
      : candidate,
  );
  const lifecycle = item.lifecycle === 'open' ? 'in_progress' : item.lifecycle;
  const moved: ActionItem = { ...item, lifecycle, execution: { ...item.execution, steps } };
  const next: ActionItem = { ...moved, execution: refreshReadiness(moved) };
  return ok(writeItem(ctx, caller, item, next, 'step_completed', { extra: { stepId } }));
}

/**
 * Records a step as failed (03 §8.2 rule 4): item health becomes `at_risk` with the failure
 * code as the note, unless it is already worse.
 */
export function failStep(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  stepId: string,
  failure: { code: string; detail: string; retriable: boolean },
): Outcome<ActionItem> {
  if (isUser(caller)) throw forbidden('03 §8.2', 'step failures come from the step runner');
  if (!WORKING.has(item.lifecycle)) throw lifecycleError(item, 'fail a step', [...WORKING]);
  const step = item.execution.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new DomainError('E_NOT_FOUND', '03 §8.2', `${item.ref} has no step ${stepId}`);
  }
  const steps = item.execution.steps.map((candidate) =>
    candidate.id === stepId
      ? { ...candidate, status: 'failed' as const, failure: { ...failure, at: ctx.clock.now() } }
      : candidate,
  );
  const raise = HEALTH_SEVERITY[item.health] < HEALTH_SEVERITY.at_risk;
  const next: ActionItem = {
    ...item,
    execution: { ...item.execution, steps },
    ...(raise
      ? { health: 'at_risk' as const, healthNote: `Step ${stepId} failed: ${failure.code}` }
      : {}),
  };
  return ok(writeItem(ctx, caller, item, next, 'step_failed', { extra: { stepId } }));
}

/** Health rule 2 (03 §7), applied by the escalation job (actor system:escalation). */
export function applyEscalationHealth(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
): Outcome<ActionItem> {
  if (!isSystem(caller, 'escalation')) {
    throw forbidden('03 §7', 'health rule 2 is applied by system:escalation only');
  }
  const proposed = escalationHealth(item, ctx.clock.now());
  if (proposed === undefined) return { status: 'no-op', record: item, changes: [] };
  return setItemHealth(ctx, caller, item, proposed.health, proposed.healthNote);
}

/**
 * Carry-forward (02 §7.1 rule 2): one more `carryCount` for an item a completed review counted.
 * The rhythm engine applies it when the review closes, once per (item, instance) pair (C-02-05);
 * the event names the meeting, which is how the pair is recognised again.
 */
export function carryItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  meetingId: string,
): Outcome<ActionItem> {
  if (!isSystem(caller, 'rhythm')) {
    throw forbidden('02 §7.1', 'carry counts are set by the rhythm engine when a review closes');
  }
  const next: ActionItem = { ...item, carryCount: item.carryCount + 1 };
  return ok(writeItem(ctx, caller, item, next, 'carried', { extra: { meetingId } }));
}

/**
 * Escalation (02 §7.2): raises `escalationLevel`, by the escalation job only (C-02-06). It never
 * lowers the level (rule 2): re-planning resets it (`replanItem`). `fields` carries what the job
 * changes with it, such as the link to the E2 issue; `extra` goes into the event.
 */
export function escalateItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  level: ActionItem['escalationLevel'],
  options: { links?: ActionItem['links']; extra?: Record<string, unknown> } = {},
): Outcome<ActionItem> {
  if (!isSystem(caller, 'escalation')) {
    throw forbidden('02 §7.2', 'escalation levels are set by system:escalation only');
  }
  if (level < item.escalationLevel) {
    throw invariantError({
      rule: '02 §7.2',
      message: `${item.ref} is at E${String(item.escalationLevel)}; the escalation job never lowers it to E${String(level)}`,
    });
  }
  if (level === item.escalationLevel && options.links === undefined) {
    return { status: 'no-op', record: item, changes: [] };
  }
  const next: ActionItem = {
    ...item,
    escalationLevel: level,
    ...(options.links === undefined ? {} : { links: options.links }),
  };
  return ok(
    writeItem(ctx, caller, item, next, 'escalated', {
      extra: { from: item.escalationLevel, ...options.extra },
    }),
  );
}
