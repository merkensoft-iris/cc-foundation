/**
 * `RecordStore` over the workspace store (@cc/store, P1-02). Each command is one store
 * command: one `BEGIN IMMEDIATE` transaction that reads, writes the projection rows the domain
 * returned and appends one event per write (03 §12 point 4, INV-03-09). A record whose stored
 * version moved since it was read fails `E_CONFLICT` and the whole command rolls back.
 *
 * The store fills in each event's ID and time; the domain's event supplies the type, entity,
 * changed fields, actor and correlation.
 */
import type { Change, EntityKind } from '@cc/domain';
import type { ActionItem, Actor, Evidence, HumanRefKind, Workspace } from '@cc/schemas';
import type { ReadTx, Store, StoreRecords, TableName, WriteTx } from '@cc/store';

import { CoreError } from './errors.js';
import type {
  BindingId,
  BindingSummary,
  CommandOutcome,
  RecordStore,
  RecordView,
} from './records.js';

/**
 * The table each domain entity kind is written to (03 §12 point 2). Meeting instances are
 * written by the meeting commands (P1-08, meetings.ts); meeting series by the rhythm engine's
 * jobs (rhythm-store.ts).
 */
const TABLE_OF: Partial<Record<EntityKind, TableName>> = {
  action_item: 'action_items',
  decision: 'decisions',
  issue: 'issues',
  risk: 'risks',
  evidence: 'evidence',
  goal: 'goals',
  measure_value: 'measure_values',
  meeting_instance: 'meeting_instances',
};

/** The table whose records carry each HumanRef kind (03 §3); meetings arrive with P1-07. */
const REF_TABLES: Partial<Record<HumanRefKind, TableName>> = {
  A: 'action_items',
  D: 'decisions',
  I: 'issues',
  R: 'risks',
  G: 'goals',
  K: 'measures',
};

/** A connector binding row (05 §9), as far as the core reads it. */
export interface BindingRow {
  readonly id: BindingId;
  readonly label: string;
  readonly connectorId: string;
}

/**
 * The actions of a binding's installed connector manifest (INV-03-08). The Connector Host
 * (P2) reads them from the installed packages; until then no connector is installed.
 */
export type InstalledActions = (binding: BindingRow) => readonly string[];

export const NO_INSTALLED_ACTIONS: InstalledActions = () => [];

export interface StoreRecordStoreOptions {
  readonly installedActions?: InstalledActions;
}

/** Evidence as the API returns it: the store's `version` column is not part of the record. */
function withoutVersion(record: StoreRecords['evidence']): Evidence {
  const evidence: Record<string, unknown> = { ...record };
  delete evidence['version'];
  return evidence as Evidence;
}

function bindingRow(row: StoreRecords['connector_bindings']): BindingRow | undefined {
  const { label, connectorId } = row.doc;
  if (typeof label !== 'string' || typeof connectorId !== 'string') return undefined;
  return { id: row.id as BindingId, label, connectorId };
}

class TxView implements RecordView {
  readonly tx: ReadTx;
  readonly #tx: ReadTx;
  readonly #write: WriteTx | undefined;
  readonly #installedActions: InstalledActions;
  #workspace: Workspace | undefined;

  constructor(tx: ReadTx, write: WriteTx | undefined, installedActions: InstalledActions) {
    this.tx = tx;
    this.#tx = tx;
    this.#write = write;
    this.#installedActions = installedActions;
  }

  get selfPersonId(): Workspace['selfPersonId'] {
    return this.#requireWorkspace().selfPersonId;
  }

  person(id: string) {
    return this.#tx.get('persons', id);
  }

  workstream(id: string) {
    return this.#tx.get('workstreams', id);
  }

  item(ref: string): ActionItem | undefined {
    if (ref.startsWith('act_')) return this.#tx.get('action_items', ref);
    // The store has no lookup by ref yet; `ref` is unique, so the first match is the item.
    return this.#tx.list('action_items').find((item) => item.ref === ref);
  }

  evidenceOf(itemId: string): Evidence[] {
    return this.#tx
      .list('evidence')
      .filter((evidence) => evidence.actionItemId === itemId)
      .map(withoutVersion);
  }

  binding(labelOrId: string): BindingSummary | undefined {
    for (const row of this.#tx.list('connector_bindings')) {
      const binding = bindingRow(row);
      if (binding !== undefined && (binding.id === labelOrId || binding.label === labelOrId)) {
        return { id: binding.id, label: binding.label, actions: this.#installedActions(binding) };
      }
    }
    return undefined;
  }

  nextRef(kind: HumanRefKind): string {
    const tx = this.#write;
    if (tx === undefined) throw new Error('nextRef needs a write command');
    const workspace = this.#requireWorkspace();
    const counter = workspace.counters[kind];
    // A counter behind its records (an import, a restore) skips the refs already taken: refs
    // are unique (03 §3).
    const taken = this.#refsInUse(kind);
    let number = counter;
    while (taken.has(`${kind}-${String(number).padStart(4, '0')}`)) number += 1;
    const next: Workspace = {
      ...workspace,
      counters: { ...workspace.counters, [kind]: number + 1 },
    };
    this.#workspace = tx.update('workspace', next, workspace.version);
    tx.event({
      type: 'workspace.counter_advanced',
      entity: { kind: 'workspace', id: workspace.id },
      before: { counters: { [kind]: counter } },
      after: { counters: { [kind]: number + 1 } },
    });
    return `${kind}-${String(number).padStart(4, '0')}`;
  }

  #refsInUse(kind: HumanRefKind): Set<string> {
    const table = REF_TABLES[kind];
    if (table === undefined) return new Set();
    return new Set(this.#tx.list(table).map((record) => (record as { ref: string }).ref));
  }

  #requireWorkspace(): Workspace {
    this.#workspace ??= this.#tx.list('workspace', { limit: 1 })[0];
    if (this.#workspace === undefined) {
      throw new CoreError('E_NOT_FOUND', 'this profile has no workspace yet', [
        'Set up the workspace in the app first',
      ]);
    }
    return this.#workspace;
  }
}

/** Writes one domain change and its event inside the command's transaction. */
function writeChange(tx: WriteTx, change: Change): void {
  const table = TABLE_OF[change.kind];
  if (table === undefined) {
    throw new CoreError('E_INTERNAL', `the core does not write ${change.kind} records yet`);
  }
  const record = change.record as { id: string; version?: number };
  const existing = tx.get(table, record.id) as { version: number } | undefined;
  if (record.version === undefined) {
    // Evidence has no version of its own: it is written once (03 §5.9). A measure value has
    // none either; there is one per measure and period, and a new reading replaces it (03 §5.4).
    if (existing !== undefined && change.kind === 'measure_value') {
      tx.update(table, { ...record, version: existing.version } as never, existing.version);
    } else if (existing !== undefined) {
      throw new CoreError('E_CONFLICT', `${change.kind} ${record.id} already exists`, [
        'Read it again and retry',
      ]);
    } else {
      tx.insert(table, { ...record, version: 1 } as never);
    }
  } else if (existing === undefined) {
    tx.insert(table, record as never);
  } else {
    // The domain advanced the version by one from the record it read.
    tx.update(table, record as never, record.version - 1);
  }
  const { event } = change;
  tx.event({
    type: event.type,
    entity: {
      kind: event.entity.kind,
      id: event.entity.id,
      ...(event.entity.ref === undefined ? {} : { ref: event.entity.ref }),
    },
    ...(event.before === undefined ? {} : { before: event.before }),
    ...(event.after === undefined ? {} : { after: event.after }),
    actor: event.actor,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  });
}

export class StoreRecordStore implements RecordStore {
  readonly #store: Store;
  readonly #installedActions: InstalledActions;

  constructor(store: Store, options: StoreRecordStoreOptions = {}) {
    this.#store = store;
    this.#installedActions = options.installedActions ?? NO_INSTALLED_ACTIONS;
  }

  command<T>(actor: Actor, run: (view: RecordView) => CommandOutcome<T>): T {
    return this.#store.command({ actor }, (tx) => {
      const outcome = run(new TxView(tx, tx, this.#installedActions));
      for (const change of outcome.changes) writeChange(tx, change);
      for (const event of outcome.events ?? []) {
        tx.event({
          type: event.type,
          entity: {
            kind: event.entity.kind,
            id: event.entity.id,
            ...(event.entity.ref === undefined ? {} : { ref: event.entity.ref }),
          },
          ...(event.before === undefined ? {} : { before: event.before }),
          ...(event.after === undefined ? {} : { after: event.after }),
          actor: event.actor,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        });
      }
      return outcome.result;
    });
  }

  /** Reads outside a command, in one snapshot. */
  read<T>(run: (view: RecordView) => T): T {
    return this.#store.read((tx) => run(new TxView(tx, undefined, this.#installedActions)));
  }
}
