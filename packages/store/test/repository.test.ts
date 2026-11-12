/**
 * The repository layer (03 §12 point 4): one command, one `BEGIN IMMEDIATE` transaction that
 * writes the projection rows and the matching `events` rows together, with optimistic
 * concurrency on `version` and `E_CONFLICT` for a stale write (07 §4.4).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { ActionItem, Actor } from '@cc/schemas';
import { StoreError } from '@cc/store';

import {
  openTestStore,
  readFixtures,
  seedReferenceWorkspace,
  USER,
  type TestStore,
} from './support/reference.js';

const AGENT: Actor = { kind: 'agent', principalId: 'agt_cli_default' };

function a0142(store: TestStore['store']): ActionItem {
  return store.read((tx) => tx.require('action_items', 'act_a0142'));
}

function storeError(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StoreError) return error;
    throw error;
  }
  throw new Error('expected a StoreError');
}

describe('the repository layer', () => {
  const open: TestStore[] = [];
  afterEach(() => {
    while (open.length > 0) open.pop()?.cleanup();
  });

  function seeded(): TestStore {
    const test = openTestStore();
    open.push(test);
    seedReferenceWorkspace(test.store);
    return test;
  }

  it('round-trips every worked-example record through its columns (03 §12 point 3)', () => {
    const { store } = seeded();
    for (const fixture of readFixtures('action_item')) {
      const read = store.read((tx) => tx.get('action_items', String(fixture['id'])));
      expect(read).toEqual({ version: 1, ...fixture });
    }
    expect(store.read((tx) => tx.get('measure_values', 'mv_k0003_2026w46'))).toEqual({
      version: 1,
      ...readFixtures('measure_value')[0],
    });
    expect(store.read((tx) => tx.get('workspace', 'wsp_main'))).toEqual(
      readFixtures('workspace')[0],
    );
  });

  it('writes the projection rows and the events row in one transaction (03 §12 point 4)', () => {
    const { store } = seeded();
    const before = a0142(store);
    const claimed: ActionItem = {
      ...before,
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-12T05:01:00Z', by: AGENT, note: 'Sent and filed.' },
    };
    store.command({ actor: AGENT, correlationId: 'run_03' }, (tx) => {
      tx.update('action_items', claimed, before.version);
      tx.event({
        type: 'action_item.claimed',
        entity: { kind: 'action_item', id: before.id, ref: before.ref },
        before: { lifecycle: before.lifecycle },
        after: { lifecycle: 'claimed_done' },
      });
    });
    const after = a0142(store);
    expect(after.lifecycle).toBe('claimed_done');
    expect(after.version).toBe(before.version + 1);
    const history = store.read((tx) => tx.history('action_item', before.id));
    const claim = history.at(-1);
    expect(claim?.type).toBe('action_item.claimed');
    expect(claim?.actor).toEqual(AGENT);
    expect(claim?.correlationId).toBe('run_03');
    expect(claim?.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('fails E_CONFLICT on a write against a stale version (03 §12 point 4)', () => {
    const { store } = seeded();
    const before = a0142(store);
    store.command({ actor: USER }, (tx) => {
      tx.update(
        'action_items',
        { ...before, health: 'at_risk', healthNote: 'Waiting.' },
        before.version,
      );
      tx.event({ type: 'action_item.updated', entity: { kind: 'action_item', id: before.id } });
    });
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...before, health: 'off_track' }, before.version);
        tx.event({ type: 'action_item.updated', entity: { kind: 'action_item', id: before.id } });
      }),
    );
    expect(error.code).toBe('E_CONFLICT');
    expect(error.data).toEqual({
      code: 'E_CONFLICT',
      message: expect.stringContaining('act_a0142'),
      help: ['re-read the record and retry the command with its current version'],
    });
    expect(a0142(store).health).toBe('at_risk');
  });

  it('fails E_CONFLICT rather than overwriting a record that already exists', () => {
    const { store } = seeded();
    const item = a0142(store);
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.insert('action_items', { ...item, version: 1, title: 'A different item' });
      }),
    );
    expect(error.code).toBe('E_CONFLICT');
    expect(error.message).toContain('already exists');
    expect(a0142(store)).toEqual(item);
  });

  it('fails E_NOT_FOUND when the row is gone', () => {
    const { store } = seeded();
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...a0142(store), id: 'act_missing' }, 1);
      }),
    );
    expect(error.code).toBe('E_NOT_FOUND');
  });

  it('AC-03-07 a failing command leaves neither the projection nor the event', () => {
    const { store } = seeded();
    const before = a0142(store);
    const events = store.read((tx) => tx.count('events'));
    expect(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...before, lifecycle: 'claimed_done' }, before.version);
        tx.event({ type: 'action_item.claimed', entity: { kind: 'action_item', id: before.id } });
        throw new Error('the process gave up here');
      }),
    ).toThrowError('the process gave up here');
    expect(a0142(store)).toEqual(before);
    expect(store.read((tx) => tx.count('events'))).toBe(events);
  });

  it('AC-03-07 refuses a command that changes records without writing its event', () => {
    const { store } = seeded();
    const before = a0142(store);
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...before, lifecycle: 'claimed_done' }, before.version);
      }),
    );
    expect(error.code).toBe('E_INVARIANT');
    expect(a0142(store)).toEqual(before);
  });

  it('keeps execution_steps and verifications in step with their action item', () => {
    const { store } = seeded();
    const before = a0142(store);
    expect(
      store.read((tx) => tx.list('execution_steps')).filter((s) => s.actionItemId === before.id),
    ).toHaveLength(before.execution.steps.length);
    expect(store.read((tx) => tx.get('verifications', before.id))).toBeUndefined();

    const verified: ActionItem = {
      ...before,
      lifecycle: 'verified_done',
      execution: {
        ...before.execution,
        steps: before.execution.steps.map((step) => ({ ...step, status: 'succeeded' as const })),
      },
      verification: {
        method: 'confirmed',
        checks: [],
        decidedBy: USER,
        decidedAt: '2026-11-13T09:40:00Z',
        rejectedClaims: [],
      },
    };
    store.command({ actor: USER }, (tx) => {
      tx.update('action_items', verified, before.version);
      tx.event({ type: 'action_item.verified', entity: { kind: 'action_item', id: before.id } });
    });
    const steps = store
      .read((tx) => tx.list('execution_steps'))
      .filter((s) => s.actionItemId === before.id);
    expect(steps.map((step) => step.status)).toEqual(steps.map(() => 'succeeded'));
    expect(steps.every((step) => step.version === before.version + 1)).toBe(true);
    expect(store.read((tx) => tx.get('verifications', before.id))?.method).toBe('confirmed');
  });

  it('refuses get() on execution_steps, which is keyed by item and step', () => {
    const { store } = seeded();
    expect(storeError(() => store.read((tx) => tx.get('execution_steps', 'act_a0142'))).code).toBe(
      'E_USAGE',
    );
  });

  it('refuses a direct write to a projection table or to the event log', () => {
    const { store } = seeded();
    const item = a0142(store);
    const toProjection = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.insert('execution_steps', {
          ...item.execution.steps[0]!,
          actionItemId: item.id,
          version: 1,
        });
      }),
    );
    expect(toProjection.code).toBe('E_USAGE');
    const toLog = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.insert('events', {
          id: 'evt_0',
          at: '2026-11-13T09:00:00Z',
          actor: USER,
          type: 'action_item.claimed',
          entity: { kind: 'action_item', id: item.id },
          version: 1,
        });
      }),
    );
    expect(toLog.code).toBe('E_USAGE');
  });

  it('rejects a record that does not match its schema in @cc/schemas (03 §12 point 3)', () => {
    const { store } = seeded();
    const item = a0142(store);
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...item, escalationLevel: 9 }, item.version);
      }),
    );
    expect(error.code).toBe('E_INVARIANT');
    expect(error.help.join(' ')).toContain('escalationLevel');
  });

  it('refuses a row of a table whose record type is not written yet unless doc is JSON', () => {
    const { store } = seeded();
    const envelope = {
      id: 'bkp_nightly',
      doc: { placeholder: true },
      createdAt: '2026-11-13T09:00:00Z',
      createdBy: USER,
      updatedAt: '2026-11-13T09:00:00Z',
      updatedBy: USER,
      version: 1,
    };
    store.command({ actor: USER }, (tx) => {
      tx.insert('backup_runs', envelope);
      tx.event({
        type: 'backup_run.created',
        entity: { kind: 'backup_run', id: envelope.id },
      });
    });
    expect(store.read((tx) => tx.get('backup_runs', envelope.id))).toEqual(envelope);
    const error = storeError(() =>
      store.command({ actor: USER }, (tx) => {
        tx.insert('backup_runs', { ...envelope, id: 'bkp_bad', doc: 'not an object' as never });
      }),
    );
    expect(error.code).toBe('E_INVARIANT');
  });

  it('C-03-04 lists an entity history in event order', () => {
    const { store } = seeded();
    const item = a0142(store);
    for (const health of ['at_risk', 'off_track', 'on_track'] as const) {
      const current = a0142(store);
      store.command({ actor: USER }, (tx) => {
        tx.update(
          'action_items',
          { ...current, health, healthNote: health === 'on_track' ? undefined : 'note' },
          current.version,
        );
        tx.event({
          type: 'action_item.health_changed',
          entity: { kind: 'action_item', id: item.id, ref: item.ref },
          before: { health: current.health },
          after: { health },
        });
      });
    }
    const history = store.read((tx) => tx.history('action_item', item.id));
    expect(history.map((event) => event.type)).toEqual([
      'action_item.created',
      'action_item.health_changed',
      'action_item.health_changed',
      'action_item.health_changed',
    ]);
    expect([...history].sort((a, b) => a.id.localeCompare(b.id))).toEqual(history);
  });

  it('removes a record, its projections and its search entries', () => {
    const { store } = seeded();
    const item = a0142(store);
    store.command({ actor: USER }, (tx) => {
      tx.remove('action_items', item.id, item.version);
      tx.event({
        type: 'action_item.removed',
        entity: { kind: 'action_item', id: item.id, ref: item.ref },
        before: item,
      });
    });
    expect(store.read((tx) => tx.get('action_items', item.id))).toBeUndefined();
    expect(
      store.read((tx) => tx.list('execution_steps')).filter((s) => s.actionItemId === item.id),
    ).toEqual([]);
    expect(store.read((tx) => tx.search('phased pricing'))).toEqual([]);
  });
});
