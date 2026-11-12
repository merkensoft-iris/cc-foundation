/**
 * Migration 0003_onboarding: upgrading a snapshot of the schema as it stood after 0002
 * (03 §12 point 5). The snapshot is packages/store/test/migrations/snapshots/0003_previous.sql.
 * 0003 adds the onboarding table (01 §3, §9.1; P1-12); no earlier row has to be carried over,
 * so the test checks that the rows already there are untouched and the new table has the
 * columns of the Onboarding record.
 */
import { describe, expect, it } from 'vitest';

import { tableSpec } from '@cc/store';

import { openSnapshotDatabase } from '../support/migrations.js';

describe('migration 0003_onboarding', () => {
  it('upgrades a snapshot of the 0002 schema, adding the onboarding table with its columns', () => {
    const snapshot = openSnapshotDatabase(3, undefined, (db) => {
      db.prepare(
        'INSERT INTO workspace (id, display_name, time_zone, self_person_id, counters, ' +
          'created_at, created_by, updated_at, updated_by, version) VALUES ' +
          "('wsp_main', 'Main', 'Asia/Kolkata', 'per_self', '{}', '2026-11-04T04:10:00Z', " +
          '\'{"kind":"user"}\', \'2026-11-04T04:10:00Z\', \'{"kind":"user"}\', 1)',
      ).run();
    });
    try {
      expect(snapshot.schemaVersion()).toBe(3);
      expect(snapshot.columns('onboarding')).toEqual(
        tableSpec('onboarding').columns.map((column) => column.column),
      );
      const kept = snapshot.db.prepare('SELECT id, display_name FROM workspace').all();
      expect(kept).toEqual([{ id: 'wsp_main', display_name: 'Main' }]);
      expect(snapshot.db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      snapshot.cleanup();
    }
  });
});
