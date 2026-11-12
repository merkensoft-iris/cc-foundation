/**
 * Absorption (02 §4.3). When two series of the same workstreams fall on the same local date, the
 * higher-cadence meeting (yearly > quarterly > monthly > weekly) absorbs the lower one if its
 * `absorbs` lists the lower cadence. The absorbing meeting runs `durationMinutes` plus the
 * `absorbedMinutes` of every meeting it absorbs.
 *
 * Readings where 02 §4.3 is silent: "the same workstreams" is the same set of workstream IDs;
 * "the same local date" is read in the absorbing series' zone; absorbers are taken from the
 * highest cadence down, and an absorbed meeting absorbs nothing itself.
 */
import type { Cadence, MeetingSeries } from '@cc/schemas';

import { localDate } from './time.js';

export const CADENCE_RANK: Readonly<Record<Cadence, number>> = {
  daily: 0,
  weekly: 1,
  biweekly: 2,
  monthly: 3,
  quarterly: 4,
  yearly: 5,
};

export type AbsorbSeries = Pick<
  MeetingSeries,
  'id' | 'cadence' | 'workstreamIds' | 'absorbs' | 'timeZone' | 'durationMinutes'
>;

/** One meeting on one date: an instance, or an occurrence in a check. */
export interface Slot {
  readonly id: string;
  readonly series: AbsorbSeries;
  readonly start: string;
  /** Set when the slot is already absorbed; absorbed is final (02 §4.2). */
  readonly absorbedBy?: string;
}

export interface Absorption {
  /** Slot ID → the slot that absorbs it. */
  readonly absorbedBy: ReadonlyMap<string, string>;
  /** Absorbing slot ID → the slots it absorbs, in start order. */
  readonly absorbs: ReadonlyMap<string, readonly string[]>;
  /** Absorbing slot ID → its extra minutes (sum of `absorbedMinutes`). */
  readonly extraMinutes: ReadonlyMap<string, number>;
}

function sameWorkstreams(a: AbsorbSeries, b: AbsorbSeries): boolean {
  const set = new Set(a.workstreamIds);
  return b.workstreamIds.length === set.size && b.workstreamIds.every((id) => set.has(id));
}

export function absorbSlots(slots: readonly Slot[]): Absorption {
  const absorbedBy = new Map<string, string>();
  for (const slot of slots)
    if (slot.absorbedBy !== undefined) absorbedBy.set(slot.id, slot.absorbedBy);
  const absorbers = slots
    .filter((slot) => slot.series.absorbs.length > 0)
    .sort(
      (a, b) =>
        CADENCE_RANK[b.series.cadence] - CADENCE_RANK[a.series.cadence] ||
        a.start.localeCompare(b.start) ||
        a.id.localeCompare(b.id),
    );
  for (const absorber of absorbers) {
    if (absorbedBy.has(absorber.id)) continue;
    const date = localDate(absorber.start, absorber.series.timeZone);
    for (const slot of slots) {
      if (slot.id === absorber.id || absorbedBy.has(slot.id)) continue;
      if (slot.series.id === absorber.series.id) continue;
      if (CADENCE_RANK[slot.series.cadence] >= CADENCE_RANK[absorber.series.cadence]) continue;
      if (!absorber.series.absorbs.some((entry) => entry.cadence === slot.series.cadence)) continue;
      if (!sameWorkstreams(absorber.series, slot.series)) continue;
      if (localDate(slot.start, absorber.series.timeZone) !== date) continue;
      absorbedBy.set(slot.id, absorber.id);
    }
  }
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const absorbs = new Map<string, string[]>();
  const extraMinutes = new Map<string, number>();
  for (const [id, by] of absorbedBy) {
    const absorber = byId.get(by);
    const absorbed = byId.get(id);
    absorbs.set(by, [...(absorbs.get(by) ?? []), id]);
    const minutes =
      absorber?.series.absorbs.find((entry) => entry.cadence === absorbed?.series.cadence)
        ?.absorbedMinutes ?? 0;
    extraMinutes.set(by, (extraMinutes.get(by) ?? 0) + minutes);
  }
  for (const [by, ids] of absorbs) {
    absorbs.set(
      by,
      [...ids].sort((a, b) => (byId.get(a)?.start ?? '').localeCompare(byId.get(b)?.start ?? '')),
    );
  }
  return { absorbedBy, absorbs, extraMinutes };
}
