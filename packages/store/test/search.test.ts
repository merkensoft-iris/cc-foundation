/**
 * `fts_items`, the FTS5 index over titles, done-means and notes (03 §12 point 2), kept in
 * sync with the tables it indexes inside the same transactions.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { ActionItem } from '@cc/schemas';
import { ftsQuery } from '@cc/store';

import {
  openTestStore,
  seedReferenceWorkspace,
  USER,
  type TestStore,
} from './support/reference.js';

describe('fts_items', () => {
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

  it('finds an action item by a word in its title', () => {
    const { store } = seeded();
    const hits = store.read((tx) => tx.search('phased pricing', { tables: ['action_items'] }));
    expect(hits.map((hit) => hit.ref)).toEqual(['A-0142']);
    expect(hits[0]?.snippet).toContain('[phased]');
  });

  it('indexes done-means and notes as well as titles', () => {
    const { store } = seeded();
    expect(
      store
        .read((tx) => tx.search('"sent from the Alderwick mailbox"', { tables: ['action_items'] }))
        .map((h) => h.id),
    ).toEqual(['act_a0142']);
    expect(
      store
        .read((tx) => tx.search('"two proposals pending"', { tables: ['goals'] }))
        .map((h) => h.id),
    ).toEqual(['goal_g0004']);
  });

  it('searches across the record kinds that have titles (03 §12 point 2)', () => {
    const { store } = seeded();
    const kinds = new Set(store.read((tx) => tx.search('consulting')).map((hit) => hit.table));
    expect(kinds.has('action_items')).toBe(true);
    expect(kinds.has('goals')).toBe(true);
    expect(kinds.has('measures')).toBe(true);
  });

  it('replaces the index entry when the record changes', () => {
    const { store } = seeded();
    const item: ActionItem = store.read((tx) => tx.require('action_items', 'act_a0142'));
    store.command({ actor: USER }, (tx) => {
      tx.update(
        'action_items',
        { ...item, title: 'Send the quarterly retainer renewal' },
        item.version,
      );
      tx.event({ type: 'action_item.updated', entity: { kind: 'action_item', id: item.id } });
    });
    expect(store.read((tx) => tx.search('phased pricing', { tables: ['action_items'] }))).toEqual(
      [],
    );
    expect(
      store
        .read((tx) => tx.search('retainer renewal', { tables: ['action_items'] }))
        .map((h) => h.id),
    ).toEqual(['act_a0142']);
  });

  it('leaves no index entry behind when the command rolls back', () => {
    const { store } = seeded();
    const item: ActionItem = store.read((tx) => tx.require('action_items', 'act_a0142'));
    expect(() =>
      store.command({ actor: USER }, (tx) => {
        tx.update('action_items', { ...item, title: 'Rolled back title' }, item.version);
        tx.event({ type: 'action_item.updated', entity: { kind: 'action_item', id: item.id } });
        throw new Error('stop');
      }),
    ).toThrowError('stop');
    expect(store.read((tx) => tx.search('"Rolled back title"'))).toEqual([]);
    expect(
      store
        .read((tx) => tx.search('phased pricing', { tables: ['action_items'] }))
        .map((h) => h.id),
    ).toEqual(['act_a0142']);
  });

  it('takes what a person typed rather than FTS5 syntax', () => {
    expect(ftsQuery('phased pricing')).toBe('"phased" "pricing"');
    expect(ftsQuery('OR AND NOT')).toBe('"OR" "AND" "NOT"');
    expect(ftsQuery('audit*')).toBe('"audit"*');
    expect(ftsQuery('"revised proposal" lead')).toBe('"revised proposal" "lead"');
    expect(ftsQuery('   ')).toBe('');
    const { store } = seeded();
    expect(() => store.read((tx) => tx.search('NEAR( "a" "b"'))).not.toThrow();
    expect(store.read((tx) => tx.search(''))).toEqual([]);
  });
});
