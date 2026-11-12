/**
 * The invariants of docs/design/03-decisions-and-action-items.md §6, as checks that return the
 * rules a record breaks. The commands run them on every write and refuse it with `E_INVARIANT`
 * and the rule ID. INV-03-07 (who may do what) is enforced by each command, INV-03-09 (one
 * event per write) by `change()` in events.ts, and INV-03-05's "never hard-deleted" by there
 * being no delete command.
 */
import type {
  ActionItem,
  Decision,
  ExecutionStep,
  Goal,
  Issue,
  MeasureValue,
  Privacy,
} from '@cc/schemas';

import type { Registry } from './context.js';
import type { Violation } from './errors.js';

function blank(text: string | undefined): boolean {
  return text === undefined || text.trim() === '';
}

/** INV-03-01: exactly one owner, and it is a Person (never an agent or a connector). */
export function checkOwner(item: ActionItem, registry: Registry): Violation[] {
  return registry.person(item.ownerId) === undefined
    ? [{ rule: 'INV-03-01', message: `owner ${item.ownerId} is not a person in this workspace` }]
    : [];
}

/** INV-03-03: a health other than on_track carries a note. Goals too. */
export function checkHealthNote(
  record: Pick<ActionItem | Goal, 'health' | 'healthNote'>,
): Violation[] {
  return record.health !== 'on_track' && blank(record.healthNote)
    ? [{ rule: 'INV-03-03', message: `health ${record.health} needs a healthNote` }]
    : [];
}

/** INV-03-04: outside draft, a title, done-means, due date and one required requirement. */
export function checkCommitment(item: ActionItem): Violation[] {
  if (item.lifecycle === 'draft') return [];
  const out: Violation[] = [];
  const missing = (field: string) =>
    out.push({ rule: 'INV-03-04', message: `an item outside draft needs ${field}` });
  if (blank(item.title)) missing('a title');
  if (blank(item.doneMeans)) missing('doneMeans');
  if (blank(item.due.date)) missing('a due date');
  if (!item.evidenceRequirements.some((requirement) => requirement.required)) {
    missing('at least one required evidence requirement');
  }
  return out;
}

/** INV-03-05: dropped carries a dropReason. */
export function checkDropReason(record: { dropReason?: string | undefined }): Violation[] {
  return blank(record.dropReason)
    ? [{ rule: 'INV-03-05', message: 'dropped needs a dropReason' }]
    : [];
}

/**
 * INV-03-06: verified_done carries a decided verification record. For `auto`, every required
 * requirement has a `pass` check, the policy is auto_close_on_checks and the review job
 * decided (C-03-02); for `confirmed` and `attested` the user decided; `attested` has a note.
 * A method is set only on a verified item.
 */
export function checkVerification(item: ActionItem): Violation[] {
  const v = item.verification;
  const fail = (message: string): Violation[] => [{ rule: 'INV-03-06', message }];
  if (item.lifecycle !== 'verified_done') {
    return v?.method === undefined
      ? []
      : fail('only a verified_done item has a verification method');
  }
  if (v?.method === undefined || v.decidedBy === undefined || v.decidedAt === undefined) {
    return fail('verified_done needs a verification record with method, decidedBy and decidedAt');
  }
  if (v.method === 'auto') {
    if (item.verificationPolicy !== 'auto_close_on_checks') {
      return fail('method auto needs verificationPolicy auto_close_on_checks');
    }
    if (v.decidedBy.kind !== 'system' || v.decidedBy.component !== 'review') {
      return fail('method auto is decided by system:review only (C-03-02)');
    }
    const unpassed = item.evidenceRequirements
      .filter((requirement) => requirement.required)
      .filter(
        (requirement) =>
          !v.checks.some(
            (check) => check.requirementId === requirement.id && check.status === 'pass',
          ),
      );
    if (unpassed.length > 0) {
      return fail(`method auto needs a pass check for ${unpassed.map((r) => r.id).join(', ')}`);
    }
    return [];
  }
  if (v.decidedBy.kind !== 'user') return fail(`method ${v.method} is decided by the user only`);
  if (v.method === 'attested' && blank(v.attestationNote)) {
    return fail('method attested needs an attestationNote');
  }
  return [];
}

/**
 * INV-03-08: an agent step has a budget and a tool allowlist (the schema requires both); a
 * connector step names an action of the bound connector's installed manifest. Its risk class
 * comes from that manifest: steps have no risk-class field to set.
 */
export function checkSteps(steps: readonly ExecutionStep[], registry: Registry): Violation[] {
  const out: Violation[] = [];
  for (const step of steps) {
    const performer = step.performer;
    if (
      performer.kind === 'connector' &&
      !registry.connectorHasAction(performer.bindingId, performer.action)
    ) {
      out.push({
        rule: 'INV-03-08',
        message: `step ${step.id}: ${performer.bindingId} has no installed action ${performer.action}`,
      });
    }
  }
  return out;
}

const PRIVACY_RANK: Record<Privacy, number> = { normal: 0, sensitive: 1 };

/**
 * INV-03-10, the part a write can break: an item's privacy is at least its workstream's, and
 * once raised it is never lowered (03 §5.7), so sensitive content keeps its protection.
 */
export function checkPrivacy(
  item: ActionItem,
  registry: Registry,
  previous: ActionItem | undefined,
): Violation[] {
  const out: Violation[] = [];
  const workstream = registry.workstream(item.workstreamId);
  if (workstream !== undefined && PRIVACY_RANK[item.privacy] < PRIVACY_RANK[workstream.privacy]) {
    out.push({
      rule: 'INV-03-10',
      message: `privacy ${item.privacy} is below the workstream's ${workstream.privacy}`,
    });
  }
  if (previous !== undefined && PRIVACY_RANK[item.privacy] < PRIVACY_RANK[previous.privacy]) {
    out.push({ rule: 'INV-03-10', message: 'privacy may only be raised' });
  }
  return out;
}

/**
 * Every invariant of an action item that a write can break: INV-03-01, -03, -04, -05, -06,
 * -08 (when the plan is new or changed, or the item leaves draft), -10 and the framework
 * validators of INV-03-12.
 */
export function checkActionItem(
  item: ActionItem,
  registry: Registry,
  now: string,
  previous?: ActionItem,
): Violation[] {
  const planChanged =
    previous === undefined ||
    previous.lifecycle === 'draft' ||
    JSON.stringify(previous.execution.steps.map(({ performer }) => performer)) !==
      JSON.stringify(item.execution.steps.map(({ performer }) => performer));
  return [
    ...checkOwner(item, registry),
    ...checkHealthNote(item),
    // A draft discarded straight from draft never became a commitment (03 §7 `draft → dropped`).
    ...(item.lifecycle === 'dropped' && previous?.lifecycle === 'draft'
      ? []
      : checkCommitment(item)),
    ...(item.lifecycle === 'dropped' ? checkDropReason(item) : []),
    ...checkVerification(item),
    ...(planChanged ? checkSteps(item.execution.steps, registry) : []),
    ...checkPrivacy(item, registry, previous),
    ...registry.validators(item.workstreamId).flatMap((validate) => validate(item, now)),
  ];
}

/** INV-03-02: the decider is a person; agents propose and recommend but never decide. */
export function checkDecision(decision: Decision, registry: Registry): Violation[] {
  const out: Violation[] = [];
  if (registry.person(decision.deciderId) === undefined) {
    out.push({
      rule: 'INV-03-02',
      message: `decider ${decision.deciderId} is not a person in this workspace`,
    });
  }
  if (decision.status === 'decided' && decision.outcome === undefined) {
    out.push({ rule: '03 §10', message: 'a decided decision has an outcome' });
  }
  if (decision.status === 'dropped' && blank(decision.dropReason)) {
    out.push({ rule: '03 §10', message: 'a dropped decision needs a dropReason' });
  }
  return out;
}

/** INV-03-03 for goals. */
export function checkGoal(goal: Goal): Violation[] {
  return checkHealthNote(goal);
}

/**
 * INV-03-11: a resolved issue references at least one decision or action item, or is
 * resolved as `replan` or `dropped` with a note. A dropped issue carries its note too (E-6).
 */
export function checkIssue(issue: Issue): Violation[] {
  const r = issue.resolution;
  const fail = (message: string): Violation[] => [{ rule: 'INV-03-11', message }];
  if (issue.status === 'open')
    return r === undefined ? [] : fail('an open issue has no resolution');
  if (r === undefined) return fail(`a ${issue.status} issue needs a resolution`);
  if (r.kind === 'replan' || r.kind === 'dropped') {
    return blank(r.note) ? fail(`resolution ${r.kind} needs a note`) : [];
  }
  return r.refs.length === 0
    ? fail(`resolution ${r.kind} references a decision or action item`)
    : [];
}

/** A measure value read as not normal carries a note (03 §5.4). */
export function checkMeasureValue(value: MeasureValue): Violation[] {
  return value.normal === false && blank(value.note)
    ? [{ rule: '03 §5.4', message: 'a value read as not normal needs a note' }]
    : [];
}
