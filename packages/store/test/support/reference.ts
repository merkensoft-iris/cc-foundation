/**
 * Test support: a store on a throwaway profile directory, seeded from the worked-example
 * record fixtures of 03 §13 (`fixtures/records/<type>@<major>/*.json`), which P1-01 already
 * validates against the generated JSON Schemas. No test uses a fixed path or shares a
 * profile directory, so two worktrees can run the suite at once (C-08-05, AC-08-04).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProfileDir } from '@cc/test-kit';
import type { Actor } from '@cc/schemas';
import {
  openStore,
  type Store,
  type StoreOptions,
  type StoreRecords,
  type TableName,
  type WriteTx,
} from '@cc/store';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURE_RECORDS = join(REPO_ROOT, 'fixtures', 'records');

export const USER: Actor = { kind: 'user' };

/** A deterministic clock: every call returns the next second from 2026-11-13T09:00:00Z. */
export function testClock(start = '2026-11-13T09:00:00Z'): () => string {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1000).toISOString();
}

/** Deterministic bytes for event ULIDs, so an event ID is reproducible in a test. */
export function testRandom(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += size;
    return Uint8Array.from({ length: size }, (_, index) => (counter + index) % 251);
  };
}

export interface TestStore {
  readonly store: Store;
  readonly dir: string;
  cleanup(): void;
}

export function openTestStore(overrides: Partial<StoreOptions> = {}): TestStore {
  const profile = createProfileDir();
  const store = openStore({
    userDataDir: profile.path,
    now: testClock(),
    random: testRandom(),
    env: {},
    ...overrides,
  });
  return {
    store,
    dir: profile.path,
    cleanup: () => {
      store.close();
      profile.cleanup();
    },
  };
}

/** The record fixtures of one type, file name order. */
export function readFixtures(type: string, major = 1): Record<string, unknown>[] {
  const dir = join(FIXTURE_RECORDS, `${type}@${String(major)}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>);
}

/** Record type to table, in an order that reads naturally in a seeded database. */
const SEED_ORDER: readonly { type: string; table: TableName }[] = [
  { type: 'workspace', table: 'workspace' },
  { type: 'person', table: 'persons' },
  { type: 'workstream', table: 'workstreams' },
  { type: 'framework_instance', table: 'framework_instances' },
  { type: 'goal', table: 'goals' },
  { type: 'measure', table: 'measures' },
  { type: 'measure_value', table: 'measure_values' },
  { type: 'decision', table: 'decisions' },
  { type: 'issue', table: 'issues' },
  { type: 'risk', table: 'risks' },
  { type: 'action_item', table: 'action_items' },
  { type: 'run', table: 'runs' },
  { type: 'evidence', table: 'evidence' },
  { type: 'agent_principal', table: 'agent_principals' },
  { type: 'meeting_series', table: 'meeting_series' },
  { type: 'meeting_instance', table: 'meeting_instances' },
];

/** One seeder for every table: the fixture is a record of that table by construction. */
function insertRecord<K extends TableName>(tx: WriteTx, table: K, record: unknown): void {
  tx.insert(table, record as StoreRecords[K]);
}

/**
 * Writes every worked-example record into the store in one command, each with its
 * `<entity>.created` event, and returns how many records were written per table.
 */
export function seedReferenceWorkspace(store: Store): Record<string, number> {
  const counts: Record<string, number> = {};
  store.command({ actor: USER, correlationId: 'seed' }, (tx) => {
    for (const { type, table } of SEED_ORDER) {
      const records = readFixtures(type);
      for (const record of records) {
        const withVersion: Record<string, unknown> = { version: 1, ...record };
        insertRecord(tx, table, withVersion);
        tx.event({
          type: `${type}.created`,
          entity: {
            kind: type,
            id: String(withVersion['id']),
            ...(typeof withVersion['ref'] === 'string' ? { ref: withVersion['ref'] } : {}),
          },
          after: withVersion,
        });
      }
      counts[table] = records.length;
    }
  });
  return counts;
}
