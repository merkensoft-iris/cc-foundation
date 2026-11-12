/**
 * The rhythm engine's jobs over a narrow store interface. The core (the only writer, D5)
 * implements `RhythmStore` on the store and runs these jobs on its scheduler: the horizon
 * extension daily at 00:05 in the workspace zone and after any series change (02 §4.1 rule 2),
 * and the missed check (02 §4.2 rule 2). Each job reads, computes with the pure functions of this
 * package, and commits its writes in one call, which the store makes one transaction
 * (03 §12 rule 4).
 */
import type { Caller, Change, DomainContext } from '@cc/domain';
import type { Issue, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { materialise, type MaterialiseResult } from './materialise.js';
import { markMissed, type MissedResult } from './missed.js';
import type { PlacementContext } from './placement.js';

export interface RhythmStore {
  /** Every series of the workspace, any status. */
  listSeries(): readonly MeetingSeries[];
  /** The instances of the given series. */
  listInstances(seriesIds: readonly string[]): readonly MeetingInstance[];
  /** Open issues raised by rhythm escalations (`raisedFrom.kind = 'rhythm'`). */
  openRhythmIssues(): readonly Issue[];
  /** Writes the records and their events in one transaction (INV-03-09). */
  commit(changes: readonly Change[]): void;
}

export const RHYTHM_CALLER: Caller = { actor: { kind: 'system', component: 'rhythm' } };
export const SCHEDULER_CALLER: Caller = { actor: { kind: 'system', component: 'scheduler' } };

/** Extends the horizon of every series (02 §4.1 rule 2). Idempotent (C-02-02). */
export function extendHorizon(
  store: RhythmStore,
  ctx: DomainContext,
  placement?: PlacementContext,
): MaterialiseResult {
  const series = store.listSeries();
  const result = materialise(ctx, RHYTHM_CALLER, {
    series,
    instances: store.listInstances(series.map((s) => s.id)),
    ...(placement === undefined ? {} : { placement }),
  });
  if (result.changes.length > 0) store.commit(result.changes);
  return result;
}

/** Marks due instances missed and raises rhythm escalations (02 §4.2 rules 2 and 3). */
export function runMissedCheck(store: RhythmStore, ctx: DomainContext): MissedResult {
  const series = store.listSeries();
  const result = markMissed(ctx, SCHEDULER_CALLER, {
    series,
    instances: store.listInstances(series.map((s) => s.id)),
    openIssues: store.openRhythmIssues(),
  });
  if (result.changes.length > 0) store.commit(result.changes);
  return result;
}
