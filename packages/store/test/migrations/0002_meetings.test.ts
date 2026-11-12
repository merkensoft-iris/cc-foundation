/**
 * Migration 0002_meetings: upgrading a snapshot of the schema as it stood after 0001
 * (03 §12 point 5). The snapshot is packages/store/test/migrations/snapshots/0002_previous.sql.
 * 0001 stored meeting_series and meeting_instances in the `doc` envelope; 0002 gives them the
 * columns of MeetingSeries and MeetingInstance (02 §3) and carries envelope rows over.
 */
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { tableSpec } from '@cc/store';

import { openSnapshotDatabase } from '../support/migrations.js';
import { readFixtures } from '../support/reference.js';

const TABLES = [
  { type: 'meeting_series', table: 'meeting_series' },
  { type: 'meeting_instance', table: 'meeting_instances' },
] as const;

/** Writes every meeting fixture into the 0001 envelope, as a pre-0002 store would hold it. */
function seedEnvelopes(db: Database): void {
  for (const { type, table } of TABLES) {
    const insert = db.prepare(
      `INSERT INTO ${table} (id, doc, created_at, created_by, updated_at, updated_by, version) ` +
        'VALUES (@id, @doc, @createdAt, @createdBy, @updatedAt, @updatedBy, @version)',
    );
    for (const record of readFixtures(type)) {
      insert.run({
        id: record['id'],
        doc: JSON.stringify(record),
        createdAt: record['createdAt'],
        createdBy: JSON.stringify(record['createdBy']),
        updatedAt: record['updatedAt'],
        updatedBy: JSON.stringify(record['updatedBy']),
        version: 3,
      });
    }
  }
}

describe('migration 0002_meetings', () => {
  it('upgrades a snapshot of the 0001 schema', () => {
    const snapshot = openSnapshotDatabase(2);
    try {
      expect(snapshot.schemaVersion()).toBe(2);
      for (const { table } of TABLES) {
        expect(snapshot.columns(table), table).toEqual(
          tableSpec(table).columns.map((column) => column.column),
        );
      }
      expect(snapshot.db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      snapshot.cleanup();
    }
  });

  it('carries envelope rows over field by field, with their audit columns and version', () => {
    const snapshot = openSnapshotDatabase(2, undefined, seedEnvelopes);
    try {
      const series = snapshot.db
        .prepare<[], Record<string, unknown>>(
          "SELECT * FROM meeting_series WHERE id = 'ser_ceo_weekly'",
        )
        .get();
      const weekly = readFixtures('meeting_series').find((s) => s['id'] === 'ser_ceo_weekly');
      expect(series?.['name']).toBe(weekly?.['name']);
      expect(series?.['rrule']).toBe(weekly?.['rrule']);
      expect(series?.['duration_minutes']).toBe(weekly?.['durationMinutes']);
      expect(JSON.parse(String(series?.['workstream_ids']))).toEqual(weekly?.['workstreamIds']);
      expect(JSON.parse(String(series?.['created_by']))).toEqual(weekly?.['createdBy']);
      expect(series?.['version']).toBe(3);

      const instance = snapshot.db
        .prepare<[], Record<string, unknown>>(
          "SELECT * FROM meeting_instances WHERE id = 'mtg_m0030'",
        )
        .get();
      const m0030 = readFixtures('meeting_instance').find((i) => i['id'] === 'mtg_m0030');
      expect(instance?.['series_id']).toBe(m0030?.['seriesId']);
      expect(instance?.['state']).toBe(m0030?.['state']);
      expect(instance?.['absorbed_by']).toBe(m0030?.['absorbedBy'] ?? null);
      expect(instance?.['actual_start']).toBeNull();
      expect(JSON.parse(String(instance?.['outputs']))).toEqual(m0030?.['outputs']);

      for (const { type, table } of TABLES) {
        const count = snapshot.db
          .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`)
          .get();
        expect(count?.n, table).toBe(readFixtures(type).length);
      }
    } finally {
      snapshot.cleanup();
    }
  });

  it('fails rather than drops an envelope row whose doc lacks a required field', () => {
    expect(() =>
      openSnapshotDatabase(2, undefined, (db) => {
        db.prepare(
          'INSERT INTO meeting_series (id, doc, created_at, created_by, updated_at, updated_by, ' +
            "version) VALUES ('ser_bad', '{}', '2026-11-13T09:00:00Z', '{\"kind\":\"user\"}', " +
            '\'2026-11-13T09:00:00Z\', \'{"kind":"user"}\', 1)',
        ).run();
      }),
    ).toThrow();
  });
});
