/**
 * Input resolution (02 §6.1). Each `InputQuery` of a section resolves against the current data
 * at pre-read time, with `RelativeTime` evaluated against the instance. Results carry minimal
 * fields (ref, title, owner, due, lifecycle, health, carry count, evidence status) plus counts,
 * so pre-reads stay small. Every row is tagged with its workstreams, so a merged meeting's
 * shared sections show where each row belongs (02 §4.4 rule 3).
 *
 * Readings where 02 is silent:
 * - `previous_instance` is the latest earlier instance of the same series that was held
 *   (`completed`), so a missed week's claims are still reviewed (its agenda carried in, 02 §4.2
 *   rule 2); its end is `actualEnd`, else `scheduledEnd`. `next_instance` is the earliest later
 *   one still to be held. With none, a `claimedSince` matches nothing and a `dueBefore` has no
 *   bound, and the query is flagged `no_previous_instance` or `no_next_instance`.
 * - An `action_items` query with no `lifecycle` lists accepted, unclosed items (open, in
 *   progress, waiting, claimed); with `claimedSince` it also lists verified ones, for the spot
 *   check of auto-verified claims (03 §9.2 step 4). Drafts and dropped items are never listed.
 * - Measure periods are read in the series' zone; the latest period a meeting reads is the one
 *   holding the day before its local start date (see `readPeriods`).
 * - `register_health` and `rhythm_health` windows run from the start of the month or quarter
 *   holding the instance's local start date to that date. A held meeting is "on time" when it
 *   started within 10 minutes of its scheduled start; an overrun ran past its scheduled length.
 * - `connector` inputs: with no binding named, or no connector host (P1 has none), the input is
 *   a flagged empty input (`connector_unbound`, `connector_unavailable`), never stale data
 *   presented as current (02 §6.1 rule 3).
 */
import { isDueBefore, isPastDue, registerHealth } from '@cc/domain';
import type {
  ActionItem,
  Decision,
  Evidence,
  Goal,
  InputQuery,
  Issue,
  Measure,
  MeasureValue,
  MeetingInstance,
  MeetingSeries,
  RelativeTime,
  Risk,
  Workstream,
} from '@cc/schemas';

import { dstCheckLine } from './dst.js';
import {
  addDays,
  compareInstants,
  isoWeekStart,
  localDate,
  minutesBetween,
  utc,
  zoned,
} from './time.js';

type WorkstreamId = MeetingSeries['workstreamIds'][number];

/** The attention categories of 02 §5.7, in their fixed order (owner decision Q6), then CC's own. */
export const ATTENTION_ORDER = [
  'confirmation',
  'session',
  'escalation',
  'development_request',
  'backup',
  'meetings',
  'dst_check',
] as const;
export type AttentionCategory = (typeof ATTENTION_ORDER)[number];

/** An attention entry from outside the records here: confirmations, sessions, requests, backups. */
export interface AttentionEntry {
  readonly category: AttentionCategory;
  readonly ref: string;
  readonly title: string;
  /** When the cause arose; oldest first within a category. */
  readonly since: string;
}

/** A connector read: rows, or a failure code. P1 has no connector host (P2). */
export type ConnectorReader = (
  query: Extract<InputQuery, { source: 'connector' }> & { bindingId: string },
) =>
  | {
      readonly ok: true;
      readonly rows: readonly { readonly ref: string; readonly title: string }[];
    }
  | { readonly ok: false; readonly code: string };

/** The data the inputs resolve against, read in one snapshot. */
export interface MeetingData {
  readonly workspaceTimeZone: string;
  readonly workstreams: readonly Workstream[];
  readonly actionItems: readonly ActionItem[];
  readonly evidence: readonly Evidence[];
  readonly measures: readonly Measure[];
  readonly measureValues: readonly MeasureValue[];
  readonly goals: readonly Goal[];
  readonly decisions: readonly Decision[];
  readonly issues: readonly Issue[];
  readonly risks: readonly Risk[];
  readonly series: readonly MeetingSeries[];
  /** Every instance of every series, for previous and next instances and rhythm health. */
  readonly instances: readonly MeetingInstance[];
  /** Attention entries the core gathers from confirmations, sessions, requests and backups. */
  readonly attention?: readonly AttentionEntry[];
  readonly connector?: ConnectorReader;
}

/** One row of a resolved input: the minimal fields of 02 §6.1 rule 2. */
export interface InputRow {
  readonly ref: string;
  readonly title: string;
  readonly workstreamIds: readonly string[];
  readonly ownerId?: string;
  /** Local due date. */
  readonly due?: string;
  readonly lifecycle?: string;
  readonly health?: string;
  readonly carryCount?: number;
  /** Required evidence: all there, some, none; or nothing required. */
  readonly evidence?: 'complete' | 'partial' | 'none' | 'not_required';
  readonly flags: readonly string[];
  /** Source-specific extras: measure values, statuses, ranks. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ResolvedInput {
  readonly queryId: string;
  readonly source: InputQuery['source'];
  readonly count: number;
  readonly rows: readonly InputRow[];
  readonly flags: readonly string[];
  readonly summary?: Readonly<Record<string, unknown>>;
}

/** What one section's inputs resolve against. */
export interface ResolveScope {
  readonly series: MeetingSeries;
  readonly instance: MeetingInstance;
  /** The section's workstreams: its own for a perWorkstream section, else the series'. */
  readonly workstreamIds: readonly WorkstreamId[];
  readonly data: MeetingData;
}

const ACCEPTED: ReadonlySet<ActionItem['lifecycle']> = new Set([
  'open',
  'in_progress',
  'waiting',
  'claimed_done',
]);
const WORKING: ReadonlySet<ActionItem['lifecycle']> = new Set(['open', 'in_progress', 'waiting']);
const NOT_HELD: ReadonlySet<MeetingInstance['state']> = new Set([
  'skipped',
  'absorbed',
  'cancelled',
]);
/** A held meeting started within this many minutes of its scheduled start is on time. */
export const ON_TIME_MINUTES = 10;

function sameSeries(scope: ResolveScope): MeetingInstance[] {
  return scope.data.instances
    .filter((other) => other.seriesId === scope.instance.seriesId && other.id !== scope.instance.id)
    .sort((a, b) => compareInstants(a.scheduledStart, b.scheduledStart));
}

/** The latest earlier held instance of the series. */
export function previousInstance(scope: ResolveScope): MeetingInstance | undefined {
  return sameSeries(scope)
    .filter(
      (other) =>
        other.state === 'completed' &&
        compareInstants(other.scheduledStart, scope.instance.scheduledStart) < 0,
    )
    .at(-1);
}

/** The earliest later instance of the series still to be held. */
export function nextInstance(scope: ResolveScope): MeetingInstance | undefined {
  return sameSeries(scope).find(
    (other) =>
      compareInstants(other.scheduledStart, scope.instance.scheduledStart) > 0 &&
      ['planned', 'scheduled', 'prepared', 'in_progress'].includes(other.state),
  );
}

/** A `RelativeTime` as a UTC timestamp, or undefined when its instance does not exist. */
export function resolveRelativeTime(time: RelativeTime, scope: ResolveScope): string | undefined {
  const { instance, series } = scope;
  switch (time) {
    case 'instance.start':
      return instance.scheduledStart;
    case 'instance.end':
      return instance.scheduledEnd;
    case 'previous_instance.end': {
      const previous = previousInstance(scope);
      return previous === undefined ? undefined : (previous.actualEnd ?? previous.scheduledEnd);
    }
    case 'next_instance.start':
      return nextInstance(scope)?.scheduledStart;
    default: {
      const match = /^instance\.start([+-])(\d+)d$/.exec(time);
      if (match === null) return undefined;
      const days = Number(match[2]) * (match[1] === '-' ? -1 : 1);
      return utc(zoned(instance.scheduledStart, series.timeZone).add({ days }).toInstant());
    }
  }
}

function scopeIds(scope: ResolveScope, value: 'meeting' | readonly string[]): Set<string> {
  return new Set(value === 'meeting' ? scope.workstreamIds : value);
}

function evidenceStatus(
  item: ActionItem,
  evidence: readonly Evidence[],
): NonNullable<InputRow['evidence']> {
  const required = item.evidenceRequirements.filter((r) => r.required);
  if (required.length === 0) return 'not_required';
  const checks = item.verification?.checks ?? [];
  const met = required.filter(
    (r) =>
      checks.some((c) => c.requirementId === r.id && c.status === 'pass') ||
      evidence.some((e) => e.actionItemId === item.id && e.requirementId === r.id),
  ).length;
  return met === required.length ? 'complete' : met === 0 ? 'none' : 'partial';
}

function itemRow(item: ActionItem, scope: ResolveScope, previousEnd?: string): InputRow {
  const flags: string[] = [];
  if (ACCEPTED.has(item.lifecycle) && isPastDue(item.due, scope.instance.scheduledStart)) {
    flags.push('overdue');
  }
  if (item.lifecycle === 'claimed_done') flags.push('claimed');
  if (item.escalationLevel > 0) flags.push(`escalation_${String(item.escalationLevel)}`);
  if (
    previousEnd !== undefined &&
    WORKING.has(item.lifecycle) &&
    compareInstants(item.updatedAt, previousEnd) <= 0
  ) {
    flags.push('update_needed');
  }
  return {
    ref: item.ref,
    title: item.title,
    workstreamIds: [item.workstreamId],
    ownerId: item.ownerId,
    due: item.due.date,
    lifecycle: item.lifecycle,
    health: item.health,
    carryCount: item.carryCount,
    evidence: evidenceStatus(item, scope.data.evidence),
    flags,
  };
}

function resolveActionItems(
  query: Extract<InputQuery, { source: 'action_items' }>,
  scope: ResolveScope,
): ResolvedInput {
  const { filter } = query;
  const ids = scopeIds(scope, filter.scope);
  const flags: string[] = [];
  const dueBefore =
    filter.dueBefore === undefined ? undefined : resolveRelativeTime(filter.dueBefore, scope);
  if (filter.dueBefore !== undefined && dueBefore === undefined) flags.push('no_next_instance');
  const since =
    filter.claimedSince === undefined ? undefined : resolveRelativeTime(filter.claimedSince, scope);
  if (filter.claimedSince !== undefined && since === undefined) flags.push('no_previous_instance');
  const lifecycles: ReadonlySet<ActionItem['lifecycle']> =
    filter.lifecycle !== undefined
      ? new Set(filter.lifecycle)
      : filter.claimedSince !== undefined
        ? new Set([...ACCEPTED, 'verified_done'])
        : ACCEPTED;
  const seriesInstances = new Set(
    scope.data.instances.filter((i) => i.seriesId === scope.series.id).map((i) => i.id as string),
  );
  const previous = previousInstance(scope);
  const previousEnd =
    previous === undefined ? undefined : (previous.actualEnd ?? previous.scheduledEnd);
  const matched = scope.data.actionItems
    .filter((item) => ids.has(item.workstreamId))
    .filter((item) => item.lifecycle !== 'draft' && item.lifecycle !== 'dropped')
    .filter((item) => lifecycles.has(item.lifecycle))
    .filter((item) => dueBefore === undefined || isDueBefore(item.due, dueBefore))
    .filter(
      (item) =>
        filter.claimedSince === undefined ||
        (since !== undefined &&
          item.claim !== undefined &&
          compareInstants(item.claim.at, since) > 0),
    )
    .filter(
      (item) =>
        filter.escalationAtLeast === undefined || item.escalationLevel >= filter.escalationAtLeast,
    )
    .filter((item) => filter.ownerIds === undefined || filter.ownerIds.includes(item.ownerId))
    .filter(
      (item) =>
        filter.sourceMeetingSeries !== true ||
        (item.source.kind === 'meeting' && seriesInstances.has(item.source.meetingId)),
    )
    .sort((a, b) => a.due.date.localeCompare(b.due.date) || a.ref.localeCompare(b.ref));
  const rows = (query.limit === undefined ? matched : matched.slice(0, query.limit)).map((item) =>
    itemRow(item, scope, previousEnd),
  );
  if (query.limit !== undefined && matched.length > query.limit) flags.push('truncated');
  return { queryId: query.id, source: query.source, count: matched.length, rows, flags };
}

/** The local start date of the period holding `date` (03 §5.4 `periodStart`). */
export function periodStartOf(cadence: Measure['cadence'], date: string): string {
  switch (cadence) {
    case 'daily':
      return date;
    case 'weekly':
      return isoWeekStart(date);
    case 'monthly':
      return `${date.slice(0, 7)}-01`;
    case 'quarterly': {
      const month = Number(date.slice(5, 7));
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return `${date.slice(0, 4)}-${String(first).padStart(2, '0')}-01`;
    }
  }
}

/**
 * The `count` periods a meeting on local `date` reads, oldest first. The latest is the period
 * holding the day before the meeting: the week a Friday review closes (the K-0003 week-46 value
 * of fixtures/records is read at the review of Fri 2026-11-13), the week just ended for a Monday
 * WIG session (X-5), yesterday for a daily measure.
 */
export function readPeriods(cadence: Measure['cadence'], date: string, count: number): string[] {
  let start = periodStartOf(cadence, addDays(date, -1));
  const out: string[] = [start];
  for (let n = 1; n < count; n++) {
    start = periodStartOf(cadence, addDays(start, -1));
    out.unshift(start);
  }
  return out;
}

function meetsTarget(measure: Measure, value: number | boolean): boolean {
  const { op, value: target, value2 } = measure.target;
  if (typeof value === 'boolean' || typeof target === 'boolean') return value === target;
  switch (op) {
    case 'gte':
      return value >= target;
    case 'lte':
      return value <= target;
    case 'eq':
      return value === target;
    case 'between':
      return value >= target && value <= (value2 ?? target);
  }
}

function resolveMeasures(
  query: Extract<InputQuery, { source: 'measures' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const date = localDate(scope.instance.scheduledStart, scope.series.timeZone);
  const flags = new Set<string>();
  const rows = scope.data.measures
    .filter((m) => m.active && m.workstreamIds.some((id) => ids.has(id)))
    .filter((m) => query.filter.role === undefined || m.role === query.filter.role)
    .sort((a, b) => a.scorecardOrder - b.scorecardOrder || a.ref.localeCompare(b.ref))
    .map((measure): InputRow => {
      const periods = readPeriods(measure.cadence, date, query.periods);
      const values = periods.map((periodStart) => {
        const found = scope.data.measureValues.find(
          (v) => v.measureId === measure.id && v.periodStart === periodStart,
        );
        return {
          periodStart,
          value: found?.value ?? null,
          normal: found?.normal ?? null,
        };
      });
      const latest = values.at(-1);
      const rowFlags: string[] = [];
      if (latest?.value === null || latest === undefined) {
        rowFlags.push('missing_value');
        if (measure.role === 'lead') flags.add('missing_lead_value');
      } else {
        if (latest.normal === false) rowFlags.push('not_normal');
        if (!meetsTarget(measure, latest.value)) rowFlags.push('off_target');
      }
      return {
        ref: measure.ref,
        title: measure.name,
        workstreamIds: measure.workstreamIds,
        ownerId: measure.ownerId,
        flags: rowFlags,
        detail: { role: measure.role, unit: measure.unit, target: measure.target, values },
      };
    });
  return {
    queryId: query.id,
    source: query.source,
    count: rows.length,
    rows,
    flags: [...flags],
  };
}

function resolveGoals(
  query: Extract<InputQuery, { source: 'goals' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const date = localDate(scope.instance.scheduledStart, scope.series.timeZone);
  const candidates = scope.data.goals.filter(
    (g) => ids.has(g.workstreamId) && g.status !== 'dropped',
  );
  let chosen: Goal[];
  switch (query.filter.period) {
    case 'current':
      chosen = candidates.filter((g) => g.period.start <= date && g.period.end >= date);
      break;
    case 'previous': {
      const before = candidates.filter((g) => g.period.end < date);
      const last = before.reduce((max, g) => (g.period.end > max ? g.period.end : max), '');
      chosen = before.filter((g) => g.period.end === last);
      break;
    }
    case 'next': {
      const after = candidates.filter((g) => g.period.start > date);
      const first = after.reduce(
        (min, g) => (min === '' || g.period.start < min ? g.period.start : min),
        '',
      );
      chosen = after.filter((g) => g.period.start === first);
      break;
    }
  }
  const rows = chosen
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((goal): InputRow => ({
      ref: goal.ref,
      title: goal.title,
      workstreamIds: [goal.workstreamId],
      ownerId: goal.ownerId,
      health: goal.health,
      flags: goal.health === 'on_track' ? [] : [goal.health],
      detail: {
        kind: goal.kind,
        status: goal.status,
        period: goal.period.label,
        ...(goal.grade === undefined ? {} : { grade: goal.grade }),
      },
    }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags: [] };
}

function resolveDecisions(
  query: Extract<InputQuery, { source: 'decisions' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const flags: string[] = [];
  const before =
    query.filter.dueBefore === undefined
      ? undefined
      : resolveRelativeTime(query.filter.dueBefore, scope);
  if (query.filter.dueBefore !== undefined && before === undefined) flags.push('no_next_instance');
  const beforeDate = before === undefined ? undefined : localDate(before, scope.series.timeZone);
  const rows = scope.data.decisions
    .filter((d) => ids.has(d.workstreamId) && query.filter.status.includes(d.status))
    .filter((d) => beforeDate === undefined || (d.dueBy !== undefined && d.dueBy < beforeDate))
    .sort(
      (a, b) => (a.dueBy ?? '9999').localeCompare(b.dueBy ?? '9999') || a.ref.localeCompare(b.ref),
    )
    .map((decision): InputRow => ({
      ref: decision.ref,
      title: decision.question,
      workstreamIds: [decision.workstreamId],
      ownerId: decision.deciderId,
      ...(decision.dueBy === undefined ? {} : { due: decision.dueBy }),
      flags: decision.reversibility === 'one_way' ? ['one_way'] : [],
      detail: { status: decision.status, reversibility: decision.reversibility },
    }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags };
}

function resolveIssues(
  query: Extract<InputQuery, { source: 'issues' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const rows = scope.data.issues
    .filter((i) => ids.has(i.workstreamId) && i.status === 'open')
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        compareInstants(a.createdAt, b.createdAt) ||
        a.ref.localeCompare(b.ref),
    )
    .map((issue): InputRow => ({
      ref: issue.ref,
      title: issue.title,
      workstreamIds: [issue.workstreamId],
      flags: issue.raisedFrom.kind === 'manual' ? [] : [`from_${issue.raisedFrom.kind}`],
      detail: {
        raisedFrom: issue.raisedFrom.kind,
        ...(issue.rank === undefined ? {} : { rank: issue.rank }),
      },
    }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags: [] };
}

function resolveRisks(
  query: Extract<InputQuery, { source: 'risks' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const statuses: readonly string[] = query.filter.status;
  const rows = scope.data.risks
    .filter((r) => ids.has(r.workstreamId) && statuses.includes(r.status))
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((risk): InputRow => ({
      ref: risk.ref,
      title: risk.description,
      workstreamIds: [risk.workstreamId],
      ownerId: risk.watcherId,
      flags: risk.status === 'triggered' ? ['triggered'] : [],
      detail: { status: risk.status, trigger: risk.trigger },
    }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags: [] };
}

/** The window from the start of the month or quarter holding `date` to `date`. */
export function windowTo(kind: 'month' | 'quarter', date: string): { start: string; end: string } {
  return { start: periodStartOf(kind === 'month' ? 'monthly' : 'quarterly', date), end: date };
}

function resolveRegisterHealth(
  query: Extract<InputQuery, { source: 'register_health' }>,
  scope: ResolveScope,
): ResolvedInput {
  const ids = scopeIds(scope, query.filter.scope);
  const date = localDate(scope.instance.scheduledStart, scope.series.timeZone);
  const window = windowTo(query.filter.window, date);
  const items = scope.data.actionItems.filter((item) => ids.has(item.workstreamId));
  const health = registerHealth(items, window, scope.instance.scheduledStart);
  const byRef = new Map(items.map((item) => [item.ref, item]));
  const flagged = new Map<string, string[]>();
  const mark = (ref: string, flag: string) => flagged.set(ref, [...(flagged.get(ref) ?? []), flag]);
  for (const ref of health.carriedTwiceOrMore) mark(ref, 'carried_twice');
  for (const ref of health.replannedTwiceOrMore) mark(ref, 'replanned_twice');
  if (health.oldestOpen !== undefined) mark(health.oldestOpen.ref, 'oldest_open');
  const rows = [...flagged.entries()].flatMap(([ref, flags]) => {
    const item = byRef.get(ref);
    return item === undefined ? [] : [{ ...itemRow(item, scope), flags }];
  });
  return {
    queryId: query.id,
    source: query.source,
    count: rows.length,
    rows,
    flags: [],
    summary: {
      window,
      closedOnTime: health.closedOnTime,
      verifiedShare: health.verifiedShare,
      rejectedClaims: health.rejectedClaims,
    },
  };
}

function resolveRhythmHealth(
  query: Extract<InputQuery, { source: 'rhythm_health' }>,
  scope: ResolveScope,
): ResolvedInput {
  const zone = scope.series.timeZone;
  const window = windowTo(query.filter.window, localDate(scope.instance.scheduledStart, zone));
  const seriesById = new Map(scope.data.series.map((s) => [s.id as string, s]));
  const totals = { due: 0, held: 0, heldOnTime: 0, missed: 0, skipped: 0, overruns: 0 };
  const perSeries = new Map<string, typeof totals>();
  for (const other of scope.data.instances) {
    if (other.id === scope.instance.id) continue;
    if (compareInstants(other.scheduledStart, scope.instance.scheduledStart) >= 0) continue;
    const date = localDate(other.scheduledStart, zone);
    if (date < window.start || date > window.end) continue;
    const counts = perSeries.get(other.seriesId) ?? {
      due: 0,
      held: 0,
      heldOnTime: 0,
      missed: 0,
      skipped: 0,
      overruns: 0,
    };
    if (other.state === 'skipped') counts.skipped++;
    if (NOT_HELD.has(other.state)) {
      perSeries.set(other.seriesId, counts);
      continue;
    }
    if (other.state !== 'completed' && other.state !== 'missed') continue;
    counts.due++;
    if (other.state === 'missed') counts.missed++;
    if (other.state === 'completed') {
      counts.held++;
      if (
        other.actualStart !== undefined &&
        minutesBetween(other.scheduledStart, other.actualStart) <= ON_TIME_MINUTES
      ) {
        counts.heldOnTime++;
      }
      if (
        other.actualStart !== undefined &&
        other.actualEnd !== undefined &&
        minutesBetween(other.actualStart, other.actualEnd) >
          minutesBetween(other.scheduledStart, other.scheduledEnd)
      ) {
        counts.overruns++;
      }
    }
    perSeries.set(other.seriesId, counts);
  }
  const rows = [...perSeries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([seriesId, counts]): InputRow => {
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += counts[key];
      return {
        ref: seriesId,
        title: seriesById.get(seriesId)?.name ?? seriesId,
        workstreamIds: seriesById.get(seriesId)?.workstreamIds ?? [],
        flags: counts.missed > 0 ? ['missed'] : [],
        detail: counts,
      };
    });
  return {
    queryId: query.id,
    source: query.source,
    count: rows.length,
    rows,
    flags: [],
    summary: { window, ...totals },
  };
}

/**
 * The attention list (02 §5.7): the categories in their fixed order, oldest first within each
 * (owner decision Q6). Escalations at level 2 or higher come from the items; today's other
 * meetings and their overlaps from the instances; the US daylight-saving check line from
 * dst.ts (ADR 0001 decision 8); the rest from `data.attention`.
 */
function resolveAttention(
  query: Extract<InputQuery, { source: 'attention' }>,
  scope: ResolveScope,
): ResolvedInput {
  const { data, instance } = scope;
  const zone = data.workspaceTimeZone;
  const today = localDate(instance.scheduledStart, zone);
  const entries: (AttentionEntry & { workstreamIds: readonly string[]; flags: string[] })[] = [
    ...(data.attention ?? []).map((entry) => ({ ...entry, workstreamIds: [], flags: [] })),
  ];
  for (const item of data.actionItems) {
    if (!ACCEPTED.has(item.lifecycle) || item.escalationLevel < 2) continue;
    entries.push({
      category: 'escalation',
      ref: item.ref,
      title: item.title,
      since: item.createdAt,
      workstreamIds: [item.workstreamId],
      flags: [`escalation_${String(item.escalationLevel)}`],
    });
  }
  const seriesById = new Map(data.series.map((s) => [s.id as string, s]));
  const todays = data.instances
    .filter(
      (other) =>
        other.id !== instance.id &&
        localDate(other.scheduledStart, zone) === today &&
        ['planned', 'scheduled', 'prepared', 'in_progress'].includes(other.state),
    )
    .sort((a, b) => compareInstants(a.scheduledStart, b.scheduledStart));
  for (const meeting of todays) {
    const overlaps = todays.some(
      (other) =>
        other.id !== meeting.id &&
        compareInstants(other.scheduledStart, meeting.scheduledEnd) < 0 &&
        compareInstants(meeting.scheduledStart, other.scheduledEnd) < 0,
    );
    const series = seriesById.get(meeting.seriesId);
    entries.push({
      category: 'meetings',
      ref: meeting.ref,
      title: `${series?.name ?? meeting.seriesId} at ${zoned(meeting.scheduledStart, zone).toPlainTime().toString({ smallestUnit: 'minute' })}`,
      since: meeting.scheduledStart,
      workstreamIds: series?.workstreamIds ?? [],
      flags: overlaps ? ['conflict'] : [],
    });
  }
  for (const workstream of data.workstreams) {
    if (workstream.status !== 'active') continue;
    const openItems = data.actionItems
      .filter((item) => item.workstreamId === workstream.id && WORKING.has(item.lifecycle))
      .map((item) => ({
        ref: item.ref,
        due: {
          date: item.due.date,
          timeZone: item.due.timeZone,
          ...(item.due.time === undefined ? {} : { time: item.due.time }),
        },
      }));
    const sessions = data.instances
      .filter((other) => seriesById.get(other.seriesId)?.workstreamIds.includes(workstream.id))
      .map((other) => ({ instanceId: other.id, start: other.scheduledStart }));
    const line = dstCheckLine({
      date: today,
      workspaceTimeZone: zone,
      workstream,
      openItems,
      sessions,
    });
    if (line === undefined) continue;
    entries.push({
      category: 'dst_check',
      ref: `dst:${workstream.id}:${line.window.transition}`,
      title: `US daylight-saving change on ${line.window.transition}: check times for ${workstream.name}`,
      since: utc(zoned(instance.scheduledStart, zone).toInstant()),
      workstreamIds: [workstream.id],
      flags: [],
    });
  }
  const rank = (category: AttentionCategory) => ATTENTION_ORDER.indexOf(category);
  const rows = entries
    .sort(
      (a, b) =>
        rank(a.category) - rank(b.category) ||
        compareInstants(a.since, b.since) ||
        a.ref.localeCompare(b.ref),
    )
    .map((entry): InputRow => ({
      ref: entry.ref,
      title: entry.title,
      workstreamIds: entry.workstreamIds,
      flags: entry.flags,
      detail: { category: entry.category, since: entry.since },
    }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags: [] };
}

function resolveConnector(
  query: Extract<InputQuery, { source: 'connector' }>,
  scope: ResolveScope,
): ResolvedInput {
  const empty = (flag: string): ResolvedInput => ({
    queryId: query.id,
    source: query.source,
    count: 0,
    rows: [],
    flags: [flag],
  });
  if (query.bindingId === undefined) return empty('connector_unbound');
  const reader = scope.data.connector;
  if (reader === undefined) return empty('connector_unavailable');
  const result = reader({ ...query, bindingId: query.bindingId });
  if (!result.ok) return empty(`connector_failed:${result.code}`);
  const rows = result.rows.map((row): InputRow => ({
    ref: row.ref,
    title: row.title,
    workstreamIds: [],
    flags: ['untrusted'],
  }));
  return { queryId: query.id, source: query.source, count: rows.length, rows, flags: [] };
}

/** Resolves one input query for one section of an instance (02 §6.1 rule 1). */
export function resolveInput(query: InputQuery, scope: ResolveScope): ResolvedInput {
  switch (query.source) {
    case 'action_items':
      return resolveActionItems(query, scope);
    case 'measures':
      return resolveMeasures(query, scope);
    case 'goals':
      return resolveGoals(query, scope);
    case 'decisions':
      return resolveDecisions(query, scope);
    case 'issues':
      return resolveIssues(query, scope);
    case 'risks':
      return resolveRisks(query, scope);
    case 'register_health':
      return resolveRegisterHealth(query, scope);
    case 'rhythm_health':
      return resolveRhythmHealth(query, scope);
    case 'attention':
      return resolveAttention(query, scope);
    case 'connector':
      return resolveConnector(query, scope);
  }
}
