/**
 * Editing a goal outside any meeting (03 §5.3, owner decision Q2, 10 Nov 2026): goals are
 * editable any time on the Scorecard's Goals tab, and every change is logged as one
 * `goal.updated` event with the changed fields before and after and the actor (INV-03-09). The
 * goal's invariants run on every change (INV-03-03; C-01-03 for the template's).
 */
import type { Goal } from '@cc/schemas';

import type { Caller, DomainContext } from './context.js';
import { isUser } from './context.js';
import { assertNoViolations, humanRequired } from './errors.js';
import { change, omitKeys, touched, type Outcome } from './events.js';
import { checkGoal } from './invariants.js';

/** The fields the Goals tab edits. */
export interface GoalEdit {
  readonly title?: string;
  readonly doneMeans?: string;
  readonly target?: NonNullable<Goal['target']>;
  readonly health?: { readonly value: Goal['health']; readonly note?: string };
}

/**
 * Applies an edit to a goal. The user only: the Goals tab is in the app (owner decision Q2).
 * The same values again change nothing (`no-op`, no event).
 */
export function updateGoal(
  ctx: DomainContext,
  caller: Caller,
  goal: Goal,
  edit: GoalEdit,
): Outcome<Goal> {
  if (!isUser(caller)) {
    throw humanRequired('Editing a goal', 'commandcenter://');
  }
  let next: Goal = {
    ...goal,
    ...(edit.title === undefined ? {} : { title: edit.title }),
    ...(edit.doneMeans === undefined ? {} : { doneMeans: edit.doneMeans }),
    ...(edit.target === undefined ? {} : { target: edit.target }),
  };
  if (edit.health !== undefined) {
    next = omitKeys({ ...next, health: edit.health.value }, 'healthNote');
    if (edit.health.note !== undefined) next = { ...next, healthNote: edit.health.note };
  }
  if (JSON.stringify(next) === JSON.stringify(goal)) {
    return { status: 'no-op', record: goal, changes: [] };
  }
  assertNoViolations(checkGoal(next));
  const record = touched(ctx, next, caller.actor);
  return {
    status: 'ok',
    record,
    changes: [
      change(ctx, {
        kind: 'goal',
        verb: 'updated',
        entity: { id: record.id, ref: record.ref },
        before: goal,
        after: record,
        actor: caller.actor,
      }),
    ],
  };
}
