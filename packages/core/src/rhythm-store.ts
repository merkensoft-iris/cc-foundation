/**
 * The rhythm engine's store (P1-07 on P1-02): `RhythmStore` of @cc/rhythm implemented on the
 * workspace store, so `extendHorizon` and `runMissedCheck` read and write SQLite. The core is
 * the only package that imports @cc/store (D5); every import here is a type, so loading this
 * module loads no database code.
 *
 * Reads run in one snapshot each. `commit` is one store command, so a job's records and their
 * events land in one `BEGIN IMMEDIATE` transaction or not at all (03 §12 point 4, INV-03-09).
 * A record the store does not hold yet is inserted; one it holds is written over the version
 * the domain read (the domain bumps `version` by one), so a stale write fails `E_CONFLICT`.
 * The store appends each event with its own ID and time (`events` is ordered by the store's
 * ULIDs); the type, entity, actor, changed fields and correlation come from the domain event.
 */
import type { Change, EntityKind } from '@cc/domain';
import type { RhythmStore } from '@cc/rhythm';
import type { EventInput, Store, StoreRecords, TableName, WriteTx } from '@cc/store';

import { CoreError } from './errors.js';

/** The tables the rhythm engine writes, by the entity kind of its changes. */
const RHYTHM_TABLES: Partial<Record<EntityKind, TableName>> = {
  meeting_series: 'meeting_series',
  meeting_instance: 'meeting_instances',
  issue: 'issues',
};

type Versioned = { readonly id: string; readonly version: number };

/** One write of a change: insert when new, otherwise update over the version it was read at. */
function writeRecord<K extends TableName>(tx: WriteTx, table: K, record: Versioned): void {
  const next = record as unknown as StoreRecords[K];
  if (tx.get(table, record.id) === undefined) tx.insert(table, next);
  else tx.update(table, next, record.version - 1);
}

function eventInput(change: Change): EventInput {
  const { type, entity, actor, before, after, correlationId } = change.event;
  return {
    type,
    entity: {
      kind: entity.kind,
      id: entity.id,
      ...(entity.ref === undefined ? {} : { ref: entity.ref }),
    },
    actor,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function tableOf(change: Change): TableName {
  const table = RHYTHM_TABLES[change.kind];
  if (table === undefined) {
    throw new CoreError('E_INTERNAL', `the rhythm engine does not write ${change.kind} records`);
  }
  return table;
}

/** `RhythmStore` over the workspace store (02 §4; 03 §12). */
export function storeRhythmStore(store: Store): RhythmStore {
  return {
    listSeries: () => store.read((tx) => tx.list('meeting_series')),

    listInstances(seriesIds) {
      const wanted = new Set<string>(seriesIds);
      return store
        .read((tx) => tx.list('meeting_instances'))
        .filter((instance) => wanted.has(instance.seriesId));
    },

    openRhythmIssues: () =>
      store
        .read((tx) => tx.list('issues'))
        .filter((issue) => issue.status === 'open' && issue.raisedFrom.kind === 'rhythm'),

    commit(changes) {
      const [first] = changes;
      if (first === undefined) return;
      store.command({ actor: first.event.actor }, (tx) => {
        for (const change of changes) {
          const record = change.record as Versioned;
          if (change.event.entity.id !== record.id) {
            throw new CoreError(
              'E_INTERNAL',
              `the event of ${record.id} names ${change.event.entity.id}`,
            );
          }
          writeRecord(tx, tableOf(change), record);
          tx.event(eventInput(change));
        }
      });
    },
  };
}
