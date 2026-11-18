/**
 * Snapshots for backups (04 §9.1 rule 2) and their checks (rule 7).
 *
 * A backup holds a consistent snapshot of `workspace.db` taken with SQLite's online backup
 * API (`Store.snapshot`), plus the blobs the snapshot's records reference. This module reads a
 * snapshot file read-only: `PRAGMA integrity_check`, the row count of every store table, the
 * last event ID and the referenced blob digests. The restore test compares those with the
 * archive's manifest and with the live store at the snapshot's event ID.
 *
 * Nothing here writes a snapshot: it is opened read-only and closed again.
 */
import Database from 'better-sqlite3';

import { StoreError } from './errors.js';
import { currentSchemaVersion, readMigrations } from './migrations.js';
import { Repository } from './repository.js';
import { readPath } from './rows.js';
import { tableNames, tableSpecs, type TableName } from './tables.js';

export interface SnapshotInfo {
  /** `ok`, or the first lines `PRAGMA integrity_check` reported. */
  readonly integrity: string;
  readonly schemaVersion: number;
  /** Row count of every store table the snapshot has. */
  readonly tables: Readonly<Partial<Record<TableName, number>>>;
  /** The newest event ID (ULIDs sort by time), or null for an empty log. */
  readonly lastEventId: string | null;
  /**
   * The blob digests the snapshot's records reference, sorted; null when the snapshot's
   * schema is not this build's (a pre-migration snapshot), so its records cannot be read by
   * the current table specs.
   */
  readonly blobDigests: readonly string[] | null;
}

function notReadable(path: string, error: unknown): StoreError {
  return new StoreError(
    'E_INVARIANT',
    `${path} is not a readable SQLite database: ${error instanceof Error ? error.message : String(error)}`,
    ['04 §9.1 rule 7: a snapshot that does not open read-only fails the restore test'],
  );
}

/** Reads a snapshot file read-only (04 §9.1 rule 7). */
export function inspectSnapshot(path: string): SnapshotInfo {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw notReadable(path, error);
  }
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const integrity = rows
      .map((row) => row.integrity_check)
      .slice(0, 5)
      .join('; ');
    const present = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    const tables: Partial<Record<TableName, number>> = {};
    for (const table of tableNames) {
      if (!present.has(table)) continue;
      const row = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
      tables[table] = row.n;
    }
    const last = present.has('events')
      ? (db.prepare('SELECT max(id) AS id FROM events').get() as { id: string | null }).id
      : null;
    const schemaVersion = present.has('schema_version') ? currentSchemaVersion(db) : 0;
    let blobDigests: string[] | null = null;
    const latest = readMigrations().at(-1)?.number ?? 0;
    if (schemaVersion === latest) {
      const digests = new Set<string>();
      const tx = new Repository(db, {
        now: () => new Date(0).toISOString(),
        ulid: () => {
          throw new StoreError('E_USAGE', 'a snapshot is read-only');
        },
      }).readTx();
      for (const spec of tableSpecs) {
        if (spec.blobFields === undefined || !present.has(spec.table)) continue;
        for (const row of tx.list(spec.table)) {
          for (const field of spec.blobFields) {
            const digest = readPath(row, field);
            if (typeof digest === 'string') digests.add(digest);
          }
        }
      }
      blobDigests = [...digests].sort();
    }
    return { integrity, schemaVersion, tables, lastEventId: last, blobDigests };
  } finally {
    db.close();
  }
}
