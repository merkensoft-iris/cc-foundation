/**
 * Test support for the fixture test every migration has (03 §12 point 5): an in-memory
 * database holding the schema as it stood before migration N, with migration N applied to
 * it by the same `applyMigrations` the app uses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import {
  applyMigrations,
  currentSchemaVersion,
  migrationNumber,
  MIGRATIONS_DIR,
  readMigrations,
} from '@cc/store';

export const SNAPSHOTS_DIR = fileURLToPath(new URL('../migrations/snapshots/', import.meta.url));

export interface SnapshotDatabase {
  readonly db: DatabaseHandle;
  /** The highest migration number applied. */
  schemaVersion(): number;
  /** The columns of one table, in declaration order. */
  columns(table: string): string[];
  /** Every table in the database, excluding SQLite's own and the FTS shadow tables. */
  tables(): string[];
  cleanup(): void;
}

function wrap(db: DatabaseHandle): SnapshotDatabase {
  return {
    db,
    schemaVersion: () => currentSchemaVersion(db),
    columns: (table) =>
      db
        .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(table)
        .map((row) => row.name),
    tables: () =>
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
            "AND name NOT LIKE 'fts_items_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    cleanup: () => db.close(),
  };
}

/** An empty database with no migration applied. */
export function openEmptyDatabase(): SnapshotDatabase {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return wrap(db);
}

/**
 * The schema snapshot taken before migration `number`, with migration `number` applied.
 * Migration 0001 has no previous schema, so it is applied to an empty database. `seed` runs
 * on the snapshot before migration `number`, to write the rows the migration must carry over.
 */
export function openSnapshotDatabase(
  number: number,
  now = () => '2026-11-13T09:00:00Z',
  seed?: (db: DatabaseHandle) => void,
): SnapshotDatabase {
  const snapshot = openEmptyDatabase();
  const migrations = readMigrations();
  if (number > 1) {
    const file = join(SNAPSHOTS_DIR, `${migrationNumber(number)}_previous.sql`);
    snapshot.db.exec(readFileSync(file, 'utf8'));
    const insert = snapshot.db.prepare(
      'INSERT INTO schema_version (number, name, sha256, applied_at) VALUES (?, ?, ?, ?)',
    );
    for (const migration of migrations.filter((entry) => entry.number < number)) {
      insert.run(migration.number, migration.name, migration.sha256, now());
    }
  }
  seed?.(snapshot.db);
  applyMigrations(
    snapshot.db,
    migrations.filter((entry) => entry.number <= number),
    now,
  );
  return snapshot;
}

/** The SQL text of one migration, read from packages/store/migrations. */
export function migrationSql(number: number): string {
  const migration = readMigrations(MIGRATIONS_DIR).find((entry) => entry.number === number);
  if (migration === undefined) throw new Error(`no migration ${migrationNumber(number)}`);
  return migration.sql;
}
