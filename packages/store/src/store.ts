/**
 * The workspace store: one SQLite database per workspace in WAL mode (03 §12 point 1),
 * opened from `<userData>` (04 §9) and refused inside a synced folder (04 §9 rule 5).
 *
 * Only this package writes the database, and only through `command()`: one `BEGIN IMMEDIATE`
 * transaction per command, which writes the projection rows and the matching `events` rows
 * together (03 §12 point 4). A command that changes records without appending an event is
 * refused, so a projection can never be committed without its event (AC-03-07).
 */
import { mkdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import { StoreError } from './errors.js';
import { createUlidFactory, type RandomBytes } from './ids.js';
import { assertAbsolute, assertNotSyncedFolder, blobsDir, workspaceDbPath } from './location.js';
import { applyMigrations, currentSchemaVersion, readMigrations } from './migrations.js';
import { Repository, type CommandContext, type ReadTx, type WriteTx } from './repository.js';

export interface StoreOptions {
  /** `<userData>` (04 §9), or a profile directory in tests. Must be absolute. */
  readonly userDataDir: string;
  /** The clock, injected so tests are deterministic. Returns an RFC 3339 UTC timestamp. */
  readonly now?: () => string;
  /** The randomness behind event ULIDs, injected so tests are deterministic. */
  readonly random?: RandomBytes;
  /** The environment the synced-folder check reads (04 §9 rule 5). */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the migration files are; the package's own `migrations/` by default. */
  readonly migrationsDir?: string;
}

export interface Store {
  /** The `workspace.db` file this store owns. */
  readonly path: string;
  /** The highest applied migration number (03 §12 point 5). */
  readonly schemaVersion: number;
  /** `<userData>/blobs`, the content-addressed directory (03 §12 point 1). */
  readonly blobsDir: string;
  /** Reads in one consistent snapshot. */
  read<T>(fn: (tx: ReadTx) => T): T;
  /** One command, one `BEGIN IMMEDIATE` transaction (03 §12 point 4). */
  command<T>(context: CommandContext, fn: (tx: WriteTx) => T): T;
  close(): void;
}

function configure(db: DatabaseHandle): void {
  // WAL (03 §12 point 1); FULL keeps a committed transaction on disk before the command
  // returns, so killing the process cannot lose a committed claim (AC-03-07).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

export function openStore(options: StoreOptions): Store {
  const { userDataDir } = options;
  assertAbsolute(userDataDir);
  assertNotSyncedFolder(userDataDir, options.env);
  mkdirSync(userDataDir, { recursive: true });
  const blobs = blobsDir(userDataDir);
  mkdirSync(blobs, { recursive: true });

  const now = options.now ?? (() => new Date().toISOString());
  const path = workspaceDbPath(userDataDir);
  const db = new Database(path);
  configure(db);
  applyMigrations(db, readMigrations(options.migrationsDir), now);

  const repository = new Repository(db, {
    now,
    ulid: createUlidFactory(options.random),
  });
  const schemaVersion = currentSchemaVersion(db);

  return {
    path,
    schemaVersion,
    blobsDir: blobs,

    read<T>(fn: (tx: ReadTx) => T): T {
      if (db.inTransaction) return fn(repository.readTx());
      db.exec('BEGIN DEFERRED');
      try {
        const result = fn(repository.readTx());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    command<T>(context: CommandContext, fn: (tx: WriteTx) => T): T {
      if (db.inTransaction) {
        throw new StoreError('E_USAGE', 'a command cannot run inside another command', [
          'one transaction per command (03 §12 point 4): finish the outer command first',
        ]);
      }
      db.exec('BEGIN IMMEDIATE');
      repository.resetCounts();
      try {
        const result = fn(repository.writeTx(context));
        const { projections, events } = repository.counts;
        if (projections > 0 && events === 0) {
          throw new StoreError(
            'E_INVARIANT',
            'a command that changes records must append its events in the same transaction',
            ['03 §12 point 4: each transaction writes the projection rows and the events rows'],
          );
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close(): void {
      db.close();
    },
  };
}
