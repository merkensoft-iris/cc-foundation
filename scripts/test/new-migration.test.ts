/** pnpm cc:new-migration (08 §6): the next-numbered migration, its snapshot and its test. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

import { LOCK, lockDrift, MIGRATIONS, runNewMigration, type Lock } from '../new-migration.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** A throwaway copy of the migrations, their lock and the Prettier config. */
function sandbox(): { path: string; cleanup(): void } {
  const dir = createProfileDir();
  for (const path of ['.prettierrc.json', MIGRATIONS, LOCK]) {
    mkdirSync(join(dir.path, path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.'), {
      recursive: true,
    });
    cpSync(join(root, path), join(dir.path, path), { recursive: true });
  }
  return dir;
}

function readLockFile(dir: string): Lock {
  return JSON.parse(readFileSync(join(dir, LOCK), 'utf8')) as Lock;
}

/** The repository's migrations, and the number the next one gets. */
const existing = readLockFile(root).migrations;
const NEXT = String(existing.length + 1).padStart(4, '0');

describe('cc:new-migration', () => {
  it('AC-08-08 pnpm cc:new-migration add_x creates the next number', async () => {
    const dir = sandbox();
    try {
      const result = await runNewMigration(dir.path, 'add_x');
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual([
        `wrote packages/store/migrations/${NEXT}_add_x.sql`,
        `wrote packages/store/test/migrations/snapshots/${NEXT}_previous.sql`,
        `wrote packages/store/test/migrations/${NEXT}_add_x.test.ts`,
        'updated packages/store/migrations.lock.json',
        `next: write the DDL in packages/store/migrations/${NEXT}_add_x.sql, then pnpm test`,
      ]);

      const lock = readLockFile(dir.path);
      expect(lock.migrations.map((entry) => entry.file)).toEqual([
        ...existing.map((entry) => entry.file),
        `${NEXT}_add_x.sql`,
      ]);
      expect(lockDrift(dir.path)).toEqual([]);

      // The snapshot is the schema the new migration upgrades from.
      const snapshot = readFileSync(
        join(dir.path, `packages/store/test/migrations/snapshots/${NEXT}_previous.sql`),
        'utf8',
      );
      const db = new Database(':memory:');
      try {
        db.exec(snapshot);
        const tables = db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_items'",
          )
          .get();
        expect(tables?.name).toBe('action_items');
      } finally {
        db.close();
      }

      const stub = readFileSync(
        join(dir.path, `packages/store/test/migrations/${NEXT}_add_x.test.ts`),
        'utf8',
      );
      expect(stub).toContain(`describe('migration ${NEXT}_add_x'`);
      expect(stub).toContain(`openSnapshotDatabase(${String(existing.length + 1)})`);

      // A third one keeps counting.
      expect((await runNewMigration(dir.path, 'add_y')).exitCode).toBe(0);
      expect(readLockFile(dir.path).migrations.map((entry) => entry.number)).toEqual([
        ...existing.map((entry) => entry.number),
        existing.length + 1,
        existing.length + 2,
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it('AC-08-08 refuses to run when an existing migration file has changed', async () => {
    const dir = sandbox();
    try {
      const path = join(dir.path, MIGRATIONS, '0001_init.sql');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n-- edited by hand\n`);
      expect(lockDrift(dir.path)).toEqual([
        'packages/store/migrations/0001_init.sql changed: migrations are forward-only',
      ]);
      const result = await runNewMigration(dir.path, 'add_x');
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe('cc:new-migration: nothing was written');
      expect(existsSync(join(dir.path, MIGRATIONS, `${NEXT}_add_x.sql`))).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it('refuses a name that is not a migration name', async () => {
    const dir = sandbox();
    try {
      for (const name of ['Add-X', '0002_add', 'add x', '']) {
        expect((await runNewMigration(dir.path, name)).exitCode).toBe(2);
      }
    } finally {
      dir.cleanup();
    }
  });

  it('never overwrites a file', async () => {
    const dir = sandbox();
    try {
      expect((await runNewMigration(dir.path, 'add_x')).exitCode).toBe(0);
      writeFileSync(join(dir.path, MIGRATIONS, `${NEXT}_add_x.sql`), '-- kept\n');
      // The lock now disagrees with the file, which is the drift AC-08-08 fails CI for.
      const again = await runNewMigration(dir.path, 'add_x');
      expect(again.exitCode).toBe(1);
      expect(readFileSync(join(dir.path, MIGRATIONS, `${NEXT}_add_x.sql`), 'utf8')).toBe(
        '-- kept\n',
      );
    } finally {
      dir.cleanup();
    }
  });
});
