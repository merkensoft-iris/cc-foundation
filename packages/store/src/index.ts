/**
 * @cc/store: SQLite, repository layer, event log, FTS and export (03 §12, 04 §9).
 *
 * One SQLite database per workspace in WAL mode, opened from `<userData>` and refused inside
 * a synced folder. Every write is one command in one `BEGIN IMMEDIATE` transaction that
 * writes the projection rows and the matching `events` rows together; a stale `version`
 * fails `E_CONFLICT`. Only packages/core imports this package (dependency rule D5).
 *
 * Backups and the restore test are P1-17; the local API and `cc-axi` surfaces of
 * `export.run` and `cc-axi export --out <dir>` are P1-04 and P1-05 (09 §6.1).
 */
export const PACKAGE_NAME = '@cc/store';

export { StoreError, type StoreErrorCode, type StoreErrorData } from './errors.js';
export { createUlidFactory, eventId, type RandomBytes, type UlidFactory } from './ids.js';
export {
  assertNotSyncedFolder,
  blobPath,
  blobsDir,
  syncedFolderMatch,
  SYNC_ROOT_ENV_VARS,
  SYNC_ROOTS,
  workspaceDbPath,
  WORKSPACE_DB,
  type SyncedFolderMatch,
  type SyncRoot,
} from './location.js';
export {
  appliedMigrations,
  applyMigrations,
  currentSchemaVersion,
  migrationNumber,
  MIGRATIONS_DIR,
  readMigrations,
  sha256Hex,
  type AppliedMigration,
  type Migration,
} from './migrations.js';
export {
  isTableName,
  tableNames,
  tableSpec,
  tableSpecs,
  unvalidatedTables,
  type ColumnKind,
  type ColumnSpec,
  type ExecutionStepRow,
  type FtsSpec,
  type StoreRecords,
  type TableName,
  type TableSpec,
  type UnspecifiedRecord,
  type VerificationRow,
} from './tables.js';
export {
  type CommandContext,
  type EventInput,
  type ListOptions,
  type ReadTx,
  type SearchOptions,
  type WriteTx,
} from './repository.js';
export { ftsQuery, type SearchHit } from './search.js';
export { openStore, type Store, type StoreOptions } from './store.js';
export {
  exportWorkspace,
  MANIFEST_NAME,
  type ExportedFile,
  type ExportedTable,
  type ExportManifest,
  type ExportOptions,
  type ExportResult,
} from './export.js';
