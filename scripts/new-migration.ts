/**
 * pnpm cc:new-migration <name>: creates `packages/store/migrations/NNNN_<name>.sql` with the
 * next number and a fixture-upgrade test stub (08 §6; 03 §12 point 5).
 *
 * It also records the new file's SHA-256 in `packages/store/migrations.lock.json` and
 * snapshots the schema the migration upgrades from, into
 * `packages/store/test/migrations/snapshots/NNNN_previous.sql`. Migration 0001 has no
 * previous schema, so it has no snapshot: its fixture test applies it to an empty database.
 *
 * Migrations are forward-only, so this script never rewrites an existing lock entry; it
 * refuses when an existing migration file no longer matches its digest, which is the same
 * check CI runs (AC-08-08).
 *
 * Exit codes follow 08 §6: 0 written, 1 a file exists or a migration changed, 2 usage error.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import * as prettier from 'prettier';

export const USAGE = 'usage: pnpm cc:new-migration <name>';
export const MIGRATIONS = 'packages/store/migrations';
export const LOCK = 'packages/store/migrations.lock.json';
export const TESTS = 'packages/store/test/migrations';
export const SNAPSHOTS = 'packages/store/test/migrations/snapshots';

const FILE_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const NAME = /^[a-z][a-z0-9_]*$/;

export interface LockEntry {
  readonly number: number;
  readonly file: string;
  readonly sha256: string;
}

export interface Lock {
  /** Why the file exists, for whoever opens it first. */
  readonly comment: string;
  readonly migrations: readonly LockEntry[];
}

export const LOCK_COMMENT =
  'Digests of packages/store/migrations/*.sql. Migrations are forward-only: changing an ' +
  'existing file fails CI (AC-08-08). pnpm cc:new-migration <name> appends an entry and ' +
  'never rewrites one.';

export interface MigrationFile {
  readonly number: number;
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function migrationNumber(value: number): string {
  return String(value).padStart(4, '0');
}

/** Every migration file in number order; throws on a name that is not NNNN_name.sql. */
export function listMigrations(root: string): MigrationFile[] {
  const dir = join(root, MIGRATIONS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file);
      if (match === null) throw new Error(`migration file name is not NNNN_name.sql: ${file}`);
      return {
        number: Number(match[1]),
        name: match[2] ?? '',
        file,
        sha256: sha256Hex(readFileSync(join(dir, file))),
      };
    });
}

export function readLock(root: string): Lock {
  const path = join(root, LOCK);
  if (!existsSync(path)) return { comment: LOCK_COMMENT, migrations: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as Lock;
}

/**
 * The migration files whose digest no longer matches the lock, and the lock entries whose
 * file is gone: the drift AC-08-08 fails CI for. An entry with no lock row is new, not drift.
 */
export function lockDrift(root: string): string[] {
  const lock = readLock(root);
  const files = new Map(listMigrations(root).map((entry) => [entry.file, entry]));
  const problems: string[] = [];
  for (const entry of lock.migrations) {
    const file = files.get(entry.file);
    if (file === undefined) {
      problems.push(`${MIGRATIONS}/${entry.file} is in ${LOCK} but missing from the directory`);
    } else if (file.sha256 !== entry.sha256) {
      problems.push(`${MIGRATIONS}/${entry.file} changed: migrations are forward-only`);
    }
  }
  return problems;
}

export interface NewMigrationResult {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: string[];
}

/** The SQL file a new migration starts as. */
export function migrationTemplate(number: number, name: string): string {
  return [
    `-- ${migrationNumber(number)}_${name}: <what this migration changes and why>.`,
    '--',
    '-- Forward-only (03 §12 point 5): this file never changes once merged. Add another',
    '-- migration instead. Every table keeps its `version` column for optimistic concurrency,',
    '-- and nested structures stay JSON columns validated by their schema in @cc/schemas.',
    '',
    '-- TODO: the DDL of this migration.',
    '',
  ].join('\n');
}

/** The fixture-upgrade test a new migration starts with (03 §12 point 5). */
export function testTemplate(number: number, name: string): string {
  const padded = migrationNumber(number);
  return `/**
 * Migration ${padded}_${name}: upgrading a snapshot of the schema as it stood after
 * ${migrationNumber(number - 1)} (03 §12 point 5). The snapshot is
 * packages/store/test/migrations/snapshots/${padded}_previous.sql.
 */
import { describe, expect, it } from 'vitest';

import { openSnapshotDatabase } from '../support/migrations.js';

describe('migration ${padded}_${name}', () => {
  it('upgrades a snapshot of the ${migrationNumber(number - 1)} schema', () => {
    const snapshot = openSnapshotDatabase(${String(number)});
    try {
      // TODO: seed the rows this migration has to carry over, then assert what it did.
      expect(snapshot.schemaVersion()).toBe(${String(number)});
    } finally {
      snapshot.cleanup();
    }
  });
});
`;
}

/** The schema as it stands after every migration before `number`, as CREATE statements. */
export function snapshotSchema(root: string, number: number): string {
  const db = new Database(':memory:');
  try {
    for (const migration of listMigrations(root).filter((entry) => entry.number < number)) {
      db.exec(readFileSync(join(root, MIGRATIONS, migration.file), 'utf8'));
    }
    const rows = db
      .prepare<[], { name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
          "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
      )
      .all();
    // A virtual table brings shadow tables of its own; SQLite creates those, not the schema.
    const virtualTables = rows
      .filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql))
      .map((row) => row.name);
    const statements = rows
      .filter((row) => !virtualTables.some((name) => row.name.startsWith(`${name}_`)))
      .map((row) => `${row.sql.trim()};`);
    return [
      `-- Snapshot of the schema after ${migrationNumber(number - 1)}, written by`,
      '-- pnpm cc:new-migration. It is the starting point of the fixture-upgrade test of',
      `-- migration ${migrationNumber(number)} (03 §12 point 5). Generated; never edited by hand.`,
      '',
      ...statements,
      '',
    ].join('\n');
  } finally {
    db.close();
  }
}

export async function runNewMigration(root: string, name: string): Promise<NewMigrationResult> {
  if (!NAME.test(name)) {
    return { exitCode: 2, lines: [`cc:new-migration: not a migration name: ${name}`, USAGE] };
  }
  const drift = lockDrift(root);
  if (drift.length > 0) {
    return {
      exitCode: 1,
      lines: ['cc:new-migration: nothing was written', ...drift.map((line) => `  ${line}`)],
    };
  }
  const existing = listMigrations(root);
  const number = (existing.at(-1)?.number ?? 0) + 1;
  const padded = migrationNumber(number);
  // Repository-relative paths are written with forward slashes everywhere, so the output
  // reads the same on Windows as it does in the design docs and in CI logs.
  const sqlPath = `${MIGRATIONS}/${padded}_${name}.sql`;
  const testPath = `${TESTS}/${padded}_${name}.test.ts`;
  const snapshotPath = `${SNAPSHOTS}/${padded}_previous.sql`;
  const files: [string, string][] = [[sqlPath, migrationTemplate(number, name)]];
  if (number > 1) {
    files.push([snapshotPath, snapshotSchema(root, number)]);
    files.push([
      testPath,
      await prettier.format(testTemplate(number, name), {
        ...(await prettier.resolveConfig(join(root, testPath))),
        filepath: join(root, testPath),
      }),
    ]);
  }
  const clash = files.filter(([path]) => existsSync(join(root, path)));
  if (clash.length > 0) {
    return {
      exitCode: 1,
      lines: clash.map((entry) => `cc:new-migration: ${entry[0]} exists; nothing was written`),
    };
  }
  const lines: string[] = [];
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    lines.push(`wrote ${path}`);
  }
  const lock = readLock(root);
  const next: Lock = {
    comment: LOCK_COMMENT,
    migrations: [
      ...lock.migrations,
      { number, file: `${padded}_${name}.sql`, sha256: sha256Hex(files[0]?.[1] ?? '') },
    ],
  };
  writeFileSync(
    join(root, LOCK),
    await prettier.format(JSON.stringify(next), {
      ...(await prettier.resolveConfig(join(root, LOCK))),
      filepath: join(root, LOCK),
    }),
  );
  lines.push(`updated ${LOCK}`);
  lines.push(`next: write the DDL in ${sqlPath}, then pnpm test`);
  return { exitCode: 0, lines };
}

async function main(args: readonly string[]): Promise<number> {
  const [name, ...rest] = args;
  if (name === undefined || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await runNewMigration(root, name);
  for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
