/**
 * Evidence and the review loop, docs/design/03-decisions-and-action-items.md §9: evidence,
 * claim (§9.2 step 1, C-03-01), check results (step 2), the auto decision (step 4), and the
 * user's confirm, attest and reject (steps 4 and 5) with the Confirm rule of owner decision
 * Q5. Methods `confirmed` and `attested` are the manual path P1 ships; `auto` needs the
 * connector checks of P2 to produce pass results, and its rules are here already.
 */
import type {
  ActionItem,
  CheckResult,
  Evidence,
  EvidenceRequirement,
  VerificationRecord,
} from '@cc/schemas';

import { type Caller, type DomainContext, hasScope, isSystem, isUser } from './context.js';
import { DomainError, forbidden, humanRequired, invariantError, itemLink } from './errors.js';
import { change, type Outcome, omitKeys } from './events.js';
import { requireLifecycle, writeItem } from './items.js';

/** Evidence as handed in; the domain fills in its ID, item and capture fields. */
export type EvidenceInput = Omit<Evidence, 'id' | 'actionItemId' | 'capturedAt' | 'capturedBy'>;

/** Evidence kinds a user can check, unlike a bare note (owner decision Q5, 03 §9.2 step 4). */
export const CHECKABLE_KINDS: ReadonlySet<Evidence['kind']> = new Set([
  'url',
  'file',
  'connector_record',
  'measure_value',
  'meeting_record',
  'external_task',
]);

function same(a: EvidenceInput, b: EvidenceInput): boolean {
  const key = (e: EvidenceInput) =>
    JSON.stringify([
      e.requirementId,
      e.kind,
      e.summary,
      e.url,
      e.blobSha256,
      e.record,
      e.externalTask,
    ]);
  return key(a) === key(b);
}

/**
 * The requirement a piece of evidence answers: the one it names, or, when it names none, the
 * only requirement that accepts its kind.
 */
function requirementFor(item: ActionItem, input: EvidenceInput): EvidenceRequirement | undefined {
  if (input.requirementId !== undefined) {
    const named = item.evidenceRequirements.find((r) => r.id === input.requirementId);
    if (named === undefined) {
      throw invariantError({
        rule: '03 §9.1',
        message: `${item.ref} has no evidence requirement ${input.requirementId}`,
      });
    }
    return named;
  }
  const accepting = item.evidenceRequirements.filter((r) => r.acceptedKinds.includes(input.kind));
  return accepting.length === 1 ? accepting[0] : undefined;
}

/**
 * Add evidence to an item (03 §9). The user, an agent with `items:claim` (07 §5), a
 * connector or the system may add evidence (INV-03-07). Not on a closed item. The same
 * evidence twice is a no-op, so a repeated claim stays idempotent (C-03-01).
 */
export function addEvidence(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  existing: readonly Evidence[],
  input: EvidenceInput,
): Outcome<Evidence> {
  if (caller.actor.kind === 'agent' && !hasScope(caller, 'items:claim')) {
    throw forbidden('INV-03-07', 'adding evidence needs the items:claim scope');
  }
  requireLifecycle(item, 'add evidence', [
    'draft',
    'open',
    'in_progress',
    'waiting',
    'claimed_done',
  ]);
  const requirement = requirementFor(item, input);
  if (requirement !== undefined && !requirement.acceptedKinds.includes(input.kind)) {
    throw invariantError({
      rule: '03 §9.1',
      message: `${requirement.id} accepts ${requirement.acceptedKinds.join(', ')}, not ${input.kind}`,
    });
  }
  const resolved: EvidenceInput =
    requirement === undefined
      ? omitKeys(input, 'requirementId')
      : { ...input, requirementId: requirement.id };
  const duplicate = existing.find((e) => e.actionItemId === item.id && same(e, resolved));
  if (duplicate !== undefined) return { status: 'no-op', record: duplicate, changes: [] };
  const evidence: Evidence = {
    ...resolved,
    id: ctx.ids.id('evd'),
    actionItemId: item.id,
    capturedAt: ctx.clock.now(),
    capturedBy: caller.actor,
  };
  const write = change(ctx, {
    kind: 'evidence',
    verb: 'added',
    entity: { id: evidence.id },
    before: undefined,
    after: evidence,
    actor: caller.actor,
    correlationId: item.id,
  });
  return { status: 'ok', record: evidence, changes: [write] };
}

/** The required requirements that have no evidence yet. */
export function missingEvidence(item: ActionItem, evidence: readonly Evidence[]): string[] {
  return item.evidenceRequirements
    .filter((r) => r.required)
    .filter((r) => !evidence.some((e) => e.actionItemId === item.id && e.requirementId === r.id))
    .map((r) => r.id);
}

function pendingChecks(item: ActionItem, at: string): CheckResult[] {
  return item.evidenceRequirements
    .filter((r) => r.check !== undefined)
    .map((r) => ({ requirementId: r.id, status: 'pending' as const, at, detail: 'queued' }));
}

/**
 * Claim (03 §7, §9.2 step 1): `open | in_progress | waiting → claimed_done`. By the user, an
 * agent with `items:claim`, or system:review when the steps produced the evidence (§8.2 rule
 * 6). Every required requirement needs evidence (`E_EVIDENCE_MISSING`). The checks of the
 * requirements that have one are queued as `pending` (step 2).
 *
 * C-03-01: claiming an already claimed item with no evidence added since the claim is a
 * no-op. With new evidence it is a fresh claim, and the checks are queued again.
 */
export function claimItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  evidence: readonly Evidence[],
  note?: string,
): Outcome<ActionItem> {
  const actor = caller.actor;
  if (actor.kind === 'agent' && !hasScope(caller, 'items:claim')) {
    throw forbidden('INV-03-07', 'claiming needs the items:claim scope');
  }
  if (actor.kind === 'connector' || (actor.kind === 'system' && actor.component !== 'review')) {
    throw forbidden(
      'INV-03-07',
      'only the user, an agent with items:claim or system:review claims',
    );
  }
  if (item.lifecycle === 'claimed_done' && item.claim !== undefined) {
    const since = item.claim.at;
    const fresh = evidence.some(
      (e) => e.actionItemId === item.id && Date.parse(e.capturedAt) > Date.parse(since),
    );
    if (!fresh) return { status: 'no-op', record: item, changes: [] };
  } else {
    requireLifecycle(item, 'claim', ['open', 'in_progress', 'waiting']);
  }
  const missing = missingEvidence(item, evidence);
  if (missing.length > 0) {
    throw new DomainError(
      'E_EVIDENCE_MISSING',
      '03 §9.2',
      `${item.ref} has no evidence for required requirement ${missing.join(', ')}`,
      missing,
    );
  }
  const now = ctx.clock.now();
  const verification: VerificationRecord = {
    checks: pendingChecks(item, now),
    rejectedClaims: item.verification?.rejectedClaims ?? [],
  };
  const next: ActionItem = {
    ...omitKeys(item, 'waitingOn'),
    lifecycle: 'claimed_done',
    claim: { at: now, by: actor, ...(note === undefined ? {} : { note }) },
    verification,
  };
  const write = writeItem(ctx, caller, item, next, 'claimed');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Record a check result on a claimed item (03 §9.2 step 2). Checks are run by the system, a
 * connector or an agent, never decided by the user (INV-03-07). `inconclusive` is kept as
 * such and never counts as a pass.
 */
export function recordCheckResult(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  result: CheckResult,
): Outcome<ActionItem> {
  if (isUser(caller)) throw forbidden('INV-03-07', 'check results come from the checks themselves');
  requireLifecycle(item, 'record a check result', ['claimed_done']);
  const requirement = item.evidenceRequirements.find((r) => r.id === result.requirementId);
  if (requirement?.check === undefined) {
    throw invariantError({
      rule: '03 §9.1',
      message: `${item.ref} requirement ${result.requirementId} has no check`,
    });
  }
  const current = item.verification ?? { checks: [], rejectedClaims: [] };
  const checks = [
    ...current.checks.filter((c) => c.requirementId !== result.requirementId),
    result,
  ];
  const next: ActionItem = { ...item, verification: { ...current, checks } };
  const write = writeItem(ctx, caller, item, next, 'check_recorded', {
    ...(result.runId === undefined ? {} : { correlationId: result.runId }),
  });
  return { status: 'ok', record: write.record, changes: [write] };
}

/** Whether every required requirement has a `pass` check result. */
export function allRequiredChecksPass(item: ActionItem): boolean {
  const checks = item.verification?.checks ?? [];
  return item.evidenceRequirements
    .filter((r) => r.required)
    .every((r) => checks.some((c) => c.requirementId === r.id && c.status === 'pass'));
}

function verified(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  method: NonNullable<VerificationRecord['method']>,
  attestationNote?: string,
): ActionItem {
  const now = ctx.clock.now();
  const current = item.verification ?? { checks: [], rejectedClaims: [] };
  return {
    ...omitKeys(item, 'healthNote'),
    lifecycle: 'verified_done',
    // Health rule 3: a verified claim clears at_risk and off_track.
    health: 'on_track',
    verification: {
      ...current,
      method,
      decidedBy: caller.actor,
      decidedAt: now,
      ...(attestationNote === undefined ? {} : { attestationNote }),
    },
    closedAt: now,
    closedBy: caller.actor,
  };
}

/**
 * The auto decision (03 §9.2 step 4, §9.4): with `auto_close_on_checks` and every required
 * check passed, the review job (system:review only, C-03-02) verifies with method `auto`.
 * Otherwise the item stays in the review queue: a no-op.
 */
export function autoVerify(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
): Outcome<ActionItem> {
  if (!isSystem(caller, 'review')) {
    throw forbidden('03 §9.2', 'only the review job verifies with method auto (C-03-02)');
  }
  if (
    item.lifecycle !== 'claimed_done' ||
    item.verificationPolicy !== 'auto_close_on_checks' ||
    !allRequiredChecksPass(item)
  ) {
    return { status: 'no-op', record: item, changes: [] };
  }
  const write = writeItem(ctx, caller, item, verified(ctx, caller, item, 'auto'), 'verified');
  return { status: 'ok', record: write.record, changes: [write] };
}

export interface ReviewOptions {
  /** Owner decision Q5: enabled only when every required requirement has checkable evidence. */
  readonly confirm: { readonly enabled: boolean; readonly reason?: string };
  readonly attest: { readonly enabled: boolean };
  readonly reject: { readonly enabled: boolean };
  /** Required requirements backed only by a note (or nothing checkable). */
  readonly notCheckable: readonly string[];
}

/**
 * What the review queue offers for an item (03 §9.2 step 4, owner decision Q5). Confirm is
 * enabled only when every required requirement has a `pass` check result or evidence of a
 * kind other than `note`; otherwise it is disabled with the reason, and Attest is offered.
 */
export function reviewOptions(item: ActionItem, evidence: readonly Evidence[]): ReviewOptions {
  if (item.lifecycle !== 'claimed_done') {
    return {
      confirm: { enabled: false, reason: `${item.ref} is ${item.lifecycle}, not claimed` },
      attest: { enabled: false },
      reject: { enabled: false },
      notCheckable: [],
    };
  }
  const checks = item.verification?.checks ?? [];
  const notCheckable = item.evidenceRequirements
    .filter((r) => r.required)
    .filter(
      (r) =>
        !checks.some((c) => c.requirementId === r.id && c.status === 'pass') &&
        !evidence.some(
          (e) =>
            e.actionItemId === item.id && e.requirementId === r.id && CHECKABLE_KINDS.has(e.kind),
        ),
    )
    .map((r) => r.id);
  const confirm =
    notCheckable.length === 0
      ? { enabled: true }
      : {
          enabled: false,
          reason: `No checkable evidence for ${notCheckable.join(', ')}: only a note. Attest instead.`,
        };
  return { confirm, attest: { enabled: true }, reject: { enabled: true }, notCheckable };
}

/**
 * Confirm (03 §9.2 step 4): the user reviewed the evidence; `verified_done` with method
 * `confirmed`. Human-only (INV-03-07). Refused while Confirm is disabled (owner decision Q5).
 */
export function confirmItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  evidence: readonly Evidence[],
): Outcome<ActionItem> {
  if (!isUser(caller)) throw humanRequired('Confirming a claim', itemLink(item.ref));
  requireLifecycle(item, 'confirm', ['claimed_done']);
  const options = reviewOptions(item, evidence);
  if (!options.confirm.enabled) {
    throw invariantError({
      rule: '03 §9.2',
      message: options.confirm.reason ?? 'Confirm is disabled',
    });
  }
  const write = writeItem(ctx, caller, item, verified(ctx, caller, item, 'confirmed'), 'verified');
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Attest (03 §9.2 step 4, §9.3): the user states it was done, with a note; `verified_done`
 * with method `attested`, counted separately. Human-only (INV-03-07); the note is required
 * (INV-03-06).
 */
export function attestItem(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  note: string,
): Outcome<ActionItem> {
  if (!isUser(caller)) throw humanRequired('Attesting a claim', itemLink(item.ref));
  requireLifecycle(item, 'attest', ['claimed_done']);
  const write = writeItem(
    ctx,
    caller,
    item,
    verified(ctx, caller, item, 'attested', note),
    'verified',
  );
  return { status: 'ok', record: write.record, changes: [write] };
}

/**
 * Reject (03 §7, §9.2 step 5): `claimed_done → in_progress`, health `at_risk` with the reason
 * as its note, and the rejection appended to `rejectedClaims`. The queued check results go
 * with the rejected claim; the claim itself stays as the latest claim, so the next
 * `action_review` lists the item (02 §5.1 `claimedSince`). Human-only (INV-03-07).
 */
export function rejectClaim(
  ctx: DomainContext,
  caller: Caller,
  item: ActionItem,
  reason: string,
): Outcome<ActionItem> {
  if (!isUser(caller)) throw humanRequired('Rejecting a claim', itemLink(item.ref));
  requireLifecycle(item, 'reject', ['claimed_done']);
  if (reason.trim() === '') {
    throw invariantError({ rule: '03 §7', message: 'rejecting a claim needs a reason' });
  }
  const now = ctx.clock.now();
  const previous = item.verification ?? { checks: [], rejectedClaims: [] };
  const next: ActionItem = {
    ...item,
    lifecycle: 'in_progress',
    health: 'at_risk',
    healthNote: `Claim rejected: ${reason}`,
    verification: {
      checks: [],
      rejectedClaims: [...previous.rejectedClaims, { at: now, by: caller.actor, reason }],
    },
  };
  const write = writeItem(ctx, caller, item, next, 'claim_rejected');
  return { status: 'ok', record: write.record, changes: [write] };
}
