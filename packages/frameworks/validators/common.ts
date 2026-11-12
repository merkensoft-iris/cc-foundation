/**
 * Shared parts of the invariant validators (01 §4 `Invariant.validator`): the validator
 * contract and helpers. Validators are pure functions of an InstanceState (D4).
 */
import type { FrameworkMode, FrameworkTemplate } from '@cc/schemas';

import type { ActionItemView, AgendaSectionType, InstanceState, SeriesView } from '../src/state.js';

/** One broken rule, with the values that break it. */
export interface Violation {
  readonly message: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ValidatorContext {
  readonly template: FrameworkTemplate;
  readonly state: InstanceState;
  readonly mode: FrameworkMode;
  /** The instance's parameters with the template defaults filled in. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ValidatorDefinition {
  /** Parameters the validator reads; a template that names it must declare them. */
  readonly reads: readonly string[];
  readonly check: (context: ValidatorContext) => Violation[];
}

/** Lifecycle states of an item that is still to be done (03 §7). */
const OPEN = new Set(['open', 'in_progress', 'waiting', 'claimed_done']);

export function openItems(state: InstanceState): ActionItemView[] {
  return (state.actionItems ?? []).filter((item) => OPEN.has(item.lifecycle));
}

/** Active series of one backbone meeting that carry this instance's workstream. */
export function activeSeries(state: InstanceState, meetingKey: string): SeriesView[] {
  return state.series.filter(
    (series) =>
      series.status === 'active' &&
      series.backboneMeetingKey === meetingKey &&
      series.workstreamIds.includes(state.workstreamId),
  );
}

/**
 * Whether the agenda holds every required section in the required order. Other sections
 * (pack sections in extension slots, repeated perWorkstream blocks of a merged series, 02
 * §4.4) may sit between them.
 */
export function agendaOrderProblem(
  agenda: readonly AgendaSectionType[],
  required: readonly AgendaSectionType[],
): string | undefined {
  const missing = required.filter((type) => !agenda.includes(type));
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  let rank = 0;
  for (const type of agenda) {
    const index = required.indexOf(type);
    if (index < 0) continue;
    if (index < rank) return `${type} comes after ${required[rank] ?? ''}`;
    rank = index;
  }
  return undefined;
}

/** Whether an RRULE fixes one weekday and a time: FREQ=WEEKLY, one BYDAY, BYHOUR and BYMINUTE. */
export function hasFixedWeekdayAndTime(rrule: string): boolean {
  const parts = new Map(
    rrule.split(';').map((part) => {
      const [name = '', value = ''] = part.split('=');
      return [name.toUpperCase(), value] as const;
    }),
  );
  const days = (parts.get('BYDAY') ?? '').split(',').filter((day) => day !== '');
  return (
    parts.get('FREQ') === 'WEEKLY' &&
    days.length === 1 &&
    /^(?:MO|TU|WE|TH|FR|SA|SU)$/.test(days[0] ?? '') &&
    /^\d{1,2}$/.test(parts.get('BYHOUR') ?? '') &&
    /^\d{1,2}$/.test(parts.get('BYMINUTE') ?? '')
  );
}

/** Whole days from `from` to `to`, both "YYYY-MM-DD". */
export function daysBetween(from: string, to: string): number {
  const utc = (date: string) => {
    const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function intParameter(context: ValidatorContext, key: string): number {
  const value = context.parameters[key];
  return typeof value === 'number' ? value : Number.NaN;
}

/** A check that needs exactly one active series of a meeting, then checks its agenda. */
export function oneSeriesWithAgenda(
  context: ValidatorContext,
  meetingKey: string,
  label: string,
  order: readonly AgendaSectionType[],
): Violation[] {
  const series = activeSeries(context.state, meetingKey);
  if (series.length !== 1) {
    return [
      {
        message: `${label}: expected exactly one active ${meetingKey} series, found ${series.length}`,
        values: { workstreamId: context.state.workstreamId, seriesIds: series.map((s) => s.id) },
      },
    ];
  }
  const [only] = series;
  const problem = only === undefined ? undefined : agendaOrderProblem(only.agenda, order);
  if (only === undefined || problem === undefined) return [];
  return [
    {
      message: `${label}: agenda of ${only.id} is out of order (${problem}); required ${order.join(' → ')}`,
      values: { seriesId: only.id, agenda: only.agenda },
    },
  ];
}
