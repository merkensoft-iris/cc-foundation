/**
 * Execution-plan rules the domain owns (03 §8.2, §8.3): mode derivation, step readiness, and
 * when the system claims an item. Running connector and agent steps is the step runner's job
 * (P2-05, P3-04); P1 records manual steps.
 */
import type { ActionItem, ExecutionPlan, ExecutionStep } from '@cc/schemas';

/** 03 §8.3: the plan's mode, derived from its performers, never set by hand. */
export function deriveMode(steps: readonly ExecutionStep[]): ExecutionPlan['mode'] {
  const kinds = new Set(steps.map((step) => step.performer.kind));
  const human = kinds.has('user') || kinds.has('person');
  const agent = kinds.has('agent') || kinds.has('external_agent');
  if (!kinds.has('connector') && !agent) return 'manual';
  if (kinds.size === 1 && kinds.has('connector')) return 'connector';
  if (agent && !human && !kinds.has('connector')) return 'agent';
  return 'mixed';
}

const DONE = new Set<ExecutionStep['status']>(['succeeded', 'skipped']);

/**
 * 03 §8.2 rule 1: a pending step becomes ready when every step it depends on succeeded or was
 * skipped. A draft item's steps stay pending (rule 2).
 */
export function refreshReadiness(item: Pick<ActionItem, 'lifecycle' | 'execution'>): ExecutionPlan {
  const steps = item.execution.steps;
  const statusOf = new Map(steps.map((step) => [step.id, step.status]));
  const refreshed = steps.map((step) =>
    item.lifecycle !== 'draft' &&
    step.status === 'pending' &&
    step.dependsOn.every((id) => DONE.has(statusOf.get(id) ?? 'pending'))
      ? { ...step, status: 'ready' as const }
      : step,
  );
  return { mode: deriveMode(refreshed), steps: refreshed };
}

/** A plan from steps given at creation: every step pending, the mode derived. */
export function newPlan(steps: readonly ExecutionStep[]): ExecutionPlan {
  return { mode: deriveMode(steps), steps: [...steps] };
}

/**
 * 03 §8.2 rule 6: the system claims the item (actor system:review) when every step that
 * satisfies a required evidence requirement has succeeded. False when no step satisfies one.
 */
export function readyForAutoClaim(item: ActionItem): boolean {
  const required = new Set(item.evidenceRequirements.filter((r) => r.required).map((r) => r.id));
  const producing = item.execution.steps.filter((step) =>
    step.satisfies.some((id) => required.has(id)),
  );
  return producing.length > 0 && producing.every((step) => step.status === 'succeeded');
}
