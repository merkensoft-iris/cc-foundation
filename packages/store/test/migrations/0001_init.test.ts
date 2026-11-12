/**
 * Migration 0001_init: the fixture test every migration has (03 §12 point 5). 0001 has no
 * previous schema to upgrade from, so its fixture test is that it applies clean to an empty
 * database and creates the tables of 03 §12 point 2.
 */
import { describe, expect, it } from 'vitest';

import { applyMigrations, readMigrations, tableSpecs } from '@cc/store';

import { openSnapshotDatabase } from '../support/migrations.js';

const TABLES_OF_SECTION_12 = [
  'workspace',
  'persons',
  'workstreams',
  'framework_instances',
  'goals',
  'measures',
  'measure_values',
  'decisions',
  'issues',
  'risks',
  'action_items',
  'execution_steps',
  'runs',
  'evidence',
  'verifications',
  'meeting_series',
  'meeting_instances',
  'connector_installs',
  'connector_bindings',
  'browser_sessions',
  'confirmations',
  'standing_approvals',
  'agent_principals',
  'development_requests',
  'backup_runs',
  'events',
  'fts_items',
];

/** Tables of 03 §12 point 2 that later migrations add: onboarding (0003, P1-12). */
const ADDED_LATER = ['onboarding'];

describe('migration 0001_init', () => {
  it('applies clean to an empty database', () => {
    const snapshot = openSnapshotDatabase(1);
    try {
      expect(snapshot.tables().sort()).toEqual([...TABLES_OF_SECTION_12, 'schema_version'].sort());
      expect(snapshot.schemaVersion()).toBe(1);
      const row = snapshot.db
        .prepare<[], { name: string; sha256: string }>(
          'SELECT name, sha256 FROM schema_version WHERE number = 1',
        )
        .get();
      expect(row?.name).toBe('init');
      expect(row?.sha256).toBe(readMigrations()[0]?.sha256);
      expect(snapshot.db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      snapshot.cleanup();
    }
  });

  it('creates fts_items as an FTS5 index over titles, done-means and notes', () => {
    const snapshot = openSnapshotDatabase(1);
    try {
      expect(snapshot.columns('fts_items')).toEqual([
        'table_name',
        'item_id',
        'ref',
        'title',
        'done_means',
        'notes',
      ]);
      snapshot.db.exec(
        "INSERT INTO fts_items VALUES ('action_items', 'act_1', 'A-0001', 'Send the proposal', " +
          "'Filed in the client folder', '')",
      );
      const hit = snapshot.db
        .prepare<[], { item_id: string }>(
          'SELECT item_id FROM fts_items WHERE fts_items MATCH \'"proposal"\'',
        )
        .get();
      expect(hit?.item_id).toBe('act_1');
    } finally {
      snapshot.cleanup();
    }
  });

  it('applies nothing the second time', () => {
    const snapshot = openSnapshotDatabase(1);
    try {
      const only0001 = readMigrations().filter((migration) => migration.number === 1);
      expect(applyMigrations(snapshot.db, only0001, () => '2026-11-13T09:00:00Z')).toEqual([]);
      expect(snapshot.schemaVersion()).toBe(1);
    } finally {
      snapshot.cleanup();
    }
  });

  it('creates every table the store registry writes to, but those later migrations add', () => {
    const snapshot = openSnapshotDatabase(1);
    try {
      expect(
        tableSpecs
          .map((spec) => spec.table)
          .filter((table) => !ADDED_LATER.includes(table))
          .sort(),
      ).toEqual(TABLES_OF_SECTION_12.filter((table) => table !== 'fts_items').sort());
    } finally {
      snapshot.cleanup();
    }
  });
});
