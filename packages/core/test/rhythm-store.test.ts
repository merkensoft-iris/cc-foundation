/**
 * The rhythm engine on the workspace store (P1-07 on P1-02): the P1-07 acceptance suite of
 * packages/rhythm/test runs `extendHorizon` and `runMissedCheck` against `storeRhythmStore`
 * over a real SQLite store in a throwaway profile directory, and the store-specific rules of
 * the wiring are checked here: one transaction per job, one event per record, and a stale
 * version refused (03 §12 point 4, INV-03-09).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Change } from '@cc/domain';
import { extendHorizon, markScheduled, runMissedCheck, startMeeting } from '@cc/rhythm';
import type { Issue, MeetingInstance, MeetingSeries } from '@cc/schemas';
import { openStore, StoreError, type Store } from '@cc/store';
import { createProfileDir } from '@cc/test-kit';

import { storeRhythmStore } from '../src/rhythm-store.js';
import { busyReasons } from '../src/service.js';
import { describeAcceptance } from '../../rhythm/test/acceptance-suite.ts';
import {
  checkChanges,
  harness,
  scenarioPlacement,
  scenarioSeries,
  seriesById,
  rhythm,
  user,
  type TestRhythmStore,
} from '../../rhythm/test/harness.ts';

const opened: (() => void)[] = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

/** A workspace store in a fresh profile directory, closed and removed after the test. */
function workspaceStore(): Store {
  const profile = createProfileDir();
  let tick = 0;
  const store = openStore({
    userDataDir: profile.path,
    now: () => new Date(Date.parse('2026-11-04T04:10:00Z') + tick++ * 1000).toISOString(),
    random: (size) => Uint8Array.from({ length: size }, (_, index) => (tick + index) % 251),
    env: {},
  });
  opened.push(() => {
    store.close();
    profile.cleanup();
  });
  return store;
}

/** Writes the series as the user created them, each with its event, in one command. */
function seedSeries(store: Store, series: readonly MeetingSeries[]): void {
  store.command({ actor: { kind: 'user' } }, (tx) => {
    for (const record of series) {
      tx.insert('meeting_series', record);
      tx.event({
        type: 'meeting_series.created',
        entity: { kind: 'meeting_series', id: record.id },
        after: record,
      });
    }
  });
}

/** `storeRhythmStore` on a fresh workspace store, as the acceptance suite inspects it. */
function sqliteStore(series: readonly MeetingSeries[]): TestRhythmStore & { readonly db: Store } {
  const db = workspaceStore();
  seedSeries(db, series);
  const store = storeRhythmStore(db);
  const commits: (readonly Change[])[] = [];
  return {
    db,
    listSeries: () => store.listSeries(),
    listInstances: (ids) => store.listInstances(ids),
    openRhythmIssues: () => store.openRhythmIssues(),
    commit(changes) {
      checkChanges(changes);
      store.commit(changes);
      commits.push([...changes]);
    },
    get instances() {
      return new Map<string, MeetingInstance>(
        db.read((tx) => tx.list('meeting_instances')).map((i) => [i.id, i]),
      );
    },
    get issues() {
      return new Map<string, Issue>(db.read((tx) => tx.list('issues')).map((i) => [i.id, i]));
    },
    commits,
  };
}

describe('the rhythm engine on the workspace store', () => {
  describeAcceptance(sqliteStore);

  it('AC-02-01 one horizon extension is one transaction: every instance with its created event', () => {
    const { ctx } = harness('2026-11-04T04:10:00Z');
    const store = sqliteStore(scenarioSeries());
    const before = store.db.read((tx) => tx.count('events'));
    const result = extendHorizon(store, ctx, scenarioPlacement());
    const instances = store.db.read((tx) => tx.list('meeting_instances'));
    expect(instances).toHaveLength(result.instances.length);
    expect(store.db.read((tx) => tx.count('events'))).toBe(before + result.changes.length);
    for (const instance of instances.slice(0, 5)) {
      const history = store.db.read((tx) => tx.history('meeting_instance', instance.id));
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]?.type).toBe('meeting_instance.materialised');
      expect(history[0]?.actor).toEqual({ kind: 'system', component: 'rhythm' });
    }
    // Read back from SQLite, the records are the ones the engine computed.
    const byId = new Map(instances.map((i) => [i.id, i]));
    for (const computed of result.instances) expect(byId.get(computed.id)).toEqual(computed);
  });

  it('a meeting in progress keeps the app from being idle, so Rebuild now waits to restart (04 §10 rule 2)', () => {
    const { ctx, clock } = harness('2026-11-04T04:10:00Z');
    const store = sqliteStore([seriesById('ser_ceo_weekly')]);
    extendHorizon(store, ctx, scenarioPlacement());
    expect(busyReasons(store.db)).toEqual([]);
    const [first] = store.listInstances(['ser_ceo_weekly']);
    clock.set('2026-11-05T04:00:00Z');
    store.commit(markScheduled(ctx, rhythm, first!).changes);
    const started = startMeeting(ctx, user, store.instances.get(first!.id)!);
    store.commit(started.changes);
    expect(busyReasons(store.db)).toEqual(['1 meeting in progress']);
  });

  it('writes a state transition over the version it read, and refuses a stale one with E_CONFLICT', () => {
    const { ctx, clock } = harness('2026-11-04T04:10:00Z');
    const store = sqliteStore([seriesById('ser_ceo_weekly')]);
    extendHorizon(store, ctx, scenarioPlacement());
    const [first] = store.listInstances(['ser_ceo_weekly']);
    expect(first?.state).toBe('planned');
    clock.set('2026-11-05T04:00:00Z');
    const scheduled = markScheduled(ctx, rhythm, first!);
    store.commit(scheduled.changes);
    const stored = store.instances.get(first!.id);
    expect(stored?.state).toBe('scheduled');
    expect(stored?.version).toBe(first!.version + 1);
    expect(
      store.db.read((tx) => tx.history('meeting_instance', first!.id)).map((e) => e.type),
    ).toEqual(['meeting_instance.materialised', scheduled.changes[0]!.event.type]);

    // The same transition again builds on the version it read, which is now stale.
    let error: unknown;
    try {
      store.commit(markScheduled(ctx, rhythm, first!).changes);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe('E_CONFLICT');
    expect(store.instances.get(first!.id)?.version).toBe(stored?.version);
  });

  it('AC-02-07 the missed check commits the misses and the escalation issue together', () => {
    const { ctx, clock } = harness('2026-11-04T04:10:00Z');
    const store = sqliteStore([seriesById('ser_ceo_weekly')]);
    extendHorizon(store, ctx, scenarioPlacement());
    clock.set('2026-11-13T12:00:00Z');
    runMissedCheck(store, ctx);
    clock.set('2026-11-20T12:00:00Z');
    const events = store.db.read((tx) => tx.count('events'));
    const second = runMissedCheck(store, ctx);
    expect(second.escalations).toHaveLength(1);
    expect(store.openRhythmIssues().map((i) => i.id)).toEqual([second.escalations[0]!.issue.id]);
    expect(store.db.read((tx) => tx.count('events'))).toBe(events + second.changes.length);
    expect(
      store.db.read((tx) => tx.history('issue', second.escalations[0]!.issue.id)),
    ).toHaveLength(1);
  });
});
