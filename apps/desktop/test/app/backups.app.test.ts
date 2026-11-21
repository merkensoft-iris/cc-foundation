/**
 * P1-15 and P1-17, backups in the app (04 §9.1; 08 §8 item 4): the passphrase, "last good
 * backup" on Home and in Settings → Backups, and the human-only restore. Setting the
 * passphrase, running a backup or the restore test and restoring are human-only (04 §4.3), so
 * this run does them by clicking the screens.
 *
 * The profile is the reference scenario with a folder destination, set through the core as the
 * user before the app opens it. In the app the user sets a passphrase (main derives the key and
 * keeps it with `safeStorage`) and backs up; that archive is then corrupted in the folder, the
 * restore test fails, and a second backup is restored from the history.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHeadless } from '@cc/core/headless';
import { createProfileDir, FakeTimerClock, seedScenario, type ProfileDir } from '@cc/test-kit';

import { launchApp, type RunningApp } from './electron.ts';

const ARCHIVE = /^cc-backup-\d{8}T\d{6}Z-(bkp_[0-9A-Z]{26})\.ccb$/;

let profile: ProfileDir;
let folder: ProfileDir;
let running: RunningApp | undefined;
const ids = { corrupted: '', good: '' };

/** The archive IDs in a directory, oldest first. */
function archives(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => ARCHIVE.test(name))
    .sort()
    .map((name) => ARCHIVE.exec(name)?.[1] ?? '');
}

function app(): RunningApp {
  if (running === undefined) throw new Error('the app is not running');
  return running;
}

/** Waits until the status line says `text`; a failure shows what it said instead. */
async function flashSays(text: string | RegExp): Promise<void> {
  await expect
    .poll(async () => (await app().byTest('flash').allTextContents()).join(' | '), {
      timeout: 60_000,
    })
    .toMatch(text);
}

/** Settings opens on its Overview; Backups is a section of the Settings menu. */
async function openBackups(): Promise<void> {
  await app().byTest('nav-settings').click();
  await app().byTest('overview').waitFor();
  await app().byTest('tab-backups').click();
  await app().byTest('backup-status').waitFor();
}

/** Past backups, restore and the restore check are under Advanced; it stays open once opened. */
async function openAdvanced(): Promise<void> {
  if ((await app().byTest('backups-advanced').count()) === 0) {
    await app().byTest('backups-advanced-toggle').click();
  }
  await app().byTest('backups-advanced').waitFor();
}

beforeAll(async () => {
  profile = createProfileDir();
  folder = createProfileDir();
  const s = await seedScenario({ profileDir: profile.path });
  try {
    await s.advanceTo('2026-11-10T11:00');
    await s.core.callAsUser('backups.destination', {
      destination: { kind: 'folder', label: 'Synced folder', path: folder.path },
    });
  } finally {
    await s.stop();
  }
  running = await launchApp(profile.path);
}, 120_000);

afterAll(async () => {
  await running?.close();
  profile?.cleanup();
  folder?.cleanup();
});

describe('P1-17 backups in the app', { timeout: 120_000 }, () => {
  it('04 §9.1 rules 3 and 5: the passphrase is set in Settings → Backups, and a backup reaches the folder as one encrypted archive', async () => {
    await openBackups();
    const passphrase = 'lantern over quillmarsh harbour';
    await app().byTest('settings-backup-passphrase').fill(passphrase);
    await app().byTest('settings-backup-passphrase-confirm').fill(passphrase);
    await app().byTest('settings-backup-passphrase-set').click();
    await flashSays('Backup password set.');

    await app().byTest('backup-run').click();
    await flashSays('Backup written.');
    await expect.poll(() => archives(folder.path).length, { timeout: 60_000 }).toBe(1);
    ids.corrupted = archives(folder.path)[0] ?? '';
    // C-04-09: the folder holds archives only, never the database or its WAL.
    expect(fs.readdirSync(folder.path).filter((name) => !ARCHIVE.test(name))).toEqual([]);
  });

  it('AC-04-11 a corrupted off-machine archive fails the restore test: failing in Settings → Backups and on Home, and the archive is not offered for restore', async () => {
    const name = fs.readdirSync(folder.path).find((entry) => entry.includes(ids.corrupted));
    if (name === undefined) throw new Error('no archive in the folder');
    const file = path.join(folder.path, name);
    const bytes = fs.readFileSync(file);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
    fs.writeFileSync(file, bytes);

    await openAdvanced();
    await app().byTest('backup-test').click();
    await flashSays(/The restore check failed/);
    await expect.poll(() => app().byTest('backup-state').textContent()).toBe('Not working');
    await expect(app().byTest('backup-last-test').textContent()).resolves.toMatch(/Failed/);
    await app().byTest(`backup-${ids.corrupted}`).waitFor();
    await expect(app().byTest(`restore-${ids.corrupted}`).count()).resolves.toBe(0);

    await app().byTest('nav-home').click();
    await app().byTest('home-backup').waitFor();
    await expect(app().byTest('home-backup').textContent()).resolves.toMatch(/\(backups failing\)/);
    await expect(app().byTest('attention-backup').textContent()).resolves.toMatch(
      /Backups failing/,
    );
  });

  it('AC-04-11 C-04-10 restoring a good archive in the app first backs up the current store, then the core restarts on the restored one', async () => {
    // Retention keeps the newest archive of each day (rule 4), so in one day of real time the
    // good archive is the next one; the core test covers the previous day's archive.
    await openBackups();
    await app().byTest('backup-run').click();
    await expect
      .poll(() => archives(folder.path).find((id) => id !== ids.corrupted) ?? '', {
        timeout: 60_000,
      })
      .not.toBe('');
    ids.good = archives(folder.path).find((id) => id !== ids.corrupted) ?? '';
    await openAdvanced();
    await app().byTest(`restore-${ids.good}`).click();
    await app().byTest(`restore-now-${ids.good}`).click();
    await flashSays(/the current data was backed up first/);
    // The restart applies the staged restore before the store opens (04 §9.1 rule 9).
    await expect
      .poll(() => fs.existsSync(path.join(profile.path, 'restore', 'replaced', 'workspace.db')), {
        timeout: 60_000,
      })
      .toBe(true);
    await expect
      .poll(() => fs.existsSync(path.join(profile.path, 'restore', 'pending.json')), {
        timeout: 60_000,
      })
      .toBe(false);
  });

  it('the history records the pre-restore backup after the app closes', async () => {
    await app().close();
    running = undefined;
    const core = await startHeadless({
      profileDir: profile.path,
      clock: new FakeTimerClock('2026-11-10T06:00:00Z'),
      env: {},
    });
    try {
      const list = (await core.callAsUser('backups.list', {})) as {
        backups: { id: string; trigger: string; verified?: { ok: boolean } }[];
      };
      expect(list.backups.map((backup) => backup.trigger)).toEqual([
        'pre_restore',
        'manual',
        'manual',
      ]);
      expect(list.backups[1]?.id).toBe(ids.good);
      expect(list.backups[2]).toMatchObject({ id: ids.corrupted, verified: { ok: false } });
    } finally {
      await core.stop();
    }
  });
});
