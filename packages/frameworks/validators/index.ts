/**
 * The validator registry: every function an `Invariant.validator` may name (01 §4). A template
 * or fork can only name validators in this registry; new ones are added here, scaffolded by
 * `pnpm cc:new-template`.
 */
import type { ValidatorDefinition } from './common.js';
import {
  actionReviewDoneOrNotDone,
  decisionSingleDecider,
  issueResolutionOutcome,
  monthlyRegisterHealth,
  priorityCountAndShape,
  scorecardSize,
  todoHorizon,
  weeklyLeadershipMeeting,
} from './eos-lite.js';
import {
  commitmentShape,
  leadMeasureValuesOrFlagged,
  wigCountAndTarget,
  wigMeasures,
  wigSessionSeries,
} from './four-dx.js';
import {
  actionOwnerAndDue,
  goalDoneMeansOrMeasure,
  oneWeeklySeries,
  personalGoalCount,
  personalWeeklyAgendaOrder,
} from './personal-os.js';

export type { ValidatorContext, ValidatorDefinition, Violation } from './common.js';

export const validators: Readonly<Record<string, ValidatorDefinition>> = {
  // personal-os
  oneWeeklySeries,
  personalGoalCount,
  goalDoneMeansOrMeasure,
  personalWeeklyAgendaOrder,
  actionOwnerAndDue,
  // 4dx
  wigCountAndTarget,
  wigMeasures,
  wigSessionSeries,
  commitmentShape,
  leadMeasureValuesOrFlagged,
  // eos-lite
  weeklyLeadershipMeeting,
  scorecardSize,
  priorityCountAndShape,
  todoHorizon,
  actionReviewDoneOrNotDone,
  issueResolutionOutcome,
  decisionSingleDecider,
  monthlyRegisterHealth,
};
