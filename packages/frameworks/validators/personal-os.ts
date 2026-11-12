/** Validators of the personal-os invariants PO-1 to PO-5 (01 §5.1). */
import type { ValidatorDefinition, Violation } from './common.js';
import { activeSeries, intParameter, oneSeriesWithAgenda, openItems } from './common.js';

/** PO-1: exactly one active weekly review series covers the workstream; it may be shared. */
export const oneWeeklySeries: ValidatorDefinition = {
  reads: [],
  check(context) {
    const series = activeSeries(context.state, 'weekly');
    if (series.length === 1) return [];
    return [
      {
        message: `expected exactly one active weekly review series, found ${series.length}`,
        values: {
          workstreamId: context.state.workstreamId,
          seriesIds: series.map((s) => s.id),
        },
      },
    ];
  },
};

/** PO-2: 1 to maxGoals active goals per workstream per quarter. */
export const personalGoalCount: ValidatorDefinition = {
  reads: ['maxGoals'],
  check(context) {
    const max = intParameter(context, 'maxGoals');
    const active = context.state.goals.filter((goal) => goal.status === 'active');
    if (active.length >= 1 && active.length <= max) return [];
    return [
      {
        message: `expected 1 to ${max} active goals this quarter, found ${active.length}`,
        values: { activeGoals: active.length, maxGoals: max },
      },
    ];
  },
};

/** PO-3: every goal has a done-means or at least one measure. */
export const goalDoneMeansOrMeasure: ValidatorDefinition = {
  reads: [],
  check(context) {
    return context.state.goals
      .filter((goal) => goal.status === 'active')
      .filter((goal) => (goal.doneMeans ?? '').trim() === '' && goal.measureIds.length === 0)
      .map((goal): Violation => ({
        message: `goal ${goal.id} has neither a done-means nor a measure`,
        values: { goalId: goal.id },
      }));
  },
};

/** PO-4: the weekly review agenda order. */
export const personalWeeklyAgendaOrder: ValidatorDefinition = {
  reads: [],
  check(context) {
    return oneSeriesWithAgenda(context, 'weekly', 'weekly review', [
      'check_in',
      'scorecard',
      'goals_review',
      'action_review',
      'plan_commitments',
      'conclude',
    ]);
  },
};

/** PO-5: every action item has one owner and a due date. */
export const actionOwnerAndDue: ValidatorDefinition = {
  reads: [],
  check(context) {
    return openItems(context.state)
      .filter((item) => !item.ownerId || item.due === undefined)
      .map((item) => ({
        message: `action item ${item.id} needs one owner and a due date`,
        values: { actionItemId: item.id, ownerId: item.ownerId, due: item.due ?? null },
      }));
  },
};
