/**
 * Meeting series (02 §3, §4.5, §4.6). P1-07 takes series as explicit specs and validates,
 * places and stores them; composing them from the onboarding profile is P1-12's S6 (owner
 * decision, key p1-07-spec, 11 Nov 2026).
 *
 * A spec is checked before it is written:
 * - the RRULE against the ADR 0001 subset (decision 4), stored in CC's canonical form;
 * - the time zone by construction (decision 6);
 * - the cadence against the rule's frequency (below);
 * - the duration against the backbone meeting's bounds (`E_PARAM_BOUNDS`, C-01-04);
 * - absorbed cadences are lower than the series' own (02 §4.3);
 * - calendars: none, or exactly one primary (02 §9.6 rule 4);
 * - portfolio series (`portfolio.*`, 02 §4.5) cover every active workstream;
 * - placement (02 §4.6, C-02-07) over the 13 weeks from its start: never a hard block; a soft
 *   block or a time outside working hours only with a recorded confirmation.
 * DTSTART is synced to the first occurrence on or after `startsOn` (decision 5).
 */
import {
  change,
  created,
  DomainError,
  forbidden,
  invariantError,
  isSystem,
  isUser,
  touched,
  type Caller,
  type Change,
  type DomainContext,
  type Outcome,
} from '@cc/domain';
import type { BackboneMeeting, MeetingSeries } from '@cc/schemas';

import { CADENCE_RANK } from './absorb.js';
import { canonicalRule, firstOccurrenceOnOrAfter, requireRule } from './expand.js';
import { HORIZON_DAYS } from './horizon.js';
import {
  blockIntervals,
  checkPlacement,
  seriesIntervals,
  type PlacementConfirmation,
  type PlacementContext,
  type PlacementViolation,
} from './placement.js';
import { addDays, isValidTimeZone, localDate, startOfDay } from './time.js';

export const PORTFOLIO_KEYS = ['portfolio.daily-start', 'portfolio.daily-shutdown'] as const;

/** 02 §3 defaults. */
export const SERIES_DEFAULTS = {
  prereadLeadMinutes: 1440,
  dailyPrereadLeadMinutes: 30,
  reminderMinutes: [15],
  graceMinutes: 60,
} as const;

/** The fields of a series the caller supplies; the rest are derived or defaulted. */
export type SeriesSpec = Omit<
  MeetingSeries,
  | 'id'
  | 'dtstart'
  | 'status'
  | 'prereadLeadMinutes'
  | 'reminderMinutes'
  | 'graceMinutes'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'version'
> &
  Partial<Pick<MeetingSeries, 'prereadLeadMinutes' | 'reminderMinutes' | 'graceMinutes'>>;

export interface SeriesCheck {
  /** The local date the series starts on; DTSTART is the first occurrence on or after it. */
  readonly startsOn: string;
  /** The backbone meeting the series implements, for its duration bounds (none for portfolio). */
  readonly backbone?: Pick<BackboneMeeting, 'cadence' | 'durationMinutes'>;
  /** Every active workstream, for portfolio series (02 §4.5). */
  readonly activeWorkstreamIds: readonly string[];
  /** Working hours, protected blocks and the confirmations already recorded. */
  readonly placement: PlacementContext;
  /** Confirmations the user gives for this series as it is created or changed (02 §4.6). */
  readonly confirmed?: readonly Omit<PlacementConfirmation, 'seriesId'>[];
}

/** Whether a rule's frequency fits a cadence. */
function cadenceFits(series: Pick<MeetingSeries, 'cadence' | 'rrule'>): boolean {
  const rule = requireRule(series.rrule);
  const weekdays = rule.byDay.filter((d) => d.ordinal === undefined).length;
  switch (series.cadence) {
    case 'daily':
      return (
        (rule.freq === 'DAILY' && rule.interval === 1) ||
        (rule.freq === 'WEEKLY' && rule.interval === 1 && weekdays >= 2)
      );
    case 'weekly':
      return rule.freq === 'WEEKLY' && rule.interval === 1 && rule.byDay.length <= 1;
    case 'biweekly':
      return rule.freq === 'WEEKLY' && rule.interval === 2 && rule.byDay.length <= 1;
    case 'monthly':
      return rule.freq === 'MONTHLY' && rule.interval === 1;
    case 'quarterly':
      return (
        (rule.freq === 'MONTHLY' && rule.interval === 3) ||
        (rule.freq === 'YEARLY' && rule.interval === 1 && rule.byMonth.length === 4)
      );
    case 'yearly':
      return rule.freq === 'YEARLY' && rule.interval === 1 && rule.byMonth.length <= 1;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return a.length === b.length && b.every((x) => set.has(x)) && set.size === b.length;
}

function placementError(violation: PlacementViolation): DomainError {
  const at = violation.interval.start;
  switch (violation.kind) {
    case 'hard_block':
      return invariantError({
        rule: 'C-02-07',
        message: `the meeting at ${at} overlaps hard protected block ${violation.blockId}`,
      });
    case 'soft_block':
      return invariantError(
        {
          rule: '02 §4.6',
          message: `the meeting at ${at} overlaps soft protected block ${violation.blockId}`,
        },
        ['confirm the overlap for this series (reason soft_block), or move the meeting'],
      );
    case 'outside_working_hours':
      return invariantError(
        { rule: '02 §4.6', message: `the meeting at ${at} is outside working hours` },
        ['confirm the exception for this series (reason outside_working_hours), or move it'],
      );
    case 'overlap':
      return invariantError({
        rule: '02 §4.6',
        message: `the meeting at ${at} overlaps another CC meeting`,
      });
  }
}

/**
 * Checks a series and returns it with its canonical rule and synced DTSTART. Throws
 * `E_INVARIANT` or `E_PARAM_BOUNDS` naming the rule.
 */
export function checkSeries(series: MeetingSeries, check: SeriesCheck): MeetingSeries {
  const rrule = canonicalRule(series.rrule);
  if (!isValidTimeZone(series.timeZone)) {
    throw invariantError({
      rule: 'ADR 0001 decision 6',
      message: `"${series.timeZone}" is not a time zone`,
    });
  }
  if (!cadenceFits({ cadence: series.cadence, rrule })) {
    throw invariantError({
      rule: '02 §3',
      message: `the rule ${rrule.split('\n')[0] ?? ''} does not repeat ${series.cadence}`,
    });
  }
  if (check.backbone !== undefined) {
    const { min, max } = check.backbone.durationMinutes;
    if (series.durationMinutes < min || series.durationMinutes > max) {
      throw new DomainError(
        'E_PARAM_BOUNDS',
        'C-01-04',
        `durationMinutes ${series.durationMinutes} is outside ${min} to ${max}`,
        [`${series.backboneMeetingKey}.duration: ${min} to ${max}`],
      );
    }
  }
  for (const entry of series.absorbs) {
    if (CADENCE_RANK[entry.cadence] >= CADENCE_RANK[series.cadence]) {
      throw invariantError({
        rule: '02 §4.3',
        message: `a ${series.cadence} meeting cannot absorb a ${entry.cadence} one`,
      });
    }
  }
  const primaries = series.calendars.filter((c) => c.role === 'primary').length;
  if (series.calendars.length > 0 && primaries !== 1) {
    throw invariantError({
      rule: '02 §9.6',
      message: `a series with calendars has exactly one primary target, not ${primaries}`,
    });
  }
  if (
    (PORTFOLIO_KEYS as readonly string[]).includes(series.backboneMeetingKey) &&
    !sameSet(series.workstreamIds, check.activeWorkstreamIds)
  ) {
    throw invariantError({
      rule: '02 §4.5',
      message: `${series.backboneMeetingKey} covers every active workstream`,
    });
  }
  const dtstart = firstOccurrenceOnOrAfter(rrule, series.timeZone, check.startsOn);
  if (dtstart === undefined) {
    throw invariantError({
      rule: 'ADR 0001 decision 5',
      message: `the rule has no occurrence on or after ${check.startsOn}`,
    });
  }
  const next: MeetingSeries = { ...series, rrule, dtstart };
  const from = startOfDay(dtstart.slice(0, 10), series.timeZone);
  const to = startOfDay(addDays(dtstart.slice(0, 10), HORIZON_DAYS), series.timeZone);
  const intervals = seriesIntervals([next], from, to);
  const placement: PlacementContext = {
    ...check.placement,
    confirmations: [
      ...check.placement.confirmations,
      ...(check.confirmed ?? []).map((c) => ({ ...c, seriesId: series.id })),
    ],
  };
  const violations = checkPlacement(
    placement,
    intervals,
    blockIntervals(check.placement.protectedBlocks, from, to),
  ).filter((v) => v.kind !== 'overlap');
  const [first] = violations;
  if (first !== undefined) throw placementError(first);
  return next;
}

function seriesChange(
  ctx: DomainContext,
  caller: Caller,
  before: MeetingSeries | undefined,
  after: MeetingSeries,
  verb: string,
): Change<MeetingSeries> {
  return change(ctx, {
    kind: 'meeting_series',
    verb,
    entity: { id: after.id },
    before,
    after,
    actor: caller.actor,
  });
}

function requireWriter(caller: Caller): void {
  if (!isUser(caller) && !isSystem(caller)) {
    throw forbidden('02 §4.1', 'series are set by the user (onboarding or settings)');
  }
}

/** Creates a series from a spec (02 §3 defaults applied). Materialise it afterwards. */
export function createSeries(
  ctx: DomainContext,
  caller: Caller,
  spec: SeriesSpec,
  check: SeriesCheck,
): Outcome<MeetingSeries> {
  requireWriter(caller);
  const draft: MeetingSeries = {
    ...spec,
    id: ctx.ids.id('ser'),
    dtstart: `${check.startsOn}T00:00`,
    status: 'active',
    prereadLeadMinutes:
      spec.prereadLeadMinutes ??
      (spec.cadence === 'daily'
        ? SERIES_DEFAULTS.dailyPrereadLeadMinutes
        : SERIES_DEFAULTS.prereadLeadMinutes),
    reminderMinutes: spec.reminderMinutes ?? [...SERIES_DEFAULTS.reminderMinutes],
    graceMinutes: spec.graceMinutes ?? SERIES_DEFAULTS.graceMinutes,
    ...created(ctx, caller.actor),
  };
  const series = checkSeries(draft, check);
  return {
    status: 'ok',
    record: series,
    changes: [seriesChange(ctx, caller, undefined, series, 'created')],
  };
}

/**
 * Changes a series (time, duration, agenda, ...). DTSTART is re-synced from the later of today
 * and the old first day; materialising afterwards rewrites only future instances in `planned`,
 * `scheduled` or `prepared` (02 §4.1 rule 3).
 */
export function updateSeries(
  ctx: DomainContext,
  caller: Caller,
  series: MeetingSeries,
  patch: Partial<SeriesSpec>,
  check: Omit<SeriesCheck, 'startsOn'>,
): Outcome<MeetingSeries> {
  requireWriter(caller);
  const today = localDate(ctx.clock.now(), series.timeZone);
  const first = series.dtstart.slice(0, 10);
  const startsOn = today > first ? today : first;
  const next = checkSeries({ ...series, ...patch }, { ...check, startsOn });
  if (JSON.stringify(next) === JSON.stringify(series)) {
    return { status: 'no-op', record: series, changes: [] };
  }
  const record = { ...next, ...auditOf(touched(ctx, series, caller.actor)) };
  return { status: 'ok', record, changes: [seriesChange(ctx, caller, series, record, 'updated')] };
}

/** Pauses, resumes or ends a series. Ending cancels its future planned and scheduled instances. */
export function setSeriesStatus(
  ctx: DomainContext,
  caller: Caller,
  series: MeetingSeries,
  status: MeetingSeries['status'],
): Outcome<MeetingSeries> {
  requireWriter(caller);
  if (series.status === status) return { status: 'no-op', record: series, changes: [] };
  if (series.status === 'ended') {
    throw invariantError({ rule: '02 §3', message: 'an ended series stays ended' });
  }
  const record = { ...touched(ctx, series, caller.actor), status };
  return {
    status: 'ok',
    record,
    changes: [seriesChange(ctx, caller, series, record, status === 'active' ? 'resumed' : status)],
  };
}

function auditOf(record: MeetingSeries) {
  return {
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    version: record.version,
  };
}
