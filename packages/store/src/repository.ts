/**
 * The repository layer (03 §12 point 4): every write goes through one command, one command
 * is one `BEGIN IMMEDIATE` transaction, and that transaction writes the projection rows and
 * the matching `events` rows together. A write against a stale `version` fails `E_CONFLICT`
 * (07 §4.4). Killing the process mid-command therefore leaves either no change or the whole
 * change, never a projection without its event (AC-03-07).
 */
import type { Actor, DomainEvent } from '@cc/schemas';
import type { Database, Statement } from 'better-sqlite3';

import { conflict, notFound, StoreError } from './errors.js';
import type { UlidFactory } from './ids.js';
import { eventId } from './ids.js';
import { fromRow, toRow, validateRow, type SqlRow } from './rows.js';
import { ftsQuery, ftsRow, type SearchHit } from './search.js';
import { tableSpec, type StoreRecords, type TableName, type TableSpec } from './tables.js';

/** Who the command is for and what it belongs to (03 §5.10). */
export interface CommandContext {
  readonly actor: Actor;
  /** Meeting instance, run or confirmation that caused the command. */
  readonly correlationId?: string;
}

/** An event a command appends; the store fills in the ID, the time and the actor. */
export interface EventInput {
  /** "<entity>.<verb>", e.g. "action_item.claimed" (03 §5.10). */
  readonly type: string;
  readonly entity: { readonly kind: string; readonly id: string; readonly ref?: string };
  /** Changed fields only. */
  readonly before?: unknown;
  readonly after?: unknown;
  /** Defaults to the command's actor. */
  readonly actor?: Actor;
  readonly correlationId?: string;
}

export interface ListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly tables?: readonly TableName[];
}

export interface ReadTx {
  get<K extends TableName>(table: K, id: string): StoreRecords[K] | undefined;
  /** Like `get`, but fails `E_NOT_FOUND` when there is no such row. */
  require<K extends TableName>(table: K, id: string): StoreRecords[K];
  list<K extends TableName>(table: K, options?: ListOptions): StoreRecords[K][];
  count(table: TableName): number;
  /** The event log of one entity, oldest first (C-03-04). */
  history(entityKind: string, entityId: string): DomainEvent[];
  events(options?: { readonly since?: string; readonly limit?: number }): DomainEvent[];
  search(query: string, options?: SearchOptions): SearchHit[];
}

export interface WriteTx extends ReadTx {
  insert<K extends TableName>(table: K, record: StoreRecords[K]): StoreRecords[K];
  /**
   * Writes `record` over the row at `expectedVersion` and returns it at the next version.
   * A stale `expectedVersion` fails `E_CONFLICT` (03 §12 point 4).
   */
  update<K extends TableName>(
    table: K,
    record: StoreRecords[K],
    expectedVersion: number,
  ): StoreRecords[K];
  remove(table: TableName, id: string, expectedVersion: number): void;
  /** Appends one event to the log, in this same transaction (03 §12 point 4). */
  event(input: EventInput): DomainEvent;
}

const EVENTS: TableName = 'events';

function assertWritable(spec: TableSpec): void {
  if (spec.derivedFrom !== undefined) {
    throw new StoreError(
      'E_USAGE',
      `${spec.table} is a projection of ${spec.derivedFrom} and is written with it`,
      [`write the ${spec.derivedFrom} record instead`],
    );
  }
  if (spec.table === EVENTS) {
    throw new StoreError('E_USAGE', 'the event log is append-only', [
      "append events with the command transaction's event() (03 §12 point 4)",
    ]);
  }
}

function recordId(spec: TableSpec, record: unknown): string {
  const value = (record as Record<string, unknown>)['id'];
  if (typeof value !== 'string' || value === '') {
    throw new StoreError('E_INVARIANT', `${spec.table}: a record needs a string id`, []);
  }
  return value;
}

/** Prepares statements once per database handle. */
class Statements {
  readonly #db: Database;
  readonly #cache = new Map<string, Statement<[SqlRow] | [], unknown>>();

  constructor(db: Database) {
    this.#db = db;
  }

  get(sql: string): Statement<[SqlRow], unknown> {
    const cached = this.#cache.get(sql);
    if (cached !== undefined) return cached as Statement<[SqlRow], unknown>;
    const prepared = this.#db.prepare<SqlRow, unknown>(sql);
    this.#cache.set(sql, prepared);
    return prepared;
  }
}

export interface RepositoryOptions {
  readonly now: () => string;
  readonly ulid: UlidFactory;
}

/**
 * The read and write transactions over one database handle. `Store` owns the handle and the
 * transaction boundaries; this class owns what a transaction may do.
 */
export class Repository {
  readonly #statements: Statements;
  readonly #options: RepositoryOptions;
  #projectionWrites = 0;
  #eventWrites = 0;

  constructor(db: Database, options: RepositoryOptions) {
    this.#statements = new Statements(db);
    this.#options = options;
  }

  /** Counts of what the current command has written, for the event-log rule. */
  get counts(): { projections: number; events: number } {
    return { projections: this.#projectionWrites, events: this.#eventWrites };
  }

  resetCounts(): void {
    this.#projectionWrites = 0;
    this.#eventWrites = 0;
  }

  readTx(): ReadTx {
    return {
      get: (table, id) => this.#get(table, id),
      require: (table, id) => {
        const found = this.#get(table, id);
        if (found === undefined) throw notFound(table, id);
        return found;
      },
      list: (table, options) => this.#list(table, options),
      count: (table) => this.#count(table),
      history: (kind, id) => this.#history(kind, id),
      events: (options) => this.#events(options),
      search: (query, options) => this.#search(query, options),
    };
  }

  writeTx(context: CommandContext): WriteTx {
    return {
      ...this.readTx(),
      insert: (table, record) => this.#insert(table, record),
      update: (table, record, expectedVersion) => this.#update(table, record, expectedVersion),
      remove: (table, id, expectedVersion) => this.#remove(table, id, expectedVersion),
      event: (input) => this.#event(context, input),
    };
  }

  #get<K extends TableName>(table: K, id: string): StoreRecords[K] | undefined {
    const spec = tableSpec(table);
    if (spec.primaryKey.length > 1) {
      throw new StoreError(
        'E_USAGE',
        `${spec.table} is keyed by (${spec.primaryKey.join(', ')}), so one ID does not name a row`,
        [`list ${spec.table} and pick the row you want`],
      );
    }
    const key = spec.primaryKey[0] ?? 'id';
    const row = this.#statements
      .get(`SELECT * FROM ${spec.table} WHERE ${key} = @id`)
      .get({ id }) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : (fromRow(spec, row) as StoreRecords[K]);
  }

  #list<K extends TableName>(table: K, options: ListOptions = {}): StoreRecords[K][] {
    const spec = tableSpec(table);
    const order = spec.primaryKey.join(', ');
    const rows = this.#statements
      .get(`SELECT * FROM ${spec.table} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ limit: options.limit ?? -1, offset: options.offset ?? 0 }) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => fromRow(spec, row) as StoreRecords[K]);
  }

  #count(table: TableName): number {
    const spec = tableSpec(table);
    const row = this.#statements.get(`SELECT count(*) AS n FROM ${spec.table}`).get({}) as
      { n: number } | undefined;
    return row?.n ?? 0;
  }

  #history(entityKind: string, entityId: string): DomainEvent[] {
    const spec = tableSpec(EVENTS);
    const rows = this.#statements
      .get('SELECT * FROM events WHERE entity_kind = @kind AND entity_id = @id ORDER BY id')
      .all({ kind: entityKind, id: entityId }) as Record<string, unknown>[];
    return rows.map((row) => fromRow(spec, row) as DomainEvent);
  }

  #events(options: { readonly since?: string; readonly limit?: number } = {}): DomainEvent[] {
    const spec = tableSpec(EVENTS);
    const rows = this.#statements
      .get('SELECT * FROM events WHERE id > @since ORDER BY id LIMIT @limit')
      .all({ since: options.since ?? '', limit: options.limit ?? -1 }) as Record<string, unknown>[];
    return rows.map((row) => fromRow(spec, row) as DomainEvent);
  }

  #search(query: string, options: SearchOptions = {}): SearchHit[] {
    const match = ftsQuery(query);
    if (match === '') return [];
    const rows = this.#statements
      .get(
        `SELECT table_name, item_id, ref, title,
                snippet(fts_items, -1, '[', ']', '...', 12) AS snippet,
                bm25(fts_items) AS rank
         FROM fts_items WHERE fts_items MATCH @match ORDER BY rank LIMIT @limit`,
      )
      .all({ match, limit: options.limit ?? 50 }) as {
      table_name: TableName;
      item_id: string;
      ref: string;
      title: string;
      snippet: string;
      rank: number;
    }[];
    const wanted = options.tables;
    return rows
      .filter((row) => wanted === undefined || wanted.includes(row.table_name))
      .map((row) => ({
        table: row.table_name,
        ...(row.ref === '' ? {} : { ref: row.ref }),
        id: row.item_id,
        title: row.title,
        snippet: row.snippet,
        rank: row.rank,
      }));
  }

  #insert<K extends TableName>(table: K, record: StoreRecords[K]): StoreRecords[K] {
    const spec = tableSpec(table);
    assertWritable(spec);
    const version = (record as { version?: unknown }).version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new StoreError(
        'E_INVARIANT',
        `${spec.table}: version must be an integer of at least 1, not ${String(version)}`,
        ['new records start at 1; an imported record keeps the version it was exported at'],
      );
    }
    const id = recordId(spec, record);
    const key = spec.primaryKey[0] ?? 'id';
    const existing = this.#statements
      .get(`SELECT version FROM ${spec.table} WHERE ${key} = @id`)
      .get({ id }) as { version: number } | undefined;
    if (existing !== undefined) throw conflict(spec.table, id, 0, existing.version);
    this.#write(spec, record);
    this.#projectionWrites++;
    return record;
  }

  #update<K extends TableName>(
    table: K,
    record: StoreRecords[K],
    expectedVersion: number,
  ): StoreRecords[K] {
    const spec = tableSpec(table);
    assertWritable(spec);
    const id = recordId(spec, record);
    const key = spec.primaryKey[0] ?? 'id';
    const current = this.#statements
      .get(`SELECT version FROM ${spec.table} WHERE ${key} = @id`)
      .get({ id }) as { version: number } | undefined;
    if (current === undefined) throw notFound(spec.table, id);
    if (current.version !== expectedVersion) {
      throw conflict(spec.table, id, expectedVersion, current.version);
    }
    const next = { ...record, version: expectedVersion + 1 } as StoreRecords[K];
    this.#write(spec, next);
    this.#projectionWrites++;
    return next;
  }

  #remove(table: TableName, id: string, expectedVersion: number): void {
    const spec = tableSpec(table);
    assertWritable(spec);
    const key = spec.primaryKey[0] ?? 'id';
    const current = this.#statements
      .get(`SELECT version FROM ${spec.table} WHERE ${key} = @id`)
      .get({ id }) as { version: number } | undefined;
    if (current === undefined) throw notFound(spec.table, id);
    if (current.version !== expectedVersion) {
      throw conflict(spec.table, id, expectedVersion, current.version);
    }
    this.#statements.get(`DELETE FROM ${spec.table} WHERE ${key} = @id`).run({ id });
    this.#clearDerived(spec, id);
    this.#clearFts(spec.table, id);
    this.#projectionWrites++;
  }

  /** Writes one record and everything derived from it, inside the current transaction. */
  #write(spec: TableSpec, record: unknown): void {
    validateRow(spec, record);
    const row = toRow(spec, record);
    const columns = spec.columns.map((column) => column.column);
    const sql =
      `INSERT INTO ${spec.table} (${columns.join(', ')}) ` +
      `VALUES (${columns.map((column) => `@${column}`).join(', ')}) ` +
      `ON CONFLICT (${spec.primaryKey.join(', ')}) DO UPDATE SET ` +
      columns
        .filter((column) => !spec.primaryKey.includes(column))
        .map((column) => `${column} = excluded.${column}`)
        .join(', ');
    this.#statements.get(sql).run(row);
    // A projection table is written from its parent, and is neither derived nor indexed.
    if (spec.derivedFrom !== undefined) return;
    const id = recordId(spec, record);
    this.#writeDerived(spec, id, record);
    this.#writeFts(spec, id, record);
  }

  /** Rewrites the projection tables of a record (execution_steps, verifications). */
  #writeDerived(spec: TableSpec, id: string, record: unknown): void {
    if (spec.table !== 'action_items') return;
    const item = record as StoreRecords['action_items'];
    this.#clearDerived(spec, id);
    const steps = item.execution.steps;
    for (const step of steps) {
      const stepSpec = tableSpec('execution_steps');
      this.#write(stepSpec, { ...step, actionItemId: item.id, version: item.version });
    }
    if (item.verification !== undefined) {
      const verificationSpec = tableSpec('verifications');
      this.#write(verificationSpec, {
        ...item.verification,
        actionItemId: item.id,
        version: item.version,
      });
    }
  }

  #clearDerived(spec: TableSpec, id: string): void {
    if (spec.table !== 'action_items') return;
    this.#statements
      .get('DELETE FROM execution_steps WHERE action_item_id = @id')
      .run({ id } as SqlRow);
    this.#statements
      .get('DELETE FROM verifications WHERE action_item_id = @id')
      .run({ id } as SqlRow);
  }

  #writeFts(spec: TableSpec, id: string, record: unknown): void {
    if (spec.fts === undefined) return;
    this.#clearFts(spec.table, id);
    const row = ftsRow(spec, id, record);
    if (row === undefined) return;
    this.#statements
      .get(
        'INSERT INTO fts_items (table_name, item_id, ref, title, done_means, notes) ' +
          'VALUES (@table_name, @item_id, @ref, @title, @done_means, @notes)',
      )
      .run({ ...row });
  }

  #clearFts(table: TableName, id: string): void {
    this.#statements
      .get('DELETE FROM fts_items WHERE table_name = @table AND item_id = @id')
      .run({ table, id } as SqlRow);
  }

  #event(context: CommandContext, input: EventInput): DomainEvent {
    const at = this.#options.now();
    const id = eventId(this.#options.ulid(Date.parse(at)));
    const correlationId = input.correlationId ?? context.correlationId;
    const event: DomainEvent = {
      id,
      at,
      actor: input.actor ?? context.actor,
      type: input.type,
      entity: input.entity,
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
    const spec = tableSpec(EVENTS);
    const stored = { ...event, version: 1 };
    validateRow(spec, stored);
    const columns = spec.columns.map((column) => column.column);
    this.#statements
      .get(
        `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`,
      )
      .run(toRow(spec, stored));
    this.#eventWrites++;
    return event;
  }
}
