/** Validators of the eos-lite invariants E-1 to E-8 (01 §5.3). */
import type { ValidatorDefinition, Violation } from './common.js';
import {
  activeSeries,
  daysBetween,
  hasFixedWeekdayAndTime,
  intParameter,
  oneSeriesWithAgenda,
  openItems,
} from './common.js';

/**
 * E-1: exactly one weekly leadership meeting per workstream, or one block for it in a merged
 * meeting (02 §4.4), at a fixed weekday and time, in the backbone agenda order.
 */
export const weeklyLeadershipMeeting: ValidatorDefinition = {
  reads: [],
  check(context) {
    const violations = oneSeriesWithAgenda(context, 'weekly', 'weekly leadership meeting', [
      'check_in',
      'scorecard',
      'goals_review',
      'action_review',
      'headlines',
      'issues',
      'conclude',
    ]);
    for (const series of activeSeries(context.state, 'weekly')) {
      if (!hasFixedWeekdayAndTime(series.rrule)) {
        violations.push({
          message: `weekly leadership meeting ${series.id} needs a fixed weekday and time`,
          values: { seriesId: series.id, rrule: series.rrule },
        });
      }
    }
    return violations;
  },
};

/** E-2: 5 to 15 active weekly scorecard lines (solo: 3 to 15), each with an owner and a target. */
export const scorecardSize: ValidatorDefinition = {
  reads: [],
  check(context) {
    const min = context.mode === 'solo' ? 3 : 5;
    const lines = context.state.measures.filter(
      (measure) => measure.active && measure.cadence === 'weekly',
    );
    const violations: Violation[] = [];
    if (lines.length < min || lines.length > 15) {
      violations.push({
        message: `the scorecard has ${lines.length} active weekly lines; expected ${min} to 15 (${context.mode} mode)`,
        values: { lines: lines.length, min, max: 15 },
      });
    }
    for (const line of lines) {
      if (!line.ownerId || !line.target) {
        violations.push({
          message: `scorecard line ${line.id} needs one owner and a target`,
          values: { measureId: line.id },
        });
      }
    }
    return violations;
  },
};

/** E-3: 1 to priorityCount priorities, each with an owner and a done-means, graded 1 or 0. */
export const priorityCountAndShape: ValidatorDefinition = {
  reads: ['priorityCount'],
  check(context) {
    const max = intParameter(context, 'priorityCount');
    const priorities = context.state.goals.filter((goal) => goal.kind === 'priority');
    const active = priorities.filter((goal) => goal.status === 'active');
    const violations: Violation[] = [];
    if (active.length < 1 || active.length > max) {
      violations.push({
        message: `expected 1 to ${max} active priorities, found ${active.length}`,
        values: { activePriorities: active.length, priorityCount: max },
      });
    }
    for (const goal of active) {
      if (!goal.ownerId || (goal.doneMeans ?? '').trim() === '') {
        violations.push({
          message: `priority ${goal.id} needs one owner and a done-means`,
          values: { goalId: goal.id },
        });
      }
    }
    for (const goal of priorities) {
      if (goal.status !== 'active' && goal.status !== 'dropped' && goal.grade !== undefined) {
        if (goal.grade !== 0 && goal.grade !== 1) {
          violations.push({
            message: `priority ${goal.id} is graded ${goal.grade}; a priority is done (1) or not done (0)`,
            values: { goalId: goal.id, grade: goal.grade },
          });
        }
      }
    }
    return violations;
  },
};

/** E-4: each to-do has an owner, a done-means and a due date within todoHorizonDays, unless it links to a priority. */
export const todoHorizon: ValidatorDefinition = {
  reads: ['todoHorizonDays'],
  check(context) {
    const horizon = intParameter(context, 'todoHorizonDays');
    return openItems(context.state)
      .filter((item) => item.kind === 'todo')
      .flatMap((item): Violation[] => {
        const days = item.due === undefined ? Infinity : daysBetween(item.createdOn, item.due.date);
        const linked = item.goalIds.length > 0;
        if (item.ownerId && item.doneMeans.trim() !== '' && (days <= horizon || linked)) {
          return [];
        }
        return [
          {
            message: `to-do ${item.id} needs one owner, a done-means and a due date within ${horizon} days, or a link to a priority`,
            values: { actionItemId: item.id, dueInDays: days, todoHorizonDays: horizon },
          },
        ];
      });
  },
};

/** E-5: action_review records only done or not done. */
export const actionReviewDoneOrNotDone: ValidatorDefinition = {
  reads: [],
  check(context) {
    return (context.state.actionReview ?? [])
      .filter((entry) => entry.outcome !== 'done' && entry.outcome !== 'not_done')
      .map((entry) => ({
        message: `action_review recorded "${entry.outcome}" for ${entry.actionItemId}; only done or not done`,
        values: { actionItemId: entry.actionItemId, outcome: entry.outcome },
      }));
  },
};

/** E-6: a resolved issue ends as a decision, action items, or a drop with a note. */
export const issueResolutionOutcome: ValidatorDefinition = {
  reads: [],
  check(context) {
    return (context.state.issues ?? [])
      .filter((issue) => issue.status !== 'open')
      .flatMap((issue): Violation[] => {
        const resolution = issue.resolution;
        const ended =
          resolution !== undefined &&
          (resolution.kind === 'dropped'
            ? issue.status === 'dropped' && resolution.note.trim() !== ''
            : resolution.refs.length > 0);
        if (ended) return [];
        return [
          {
            message: `issue ${issue.id} must end as a decision, action items or a drop with a note`,
            values: { issueId: issue.id, resolution: resolution ?? null },
          },
        ];
      });
  },
};

/** E-7: every decision has exactly one decider. */
export const decisionSingleDecider: ValidatorDefinition = {
  reads: [],
  check(context) {
    return (context.state.decisions ?? [])
      .filter((decision) => (decision.deciderId ?? '') === '')
      .map((decision) => ({
        message: `decision ${decision.id} has no decider`,
        values: { decisionId: decision.id },
      }));
  },
};

/** E-8: the monthly review includes register health. */
export const monthlyRegisterHealth: ValidatorDefinition = {
  reads: [],
  check(context) {
    return activeSeries(context.state, 'monthly')
      .filter((series) => !series.agenda.includes('register_health'))
      .map((series) => ({
        message: `monthly review ${series.id} has no register_health section`,
        values: { seriesId: series.id, agenda: series.agenda },
      }));
  },
};
