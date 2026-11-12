/**
 * Numbered forward-only migrations (03 §12 point 5): `packages/store/migrations/NNNN_name.sql`
 * with a `schema_version` table. A migration file never changes once merged; CI proves it
 * (08 §6, AC-08-08) and `applyMigrations` refuses at run time if an applied file's digest
 * no longer matches, rather than silently running on a schema it did not create.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from 'better-sqlite3';

import { StoreError } from './errors.js';

/** packages/store/migrations, resolved from this module in both src and dist. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

export interface Migration {
  readonly number: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  /** Lower-case hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

export interface AppliedMigration {
  readonly number: number;
  readonly name: string;
  readonly sha256: string;
  readonly appliedAt: string;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** `0003` from 3, the number as the file name spells it. */
export function migrationNumber(value: number): string {
  return String(value).padStart(4, '0');
}

/** Every migration in `dir`, in number order, with gaps and duplicates refused. */
export function readMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrations: Migration[] = [];
  for (const fileName of files) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) {
      throw new StoreError('E_USAGE', `migration file name is not NNNN_name.sql: ${fileName}`, [
        'create migrations with pnpm cc:new-migration <name>',
      ]);
    }
    const number = Number(match[1]);
    const name = match[2] ?? '';
    const bytes = readFileSync(join(dir, fileName));
    migrations.push({
      number,
      name,
      fileName,
      sql: bytes.toString('utf8'),
      sha256: sha256Hex(bytes),
    });
  }
  migrations.forEach((migration, index) => {
    if (migration.number !== index + 1) {
      throw new StoreError(
        'E_USAGE',
        `migrations are numbered from 0001 without gaps; found ${migration.fileName} at position ${String(index + 1)}`,
        ['create migrations with pnpm cc:new-migration <name>'],
      );
    }
  });
  return migrations;
}

/** The migrations already applied to this database, oldest first. */
export function appliedMigrations(db: Database): readonly AppliedMigration[] {
  const table = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (table === undefined) return [];
  return db
    .prepare<[], AppliedMigration>(
      'SELECT number, name, sha256, applied_at AS appliedAt FROM schema_version ORDER BY number',
    )
    .all();
}

/** The highest migration number applied, or 0 for an empty database. */
export function currentSchemaVersion(db: Database): number {
  const applied = appliedMigrations(db);
  return applied.at(-1)?.number ?? 0;
}

/**
 * Applies every migration this database has not seen, each in its own transaction with its
 * `schema_version` row, and refuses when an applied migration's file has changed since
 * (03 §12 point 5: forward-only).
 */
export function applyMigrations(
  db: Database,
  migrations: readonly Migration[] = readMigrations(),
  now: () => string = () => new Date().toISOString(),
): readonly Migration[] {
  const applied = new Map(appliedMigrations(db).map((entry) => [entry.number, entry]));
  for (const entry of applied.values()) {
    const migration = migrations.find((candidate) => candidate.number === entry.number);
    if (migration === undefined) {
      throw new StoreError(
        'E_GUARD_MIGRATION_CHANGED',
        `migration ${migrationNumber(entry.number)}_${entry.name}.sql was applied to this database but is missing from packages/store/migrations`,
        ['migrations are forward-only: restore the file instead of deleting it'],
      );
    }
    if (migration.sha256 !== entry.sha256) {
      throw new StoreError(
        'E_GUARD_MIGRATION_CHANGED',
        `migration ${migration.fileName} changed after it was applied to this database`,
        [
          'migrations are forward-only: revert the file and add a new migration with pnpm cc:new-migration <name>',
        ],
      );
    }
  }
  const pending = migrations.filter((migration) => !applied.has(migration.number));
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_version (number, name, sha256, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.number, migration.name, migration.sha256, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return pending;
}
