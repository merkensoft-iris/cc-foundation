/**
 * Issues and risks, docs/design/03-decisions-and-action-items.md §11.
 *
 * 1. Issues come from meetings, E2 escalations, goals off track twice, not-normal measures
 *    with no explanation, and rhythm escalations (`raisedFrom`).
 * 2. The `issues` section resolves each by IDS: as a decision, as action items, as a re-plan
 *    or as a drop (INV-03-11).
 * 3. A triggered risk creates an issue.
 * 4. A workspace-wide risk is recorded on the Workspace pseudo-workstream.
 */
import type { ActionItem, Issue, IssueOrigin, Risk } from '@cc/schemas';

import { type Caller, type DomainContext, hasScope, isSystem, isUser } from './context.js';
import { assertNoViolations, DomainError, forbidden, invariantError } from './errors.js';
import { type Change, change, created, type Outcome, touched } from './events.js';
import { isActive } from './health.js';
import { checkIssue } from './invariants.js';
import type { PersonId, WorkstreamId } from './types.js';

function writeIssue(
  ctx: DomainContext,
  caller: Caller,
  previous: Issue | undefined,
  next: Issue,
  verb: string,
  correlationId?: string,
): Change<Issue> {
  assertNoViolations(checkIssue(next));
  const record = previous === undefined ? next : touched(ctx, next, caller.actor);
  return change(ctx, {
    kind: 'issue',
    verb,
    entity: { id: record.id, ref: record.ref },
    before: previous,
    after: record,
    actor: caller.actor,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

function requireWorkstream(ctx: DomainContext, id: WorkstreamId): void {
  if (ctx.registry.workstream(id) === undefined) {
    throw new DomainError('E_NOT_FOUND', '03 §11', `workstream ${id} not found`);
  }
}

/**
 * Raise an issue (03 §11 rule 1). The user, an agent with `items:write` (the scope the
 * `issues.raise` schema takes), or the system (escalation, rhythm, review).
 */
export function raiseIssue(
  ctx: DomainContext,
  caller: Caller,
  input: { workstreamId: WorkstreamId; title: string; raisedFrom?: IssueOrigin; rank?: number },
  correlationId?: string,
): Outcome<Issue> {
  if (!isUser(caller) && !isSystem(caller) && !hasScope(caller, 'items:write')) {
    throw forbidden('03 §11', 'raising issues needs the items:write scope');
  }
  requireWorkstream(ctx, input.workstreamId);
  const issue: Issue = {
    id: ctx.ids.id('iss'),
    ref: ctx.ids.ref('I'),
    workstreamId: input.workstreamId,
    title: input.title,
    raisedFrom: input.raisedFrom ?? { kind: 'manual' },
    ...(input.rank === undefined ? {} : { rank: input.rank }),
    status: 'open',
    ...created(ctx, caller.actor),
  };
  const write = writeIssue(ctx, caller, undefined, issue, 'raised', correlationId);
  return { status: 'ok', record: write.record, changes: [write] };
}

export type IssueResolution = Pick<NonNullable<Issue['resolution']>, 'kind' | 'refs' | 'note'>;

/**
 * Resolve an issue (03 §11 rule 2) in the `issues` section, by the user: as a decision or
 * action items (their refs), or as a re-plan with a note (INV-03-11). A drop is `dropIssue`.
 */
export function resolveIssue(
  ctx: DomainContext,
  caller: Caller,
  issue: Issue,
  resolution: IssueResolution,
): Outcome<Issue> {
  if (!isUser(caller)) throw forbidden('03 §11', 'only the user resolves issues');
  if (issue.status !== 'open') {
    throw invariantError({ rule: '03 §11', message: `${issue.ref} is ${issue.status}` });
  }
  if (resolution.kind === 'dropped') return dropIssue(ctx, caller, issue, resolution.note);
  const next: Issue = {
    ...issue,
    status: 'resolved',
    resolution: {
      ...resolution,
      refs: [...resolution.refs],
      at: ctx.clock.now(),
      by: caller.actor,
    },
  };
  const write = writeIssue(ctx, caller, issue, next, 'resolved');
  return { status: 'ok', record: write.record, changes: [write] };
}

/** Drop an issue with a note (03 §11 rule 2, E-6, INV-03-11). The user only. */
export function dropIssue(
  ctx: DomainContext,
  caller: Caller,
  issue: Issue,
  note: string,
): Outcome<Issue> {
  if (!isUser(caller)) throw forbidden('03 §11', 'only the user drops issues');
  if (issue.status !== 'open') {
    throw invariantError({ rule: '03 §11', message: `${issue.ref} is ${issue.status}` });
  }
  const next: Issue = {
    ...issue,
    status: 'dropped',
    resolution: { kind: 'dropped', refs: [], note, at: ctx.clock.now(), by: caller.actor },
  };
  const write = writeIssue(ctx, caller, issue, next, 'dropped');
  return { status: 'ok', record: write.record, changes: [write] };
}

/** Whether an action item is linked to an issue: created from it, or linked to it. */
export function linkedToIssue(item: ActionItem, issue: Issue): boolean {
  return (
    (item.source.kind === 'issue' && item.source.issueId === issue.id) ||
    item.links.issueIds.includes(issue.id)
  );
}

/**
 * The drop side effect of 03 §7: "the linked issue is resolved if this was its last open
 * action". Given the issue and its action items (the dropped one already dropped), resolves
 * an open issue none of whose action items is still active, as kind `action` with the refs of
 * all its action items. Returns undefined when nothing changes.
 */
export function resolveAfterLastAction(
  ctx: DomainContext,
  caller: Caller,
  issue: Issue,
  items: readonly ActionItem[],
  dropped: { ref: string; reason: string },
): Change<Issue> | undefined {
  if (issue.status !== 'open') return undefined;
  const actions = items.filter((item) => linkedToIssue(item, issue));
  if (actions.length === 0 || actions.some(isActive)) return undefined;
  const next: Issue = {
    ...issue,
    status: 'resolved',
    resolution: {
      kind: 'action',
      refs: actions.map((item) => item.ref),
      note: `Last open action ${dropped.ref} dropped: ${dropped.reason}`,
      at: ctx.clock.now(),
      by: caller.actor,
    },
  };
  return writeIssue(ctx, caller, issue, next, 'resolved');
}

// Risks

function writeRisk(
  ctx: DomainContext,
  caller: Caller,
  previous: Risk | undefined,
  next: Risk,
  verb: string,
): Change<Risk> {
  const record = previous === undefined ? next : touched(ctx, next, caller.actor);
  return change(ctx, {
    kind: 'risk',
    verb,
    entity: { id: record.id, ref: record.ref },
    before: previous,
    after: record,
    actor: caller.actor,
  });
}

/**
 * Record a risk (03 §5.6). Workspace-wide risks go on the Workspace pseudo-workstream (03 §11
 * rule 4). The user, or an agent with `items:write`.
 */
export function recordRisk(
  ctx: DomainContext,
  caller: Caller,
  input: { workstreamId: WorkstreamId; description: string; trigger: string; watcherId?: PersonId },
): Outcome<Risk> {
  if (!isUser(caller) && !hasScope(caller, 'items:write')) {
    throw forbidden('03 §11', 'recording risks needs the items:write scope');
  }
  requireWorkstream(ctx, input.workstreamId);
  const watcherId = input.watcherId ?? ctx.registry.selfPersonId;
  if (ctx.registry.person(watcherId) === undefined) {
    throw invariantError({ rule: '03 §11', message: `watcher ${watcherId} is not a person` });
  }
  const risk: Risk = {
    id: ctx.ids.id('rsk'),
    ref: ctx.ids.ref('R'),
    workstreamId: input.workstreamId,
    description: input.description,
    watcherId,
    trigger: input.trigger,
    status: 'watching',
    reviewCadence: 'monthly',
    ...created(ctx, caller.actor),
  };
  const write = writeRisk(ctx, caller, undefined, risk, 'recorded');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * A risk triggers (03 §11 rule 3): `watching → triggered`, and an issue is raised in the
 * risk's workstream in the same transaction. Its origin is the meeting section where it was
 * seen (usually `risk_review`), or manual. The user or the system.
 */
export function triggerRisk(
  ctx: DomainContext,
  caller: Caller,
  risk: Risk,
  origin: IssueOrigin = { kind: 'manual' },
): Outcome<Risk> {
  if (!isUser(caller) && !isSystem(caller)) {
    throw forbidden('03 §11', 'only the user or the system marks a risk triggered');
  }
  if (risk.status !== 'watching') {
    throw invariantError({
      rule: '03 §11',
      message: `${risk.ref} is ${risk.status}, not watching`,
    });
  }
  const write = writeRisk(ctx, caller, risk, { ...risk, status: 'triggered' }, 'triggered');
  const issue = raiseIssue(
    ctx,
    caller,
    {
      workstreamId: risk.workstreamId,
      title: `Risk ${risk.ref} triggered: ${risk.description}`,
      raisedFrom: origin,
    },
    risk.id,
  );
  return { status: 'ok', record: write.record, changes: [write, ...issue.changes] };
}

/** Close a risk (`watching | triggered → closed`). The user only. */
export function closeRisk(ctx: DomainContext, caller: Caller, risk: Risk): Outcome<Risk> {
  if (!isUser(caller)) throw forbidden('03 §11', 'only the user closes a risk');
  if (risk.status === 'closed') return { status: 'no-op', record: risk, changes: [] };
  const write = writeRisk(ctx, caller, risk, { ...risk, status: 'closed' }, 'closed');
  return { status: 'ok', record: write.record, changes: [write] };
}
