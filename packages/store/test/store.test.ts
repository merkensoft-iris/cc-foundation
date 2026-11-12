/**
 * Opening the store: one SQLite database per workspace in WAL mode in `<userData>`
 * (03 §12 point 1, 04 §9), refused inside a synced folder (04 §9 rule 5).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { createProfileDir } from '@cc/test-kit';
import {
  openStore,
  readMigrations,
  StoreError,
  syncedFolderMatch,
  workspaceDbPath,
} from '@cc/store';

import { openTestStore } from './support/reference.js';

const open = (dir: string, env: NodeJS.ProcessEnv = {}) =>
  openStore({ userDataDir: dir, env, now: () => '2026-11-13T09:00:00Z' });

function expectStoreError(fn: () => unknown, code: string): StoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe(code);
    return error as StoreError;
  }
  throw new Error(`expected ${code}`);
}

describe('openStore', () => {
  const profiles: { cleanup(): void }[] = [];
  afterEach(() => {
    while (profiles.length > 0) profiles.pop()?.cleanup();
  });

  it('creates workspace.db and the blob directory in the data directory (04 §9)', () => {
    const profile = createProfileDir();
    profiles.push(profile);
    const store = open(profile.path);
    try {
      expect(store.path).toBe(workspaceDbPath(profile.path));
      expect(existsSync(store.path)).toBe(true);
      expect(existsSync(join(profile.path, 'blobs'))).toBe(true);
      expect(store.schemaVersion).toBe(readMigrations().length);
    } finally {
      store.close();
    }
  });

  it('opens in WAL mode (03 §12 point 1)', () => {
    const test = openTestStore();
    profiles.push(test);
    // WAL writes a -wal sidecar as soon as the first transaction runs.
    expect(existsSync(`${test.store.path}-wal`)).toBe(true);
    const reader = new Database(test.store.path, { readonly: true });
    try {
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      reader.close();
    }
  });

  it('C-04-09 refuses a data directory inside a synced folder, with help to move it', () => {
    for (const dir of [
      '/Users/someone/Library/CloudStorage/GoogleDrive-someone/My Drive/CC',
      '/home/someone/Dropbox (Personal)/CC',
      '/home/someone/OneDrive - Example/CC',
      '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/CC',
      '/home/someone/pCloud Drive/CC',
    ]) {
      const error = expectStoreError(() => open(dir), 'E_GUARD_SYNCED_FOLDER');
      expect(error.help.join(' ')).toContain('move the data directory');
      expect(error.data.code).toBe('E_GUARD_SYNCED_FOLDER');
    }
  });

  it('refuses a data directory under a sync root named by the environment', () => {
    const error = expectStoreError(
      () => open('/home/someone/sync-target/CC', { OneDrive: '/home/someone/sync-target' }),
      'E_GUARD_SYNCED_FOLDER',
    );
    expect(error.message).toContain('OneDrive');
  });

  it('allows a directory that merely mentions a sync product in a longer name', () => {
    expect(syncedFolderMatch('/home/someone/dropbox-notes/CC', {})).toBeUndefined();
    expect(syncedFolderMatch('/home/someone/.config/Command Center', {})).toBeUndefined();
  });

  it('refuses a relative data directory', () => {
    expectStoreError(() => open('relative/path'), 'E_USAGE');
  });

  it('refuses a command inside a command: one transaction per command (03 §12 point 4)', () => {
    const test = openTestStore();
    profiles.push(test);
    expectStoreError(
      () =>
        test.store.command({ actor: { kind: 'user' } }, () => {
          test.store.command({ actor: { kind: 'user' } }, () => undefined);
        }),
      'E_USAGE',
    );
  });
});
