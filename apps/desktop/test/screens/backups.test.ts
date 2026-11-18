/**
 * The backup screens (04 §9.1, 09 P1-17): "Last good backup" and the state on Home, and
 * Settings → Backups with the human-only Restore (AC-04-11, C-04-10), run and test now, the
 * passphrase and the folder destination.
 */
import { describe, expect, it } from 'vitest';

import type { BackupRecord, BackupStatus } from '../../src/renderer/app/api.js';
import { byTest, queryByTest, textOf } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type } from './harness.js';

const PREVIOUS = 'bkp_01KA0000000000000000000001';
const NEWEST = 'bkp_01KA0000000000000000000002';

const home = (backup: unknown) => ({
  workspace: 'main',
  now: '2026-11-13T15:00:00+05:30',
  today: [],
  attention: {
    overdue: 0,
    atRisk: 0,
    awaitingReview: 0,
    confirmationsPending: 0,
    sessionsNeedingYou: 0,
  },
  items: [],
  counts: { dueSoon: 0, open: 0 },
  backup,
});

const failing: BackupStatus = {
  state: 'failing',
  lastGoodLocalAt: '2026-11-12T18:00:00.000Z',
  lastGoodOffMachineAt: '2026-11-12T18:00:00.000Z',
  lastGood: { id: PREVIOUS, at: '2026-11-12T18:00:00.000Z', destination: 'Synced folder' },
  lastRestoreTest: {
    at: '2026-11-13T09:00:00.000Z',
    ok: false,
    detail: 'the backup archive is damaged: chunk 3 fails authentication',
    backupId: NEWEST,
    source: 'off_machine',
  },
  destination: 'Synced folder',
  passphraseSet: true,
  reasons: [
    'The last restore test failed: the backup archive is damaged: chunk 3 fails authentication',
  ],
};

const record = (id: string, at: string, verified?: boolean): BackupRecord => ({
  id,
  at,
  trigger: 'scheduled',
  archiveSha256: 'a'.repeat(64),
  bytes: 4096,
  local: { path: `cc-backup-${id}.ccb`, ok: true },
  offMachine: { destination: 'Synced folder', ok: true },
  ...(verified === undefined ? {} : { verified: { at: '2026-11-13T09:00:00.000Z', ok: verified } }),
});

const history = [
  record(NEWEST, '2026-11-13T18:00:00.000Z', false),
  record(PREVIOUS, '2026-11-12T18:00:00.000Z', true),
];

function backupApi(status: BackupStatus = failing) {
  return {
    'backups.status': () => status,
    'backups.list': () => ({ backups: history, total: history.length }),
    'backups.run': () => ({ backup: history[0], status }),
    'backups.test': () => ({ test: status.lastRestoreTest, status }),
    'backups.restore': (params: Record<string, unknown>) => ({
      status: 'ok',
      preRestoreBackupId: 'bkp_01KA0000000000000000000003',
      restored: params['id'],
    }),
    'backups.passphrase': () => ({ status: 'ok', passphraseSet: true }),
    'backups.destination': () => ({ status: 'ok' }),
  };
}

describe('Home: last good backup (04 §9.1 rule 8)', () => {
  it('AC-04-11 Home shows the last good backup and, while failing, a Needs you entry that opens Settings → Backups', async () => {
    const app = await startApp({
      'home.get': () => home({ state: 'failing', lastGood: failing.lastGood }),
      ...backupApi(),
    });
    expect(textOf(byTest(app.tree(), 'home-backup'))).toMatch(
      /Last good backup: 2026-11-12 18:00 UTC · Synced folder \(backups failing\)/,
    );
    const entry = byTest(app.tree(), 'attention-backup');
    expect(textOf(entry)).toMatch(/Backups failing/);
    const open = entry.children.find(
      (child) => typeof child !== 'string' && child.tag === 'button',
    );
    await click(app, open as never);
    expect(app.app.route).toEqual({ screen: 'settings', tab: 'backups' });
    expect(textOf(byTest(app.tree(), 'backup-last-good'))).toMatch(
      /2026-11-12 18:00 UTC · Synced folder/,
    );
  });

  it('04 §9.1 rule 8: not_configured is no attention item on Home', async () => {
    const app = await startApp({ 'home.get': () => home({ state: 'not_configured' }) });
    expect(queryByTest(app.tree(), 'attention-backup')).toBeUndefined();
    expect(textOf(byTest(app.tree(), 'home-backup'))).toMatch(
      /Last good backup: none yet \(backups not configured\)/,
    );
  });
});

describe('Settings → Backups (04 §9.1)', () => {
  it('AC-04-11 shows the state, the last good backup and the failed restore test with its reason', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    expect(textOf(byTest(app.tree(), 'backup-state'))).toBe('failing');
    expect(textOf(byTest(app.tree(), 'backup-last-test'))).toMatch(
      /failed.*chunk 3 fails authentication/,
    );
    expect(textOf(byTest(app.tree(), 'backup-reasons'))).toMatch(/The last restore test failed/);
    // The archive the test failed cannot be restored; the previous one can.
    expect(queryByTest(app.tree(), `restore-${NEWEST}`)).toBeUndefined();
    expect(queryByTest(app.tree(), `restore-${PREVIOUS}`)).toBeDefined();
  });

  it('AC-04-11 C-04-10 restoring the previous archive in the UI takes a second click, then calls the human-only backups.restore', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    await click(app, byTest(app.tree(), `restore-${PREVIOUS}`));
    expect(app.callsOf('backups.restore')).toEqual([]);
    expect(textOf(byTest(app.tree(), `restore-confirm-${PREVIOUS}`))).toMatch(
      /backs up the current data first, then restores this backup and restarts/,
    );
    await click(app, byTest(app.tree(), `restore-cancel-${PREVIOUS}`));
    expect(queryByTest(app.tree(), `restore-confirm-${PREVIOUS}`)).toBeUndefined();

    await click(app, byTest(app.tree(), `restore-${PREVIOUS}`));
    await click(app, byTest(app.tree(), `restore-now-${PREVIOUS}`));
    expect(app.callsOf('backups.restore')).toEqual([{ id: PREVIOUS }]);
    expect(app.text()).toMatch(/the current data was backed up first/);
  });

  it('04 §9.1 rules 1 and 7: Back up now and Test restore now call the human-only methods', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    await click(app, byTest(app.tree(), 'backup-run'));
    expect(app.callsOf('backups.run')).toEqual([{}]);
    await click(app, byTest(app.tree(), 'backup-test'));
    expect(app.callsOf('backups.test')).toEqual([{}]);
    expect(app.text()).toMatch(/The restore test failed: the backup archive is damaged/);
  });

  it('04 §9.1 rules 3 and 5: sets the passphrase (only when both match) and the folder destination', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    type(byTest(app.tree(), 'settings-backup-passphrase'), 'lantern over quillmarsh');
    type(byTest(app.tree(), 'settings-backup-passphrase-confirm'), 'lantern over quillmarsh!');
    await click(app, byTest(app.tree(), 'settings-backup-passphrase-set'));
    expect(app.callsOf('backups.passphrase')).toEqual([]);
    expect(app.text()).toMatch(/The two passphrases differ/);

    type(byTest(app.tree(), 'settings-backup-passphrase-confirm'), 'lantern over quillmarsh');
    await click(app, byTest(app.tree(), 'settings-backup-passphrase-set'));
    expect(app.callsOf('backups.passphrase')).toEqual([{ passphrase: 'lantern over quillmarsh' }]);

    type(byTest(app.tree(), 'settings-backup-label'), 'NAS');
    type(byTest(app.tree(), 'settings-backup-path'), '/Volumes/nas/command-center');
    await click(app, byTest(app.tree(), 'settings-backup-destination-set'));
    expect(app.callsOf('backups.destination')).toEqual([
      { destination: { kind: 'folder', label: 'NAS', path: '/Volumes/nas/command-center' } },
    ]);
    await click(app, byTest(app.tree(), 'settings-backup-destination-clear'));
    expect(app.callsOf('backups.destination')[1]).toEqual({ destination: null });
  });
});
