/** Validators of the 4dx invariants X-1 to X-5 (01 §5.2). */
import type { ValidatorDefinition, Violation } from './common.js';
import { daysBetween, intParameter, oneSeriesWithAgenda, openItems } from './common.js';

const activeWigs = (context: Parameters<ValidatorDefinition['check']>[0]) =>
  context.state.goals.filter((goal) => goal.kind === 'wig' && goal.status === 'active');

/** X-1: 1 or 2 active WIGs, each stated as from X to Y by a date. */
export const wigCountAndTarget: ValidatorDefinition = {
  reads: [],
  check(context) {
    const wigs = activeWigs(context);
    const violations: Violation[] = [];
    if (wigs.length < 1 || wigs.length > 2) {
      violations.push({
        message: `expected 1 or 2 active WIGs, found ${wigs.length}`,
        values: { activeWigs: wigs.length },
      });
    }
    for (const wig of wigs) {
      const target = wig.target;
      if (target === undefined || target.unit.trim() === '' || target.by === '') {
        violations.push({
          message: `WIG ${wig.id} needs target.from, target.to, target.unit and target.by`,
          values: { goalId: wig.id, target: target ?? null },
        });
      }
    }
    return violations;
  },
};

/** X-2: each WIG has 1 to leadMeasureCount lead measures and exactly one lag measure. */
export const wigMeasures: ValidatorDefinition = {
  reads: ['leadMeasureCount'],
  check(context) {
    const maxLead = intParameter(context, 'leadMeasureCount');
    const violations: Violation[] = [];
    for (const wig of activeWigs(context)) {
      const measures = context.state.measures.filter(
        (measure) => measure.active && wig.measureIds.includes(measure.id),
      );
      const lead = measures.filter((measure) => measure.role === 'lead');
      const lag = measures.filter((measure) => measure.role === 'lag');
      if (lead.length < 1 || lead.length > maxLead) {
        violations.push({
          message: `WIG ${wig.id} has ${lead.length} lead measures; expected 1 to ${maxLead}`,
          values: { goalId: wig.id, leadMeasureIds: lead.map((m) => m.id) },
        });
      }
      if (lag.length !== 1) {
        violations.push({
          message: `WIG ${wig.id} has ${lag.length} lag measures; expected exactly one`,
          values: { goalId: wig.id, lagMeasureIds: lag.map((m) => m.id) },
        });
      }
      for (const measure of lead) {
        if (measure.cadence !== 'weekly' || !measure.ownerId || !measure.target) {
          violations.push({
            message: `lead measure ${measure.id} needs a weekly cadence, one owner and a target`,
            values: { measureId: measure.id, cadence: measure.cadence },
          });
        }
      }
    }
    return violations;
  },
};

/** X-3: exactly one weekly WIG-session series, with the account → scoreboard → commit order. */
export const wigSessionSeries: ValidatorDefinition = {
  reads: [],
  check(context) {
    return oneSeriesWithAgenda(context, 'weekly', 'WIG session', [
      'action_review',
      'scorecard',
      'plan_commitments',
      'conclude',
    ]);
  },
};

/**
 * X-4: a commitment has one owner, is due within 7 days of being made and links to a WIG;
 * each owner holds at most commitmentsPerOwnerPerWeek open commitments.
 */
export const commitmentShape: ValidatorDefinition = {
  reads: ['commitmentsPerOwnerPerWeek'],
  check(context) {
    const perOwner = intParameter(context, 'commitmentsPerOwnerPerWeek');
    const wigIds = new Set(activeWigs(context).map((wig) => wig.id));
    const violations: Violation[] = [];
    const counts = new Map<string, number>();
    for (const item of openItems(context.state)) {
      if (item.ownerId) counts.set(item.ownerId, (counts.get(item.ownerId) ?? 0) + 1);
      const horizon =
        item.due === undefined ? Infinity : daysBetween(item.createdOn, item.due.date);
      const linked = item.goalIds.some((id) => wigIds.has(id));
      if (!item.ownerId || horizon > 7 || !linked) {
        violations.push({
          message: `commitment ${item.id} needs one owner, a due date within 7 days and a link to a WIG`,
          values: { actionItemId: item.id, horizonDays: horizon, linkedToWig: linked },
        });
      }
    }
    for (const [ownerId, count] of counts) {
      if (count > perOwner) {
        violations.push({
          message: `${ownerId} holds ${count} open commitments; at most ${perOwner}`,
          values: { ownerId, count, commitmentsPerOwnerPerWeek: perOwner },
        });
      }
    }
    return violations;
  },
};

/** X-5: before a session, every lead measure has last period's value or is flagged. */
export const leadMeasureValuesOrFlagged: ValidatorDefinition = {
  reads: [],
  check(context) {
    const preread = context.state.preread;
    if (preread === undefined) return [];
    return context.state.measures
      .filter((measure) => measure.active && measure.role === 'lead')
      .filter(
        (measure) =>
          !preread.leadMeasureIdsWithValue.includes(measure.id) &&
          !preread.flaggedMeasureIds.includes(measure.id),
      )
      .map((measure) => ({
        message: `lead measure ${measure.id} has no value for the period just ended and is not flagged`,
        values: { measureId: measure.id },
      }));
  },
};
