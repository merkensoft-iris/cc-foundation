/**
 * Migrations are numbered, forward-only SQL files with a `schema_version` table
 * (03 §12 point 5), and an existing file never changes (08 §6, AC-08-08).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyMigrations, readMigrations, sha256Hex, StoreError, tableSpecs } from '@cc/store';

import { openEmptyDatabase, openSnapshotDatabase } from './support/migrations.js';
import { REPO_ROOT } from './support/reference.js';

interface Lock {
  readonly migrations: readonly { number: number; file: string; sha256: string }[];
}

const LOCK_PATH = join(REPO_ROOT, 'packages', 'store', 'migrations.lock.json');
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock;

/** The columns of a table after every migration in packages/store/migrations, in order. */
function columnsOf(table: string): string[] {
  const snapshot = openEmptyDatabase();
  try {
    applyMigrations(snapshot.db, readMigrations(), () => '2026-11-13T09:00:00Z');
    return snapshot.columns(table);
  } finally {
    snapshot.cleanup();
  }
}

describe('packages/store/migrations', () => {
  it('AC-08-08 changing an existing file in packages/store/migrations fails CI', () => {
    const files = readMigrations();
    const digests = new Map(files.map((file) => [file.fileName, file.sha256]));
    for (const entry of lock.migrations) {
      expect(
        digests.get(entry.file),
        `${entry.file} changed since it was merged; migrations are forward-only`,
      ).toBe(entry.sha256);
    }
    expect(files.map((file) => file.fileName)).toEqual(lock.migrations.map((entry) => entry.file));
  });

  it('AC-08-08 every migration digest in the lock is the digest of its file', () => {
    for (const entry of lock.migrations) {
      const bytes = readFileSync(join(REPO_ROOT, 'packages', 'store', 'migrations', entry.file));
      expect(sha256Hex(bytes)).toBe(entry.sha256);
    }
  });

  it('numbers migrations from 0001 without gaps', () => {
    expect(readMigrations().map((file) => file.number)).toEqual(
      readMigrations().map((_, index) => index + 1),
    );
  });

  it('refuses to open a database whose applied migration file has changed', () => {
    const snapshot = openSnapshotDatabase(1);
    try {
      const [applied] = readMigrations();
      const tampered = [
        { ...applied!, sql: `${applied!.sql}\n-- edited\n`, sha256: 'f'.repeat(64) },
      ];
      expect(() => applyMigrations(snapshot.db, tampered)).toThrowError(StoreError);
      try {
        applyMigrations(snapshot.db, tampered);
      } catch (error) {
        expect((error as StoreError).code).toBe('E_GUARD_MIGRATION_CHANGED');
        expect((error as StoreError).help.join(' ')).toContain('cc:new-migration');
      }
    } finally {
      snapshot.cleanup();
    }
  });

  it('the table registry names exactly the columns the migrations create', () => {
    for (const spec of tableSpecs) {
      expect(columnsOf(spec.table), spec.table).toEqual(spec.columns.map((c) => c.column));
    }
  });

  it('every table has a version column for optimistic concurrency (03 §12 point 3)', () => {
    for (const spec of tableSpecs) {
      expect(columnsOf(spec.table), spec.table).toContain('version');
    }
  });
});
