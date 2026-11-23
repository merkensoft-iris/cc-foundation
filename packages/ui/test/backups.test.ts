/**
 * The backup screens (04 §9.1, 09 P1-17): "Last good backup" and the state on Home, and
 * Settings → Backups: the state in words, Back up now, the backup password and the second copy,
 * and under Advanced the past backups with the human-only Restore (AC-04-11, C-04-10) and the
 * restore check.
 */
import { describe, expect, it } from 'vitest';

import type { BackupRecord, BackupStatus } from '../src/app/api.js';
import { byTest, queryByTest, textOf } from '../src/ui/vnode.js';
import { apiError, click, startApp, type } from './harness.js';

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
    expect(textOf(byTest(app.tree(), 'backup-last-good'))).toBe(
      'Last backup 15 hours ago · Synced folder',
    );
    expect(byTest(app.tree(), 'backup-last-good').props.title).toBe('2026-11-12 18:00 UTC');
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
  it('AC-04-11 shows the state in words, the last good backup and, under Advanced, the failed restore check with its reason', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    expect(textOf(byTest(app.tree(), 'backup-state'))).toBe('Not working');
    // Past backups and the restore check are under Advanced, closed until asked for.
    expect(queryByTest(app.tree(), 'backups-advanced')).toBeUndefined();
    await click(app, byTest(app.tree(), 'backups-advanced-toggle'));
    expect(textOf(byTest(app.tree(), 'backup-last-test'))).toMatch(
      /Failed.*chunk 3 fails authentication/,
    );
    expect(textOf(byTest(app.tree(), 'backup-reasons'))).toMatch(/The last restore test failed/);
    // The archive the test failed cannot be restored; the previous one can.
    expect(queryByTest(app.tree(), `restore-${NEWEST}`)).toBeUndefined();
    expect(queryByTest(app.tree(), `restore-${PREVIOUS}`)).toBeDefined();
  });

  it('AC-04-11 C-04-10 C-04-12 restoring the previous archive is explained first, then calls backups.restore and says "Confirm in the window" while the shell asks', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    await click(app, byTest(app.tree(), 'backups-advanced-toggle'));
    await click(app, byTest(app.tree(), `restore-${PREVIOUS}`));
    expect(app.callsOf('backups.restore')).toEqual([]);
    expect(textOf(byTest(app.tree(), `restore-confirm-${PREVIOUS}`))).toMatch(
      /backs up the current data first, then restores this backup and restarts\. You confirm it in Command Center’s own window next/,
    );
    await click(app, byTest(app.tree(), `restore-cancel-${PREVIOUS}`));
    expect(queryByTest(app.tree(), `restore-confirm-${PREVIOUS}`)).toBeUndefined();

    // The call waits while main's confirm window is open (C-04-12).
    let answer: (value: unknown) => void = () => undefined;
    app.answers['backups.restore'] = () => new Promise((resolve) => (answer = resolve));
    await click(app, byTest(app.tree(), `restore-${PREVIOUS}`));
    await click(app, byTest(app.tree(), `restore-now-${PREVIOUS}`));
    expect(app.callsOf('backups.restore')).toEqual([{ id: PREVIOUS }]);
    expect(textOf(byTest(app.tree(), `restore-in-window-${PREVIOUS}`))).toBe(
      'Confirm in the window',
    );
    expect(queryByTest(app.tree(), `restore-confirm-${PREVIOUS}`)).toBeUndefined();
    answer({ status: 'ok', preRestoreBackupId: 'bkp_01KA0000000000000000000003' });
    await app.settle();
    expect(queryByTest(app.tree(), `restore-in-window-${PREVIOUS}`)).toBeUndefined();
    expect(app.text()).toMatch(/the current data was backed up first/);
  });

  it('C-04-12 Cancel in the confirm window leaves the screen as it was, with the reason', async () => {
    const app = await startApp(
      {
        ...backupApi(),
        'backups.restore': () =>
          Promise.reject(
            apiError('E_HUMAN_REQUIRED', 'backups.restore was not confirmed, so nothing changed'),
          ),
      },
      { screen: 'settings', tab: 'backups' },
    );
    await click(app, byTest(app.tree(), 'backups-advanced-toggle'));
    await click(app, byTest(app.tree(), `restore-${PREVIOUS}`));
    await click(app, byTest(app.tree(), `restore-now-${PREVIOUS}`));
    expect(app.text()).toMatch(/was not confirmed, so nothing changed/);
    expect(queryByTest(app.tree(), `restore-in-window-${PREVIOUS}`)).toBeUndefined();
  });

  it('04 §9.1 rules 1 and 7: Back up now and Check now call the human-only methods', async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    await click(app, byTest(app.tree(), 'backup-run'));
    expect(app.callsOf('backups.run')).toEqual([{}]);
    await click(app, byTest(app.tree(), 'backups-advanced-toggle'));
    await click(app, byTest(app.tree(), 'backup-test'));
    expect(app.callsOf('backups.test')).toEqual([{}]);
    expect(app.text()).toMatch(/The restore check failed: the backup archive is damaged/);
  });

  it("04 §9.1 rules 3 and 5: the password is asked for in main's window and the folder in its picker; the screen sends neither", async () => {
    const app = await startApp(backupApi(), { screen: 'settings', tab: 'backups' });
    expect(textOf(byTest(app.tree(), 'backup-passphrase-state'))).toBe('Set');
    // No password field on the screen: main's secret prompt asks for it.
    expect(queryByTest(app.tree(), 'settings-backup-passphrase')).toBeUndefined();
    let typed: (value: unknown) => void = () => undefined;
    app.answers['backups.passphrase'] = () => new Promise((resolve) => (typed = resolve));
    await click(app, byTest(app.tree(), 'settings-backup-passphrase-set'));
    expect(app.callsOf('backups.passphrase')).toEqual([{}]);
    expect(textOf(byTest(app.tree(), 'backup-passphrase-in-window'))).toBe(
      'Type the password in the window',
    );
    expect(queryByTest(app.tree(), 'settings-backup-passphrase-set')).toBeUndefined();
    typed({ status: 'ok', passphraseSet: true });
    await app.settle();
    expect(app.text()).toMatch(/Backup password set/);
    expect(queryByTest(app.tree(), 'backup-passphrase-in-window')).toBeUndefined();

    expect(textOf(byTest(app.tree(), 'backup-destination'))).toBe('Synced folder');
    await click(app, byTest(app.tree(), 'settings-backup-destination-change'));
    // No folder field either: the system folder picker asks for it.
    expect(queryByTest(app.tree(), 'settings-backup-path')).toBeUndefined();
    await click(app, byTest(app.tree(), 'settings-backup-destination-set'));
    expect(app.callsOf('backups.destination')).toEqual([]);
    expect(app.text()).toMatch(/Name the second copy first/);
    type(byTest(app.tree(), 'settings-backup-label'), 'NAS');
    await click(app, byTest(app.tree(), 'settings-backup-destination-set'));
    expect(app.callsOf('backups.destination')).toEqual([
      { destination: { kind: 'folder', label: 'NAS' } },
    ]);
    // Stopping the second copy is in the Change… form.
    expect(queryByTest(app.tree(), 'settings-backup-destination-clear')).toBeUndefined();
    await click(app, byTest(app.tree(), 'settings-backup-destination-change'));
    await click(app, byTest(app.tree(), 'settings-backup-destination-clear'));
    expect(app.callsOf('backups.destination')[1]).toEqual({ destination: null });
  });
});

describe('Settings → Backups for a first-time user', () => {
  it('04 §9.1 rule 3: until a password and a second copy are set, Set password… and the second-copy form are offered and the state reads "Only on this computer"', async () => {
    const fresh: BackupStatus = { state: 'not_configured', passphraseSet: false, reasons: [] };
    const app = await startApp(
      { ...backupApi(fresh), 'backups.list': () => ({ backups: [], total: 0 }) },
      { screen: 'settings', tab: 'backups' },
    );
    expect(textOf(byTest(app.tree(), 'backup-state'))).toBe('Only on this computer');
    expect(textOf(byTest(app.tree(), 'backup-last-good'))).toBe('No backup yet');
    expect(textOf(byTest(app.tree(), 'backup-passphrase-state'))).toMatch(/Not set/);
    expect(textOf(byTest(app.tree(), 'settings-backup-passphrase-set'))).toBe('Set password…');
    expect(queryByTest(app.tree(), 'settings-backup-label')).toBeDefined();
    expect(queryByTest(app.tree(), 'settings-backup-destination-clear')).toBeUndefined();
    await click(app, byTest(app.tree(), 'backups-advanced-toggle'));
    expect(textOf(byTest(app.tree(), 'backups-advanced'))).toMatch(/No backups yet/);
  });
});
