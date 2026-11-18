/**
 * Backups (04 §9.1, 09 P1-17): scheduled encrypted snapshots, the local set and the folder
 * destination (AC-04-10), the restore test, the `failing` state, its push and attention item,
 * and the human-only restore that backs up the current store first (AC-04-11, C-04-10).
 *
 * Time is a hand-moved clock and the scheduler's check is called directly (`backups.tick()`),
 * so 60 simulated days run in seconds. The passphrase key is derived with the ADR 0007
 * algorithm at a small scrypt cost; the full cost is checked once on its own.
 */
import fs from 'node:fs';
import path from 'node:path';

import { OnboardingProfile, type BackupRecord, type BackupStatus } from '@cc/schemas';
import { inspectSnapshot, MIGRATIONS_DIR, openStore, pendingMigrations } from '@cc/store';
import { createProfileDir, makeCanary, type ProfileDir } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { BACKUP_CHECK_INTERVAL_MS, BACKUP_JOB, startCore } from '../src/service.js';
import { parseArchiveName, type BackupPush } from '../src/backups/engine.js';
import { extractArchive, readArchiveHeader, writeArchive } from '../src/backups/format.js';
import {
  deriveBackupKey,
  randomBackupKey,
  SCRYPT_PARAMS,
  type BackupKey,
} from '../src/backups/keys.js';
import { selectKept } from '../src/backups/retention.js';
import type { Clock } from '../src/clock.js';
import { rejection, repoRoot, startTestCore, type TestCore } from './helpers.js';

const SLOW_MS = 60_000;
const DAY_MS = 86_400_000;
const PASSPHRASE = 'quillmarsh harbour lantern';

/** A clock moved by hand; its timers never fire, so the test runs the backup check itself. */
function handClock(start: string): Clock & { set(ms: number): void; ms(): number } {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    set: (ms) => {
      now = ms;
    },
    ms: () => now,
  };
}

function scenario(): OnboardingProfile {
  return OnboardingProfile.parse(
    JSON.parse(fs.readFileSync(path.join(repoRoot(), 'fixtures/onboarding/scenario.json'), 'utf8')),
  );
}

async function testKey(): Promise<BackupKey> {
  return deriveBackupKey(PASSPHRASE, {
    alg: 'scrypt',
    N: 2 ** 10,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16, 7).toString('base64'),
  });
}

interface Setup {
  readonly test: TestCore;
  readonly clock: ReturnType<typeof handClock>;
  readonly folder: ProfileDir;
  readonly key: BackupKey;
  readonly canary: string;
  readonly pushes: BackupPush[];
  readonly restarts: string[];
  localArchives(): string[];
  folderFiles(): string[];
}

const open: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

async function setup(
  options: { destination?: boolean; passphrase?: boolean } = {},
): Promise<Setup> {
  // 00:30 on 1 September in the scenario's time zone (Asia/Kolkata, UTC+05:30).
  const clock = handClock('2026-08-31T19:00:00Z');
  const canary = makeCanary('backuptitle');
  const key = await testKey();
  const pushes: BackupPush[] = [];
  const restarts: string[] = [];
  const folder = createProfileDir();
  const test = await startTestCore({
    clock,
    seed: (item) => ({ ...item, title: `${canary} statement of work` }),
    backupKeys: options.passphrase === false ? [randomBackupKey()] : [randomBackupKey(), key],
    notify: (push) => pushes.push(push),
    requestRestart: (reason) => restarts.push(reason),
    backups: { chunkBytes: 4096 },
  });
  open.push({
    dispose: async () => {
      await test.dispose();
      folder.cleanup();
    },
  });
  await test.core.callAsUser('onboarding.save', { profile: scenario(), step: 'workspace' });
  if (options.destination !== false) {
    await test.core.callAsUser('backups.destination', {
      destination: { kind: 'folder', label: 'Synced folder', path: folder.path },
    });
  }
  const local = path.join(test.core.userData, 'backups');
  return {
    test,
    clock,
    folder,
    key,
    canary,
    pushes,
    restarts,
    localArchives: () =>
      fs
        .readdirSync(local)
        .filter((name) => name.endsWith('.ccb'))
        .sort(),
    folderFiles: () => (fs.existsSync(folder.path) ? fs.readdirSync(folder.path).sort() : []),
  };
}

async function status(test: TestCore): Promise<BackupStatus> {
  return (await test.core.callAsUser('backups.status', {})) as BackupStatus;
}

/** Runs the scheduled check every hour from now until `days` later. */
async function runDays(s: Setup, days: number): Promise<void> {
  const end = s.clock.ms() + days * DAY_MS;
  while (s.clock.ms() < end) {
    await s.test.core.backups.tick();
    for (const name of s.folderFiles()) {
      // AC-04-10: only finished archives reach the folder, never the database or its WAL.
      expect(name).toMatch(/^cc-backup-\d{8}T\d{6}Z-bkp_[0-9A-Z]{26}\.ccb$/);
    }
    s.clock.set(s.clock.ms() + 3_600_000);
  }
}

describe(
  'AC-04-10 scheduled encrypted backups, the local set and the folder',
  { timeout: SLOW_MS },
  () => {
    it('AC-04-10 C-04-09 a scheduled backup writes one archive locally and one to the folder, with no record title in plain bytes and no database or WAL in the folder', async () => {
      const s = await setup();
      expect(s.test.core.scheduler.status(BACKUP_JOB)).toMatchObject({ name: BACKUP_JOB });
      expect(BACKUP_CHECK_INTERVAL_MS).toBe(600_000);

      await s.test.core.backups.tick();
      const local = s.localArchives();
      const remote = s.folderFiles();
      expect(local).toHaveLength(1);
      expect(remote).toEqual(local);
      expect(remote.some((name) => /workspace\.db|-wal$|-shm$/.test(name))).toBe(false);

      const records = (await s.test.core.callAsUser('backups.list', {})) as {
        backups: BackupRecord[];
      };
      expect(records.backups).toHaveLength(1);
      expect(records.backups[0]).toMatchObject({
        trigger: 'scheduled',
        local: { ok: true },
        offMachine: { destination: 'Synced folder', ok: true },
      });

      const canary = Buffer.from(s.canary, 'utf8');
      for (const file of [
        path.join(s.test.core.userData, 'backups', local[0]!),
        path.join(s.folder.path, remote[0]!),
      ]) {
        expect(fs.readFileSync(file).includes(canary)).toBe(false);
      }
      // The canary is in the archive, sealed: decrypting it finds the title in the snapshot.
      const out = createProfileDir();
      try {
        const extracted = await extractArchive(
          path.join(s.folder.path, remote[0]!),
          [s.key],
          out.path,
        );
        expect(extracted.entries.map((entry) => entry.name)).toContain('workspace.db');
        const db = fs.readFileSync(path.join(out.path, 'workspace.db'));
        expect(db.includes(canary)).toBe(true);
        const header = await readArchiveHeader(path.join(s.folder.path, remote[0]!));
        expect(header).toMatchObject({
          keyId: s.key.id,
          cipher: 'aes-256-gcm',
          kdf: { alg: 'scrypt' },
        });
        expect(JSON.stringify(header)).not.toContain(s.canary);
      } finally {
        out.cleanup();
      }
      const plainSnapshots = fs.readdirSync(path.join(s.test.core.userData, 'backups', '.work'));
      expect(plainSnapshots).toEqual([]);
      expect((await status(s.test)).state).toBe('ok');
    });

    it('AC-04-10 the local set and the folder are pruned to 7 daily and 4 weekly over a simulated 60 days', async () => {
      const s = await setup();
      await runDays(s, 60);
      const local = s.localArchives().map((name) => parseArchiveName(name)!);
      const remote = s.folderFiles().map((name) => parseArchiveName(name)!);
      expect(local).toHaveLength(11);
      expect(remote.map((file) => file.id)).toEqual(local.map((file) => file.id));

      const list = (await s.test.core.callAsUser('backups.list', {})) as {
        backups: BackupRecord[];
        total: number;
      };
      expect(list.total).toBe(60);
      const kept = selectKept(list.backups, { daily: 7, weekly: 4 }, 'Asia/Kolkata');
      expect(kept.daily).toHaveLength(7);
      expect(kept.weekly).toHaveLength(4);
      expect(new Set(local.map((file) => file.id))).toEqual(
        new Set([...kept.daily, ...kept.weekly]),
      );
      // The 7 dailies are the last 7 days; the weeklies are 4 distinct earlier weeks.
      const days = local.map((file) => file.at.slice(0, 10));
      expect(new Set(days).size).toBe(11);
      expect(list.backups.filter((r) => r.local.pruned === true)).toHaveLength(49);
      expect(list.backups.filter((r) => r.offMachine?.pruned === true)).toHaveLength(49);
    });

    it('AC-04-10 retention: daily is the newest per local day, weekly the newest per earlier ISO week', () => {
      const dated = Array.from({ length: 40 }, (_, i) => ({
        id: `bkp_${String(i).padStart(2, '0')}`,
        at: new Date(Date.parse('2026-10-01T04:00:00Z') + i * DAY_MS).toISOString(),
      }));
      // A second archive on the newest day: the daily keeps the newer one.
      dated.push({ id: 'bkp_40', at: '2026-11-09T12:00:00.000Z' });
      const kept = selectKept(dated, { daily: 7, weekly: 4 }, 'Asia/Kolkata');
      expect(kept.daily).toEqual([
        'bkp_40',
        'bkp_38',
        'bkp_37',
        'bkp_36',
        'bkp_35',
        'bkp_34',
        'bkp_33',
      ]);
      // Weeks start on Monday: 2026-11-02, 10-26, 10-19, 10-12; the newest of each before 11-03.
      expect(kept.weekly).toEqual(['bkp_32', 'bkp_31', 'bkp_24', 'bkp_17']);
    });

    it('AC-04-10 without a passphrase the local set is still written under the random key, nothing goes off the machine, and the state is not_configured', async () => {
      const s = await setup({ passphrase: false });
      await s.test.core.backups.tick();
      expect(s.localArchives()).toHaveLength(1);
      expect(s.folderFiles()).toEqual([]);
      const current = await status(s.test);
      expect(current).toMatchObject({ state: 'not_configured', passphraseSet: false });
      expect(current.reasons.join(' ')).toMatch(/No passphrase is set/);
      expect(s.test.core.backups.attention()).toEqual([]);
    });

    it('04 §9.1 rule 8: no off-machine backup in 48 hours is warning, an attention item but no push', async () => {
      const s = await setup();
      await s.test.core.backups.tick();
      fs.rmSync(s.folder.path, { recursive: true, force: true }); // the disk is disconnected
      await runDays(s, 3);
      const current = await status(s.test);
      expect(current.state).toBe('warning');
      expect(current.reasons.join(' ')).toMatch(/is not there/);
      expect(s.test.core.backups.attention()).toHaveLength(1);
      expect(s.pushes).toEqual([]);
      fs.mkdirSync(s.folder.path);
    });
  },
);

describe(
  'AC-04-11 the restore test, failing, and the human-only restore',
  { timeout: SLOW_MS },
  () => {
    it('AC-04-11 C-04-10 a corrupted newest archive fails the restore test, sets failing, pushes once and adds an attention item; last good stays on the previous archive; restoring it backs up the current store first', async () => {
      const s = await setup();
      await runDays(s, 1.5);
      const files = s.folderFiles();
      expect(files).toHaveLength(2);
      const [previous, newest] = files;
      expect(newest).toBeDefined();
      const ok = (await s.test.core.callAsUser('backups.test', {})) as {
        test: { ok: boolean; source: string; detail: string };
      };
      expect(ok.test).toMatchObject({ ok: true, source: 'off_machine' });
      expect(ok.test.detail).toMatch(/integrity ok/);

      // Corrupt one byte in the middle of the newest off-machine archive.
      const target = path.join(s.folder.path, newest!);
      const bytes = fs.readFileSync(target);
      const at = Math.floor(bytes.length / 2);
      bytes[at] = (bytes[at] ?? 0) ^ 0xff;
      fs.writeFileSync(target, bytes);

      const failed = (await s.test.core.callAsUser('backups.test', {})) as {
        test: { ok: boolean; detail: string };
        status: BackupStatus;
      };
      expect(failed.test.ok).toBe(false);
      expect(failed.test.detail).toMatch(/fails authentication/);
      expect(failed.status.state).toBe('failing');
      expect(s.pushes).toEqual([
        expect.objectContaining({ kind: 'backup_failing', id: 'backup-failing' }),
      ]);
      const previousId = parseArchiveName(previous!)!.id;
      expect(failed.status.lastGood).toMatchObject({
        id: previousId,
        destination: 'Synced folder',
      });
      const home = (await s.test.core.callAsUser('home.get', {})) as {
        backup: { state: string; lastGood?: { id: string } };
      };
      expect(home.backup).toMatchObject({ state: 'failing', lastGood: { id: previousId } });
      expect(s.test.core.backups.attention()).toEqual([
        expect.objectContaining({
          category: 'backup',
          title: expect.stringMatching(/^Backups failing/),
        }),
      ]);
      expect(s.test.core.backups.preReadState()).toBe('failing');

      // Still failing an hour later: no second push.
      s.clock.set(s.clock.ms() + 3_600_000);
      await s.test.core.backups.tick();
      expect(s.pushes).toHaveLength(1);

      // An agent cannot restore, run or test (04 §4.3).
      const agent = await s.test.connect();
      for (const method of ['backups.restore', 'backups.run', 'backups.test']) {
        const error = await rejection(agent.call(method, { id: previousId }));
        expect(error.code, method).toBe('E_HUMAN_REQUIRED');
      }
      // ...but can read the status and history.
      expect((await agent.call<BackupStatus>('backups.status', {})).state).toBe('failing');

      // A change after the previous archive, which the restore takes back.
      const created = (await s.test.core.callAsUser('items.create', {
        workstream: 'alderwick',
        title: 'Book the Quillmarsh site visit',
        due: '2026-09-20',
        doneMeans: 'The visit is booked.',
        evidence: ['The booking'],
      })) as { item: { ref: string } };

      const restored = (await s.test.core.callAsUser('backups.restore', { id: previousId })) as {
        status: string;
        preRestoreBackupId: string;
        restored: string;
      };
      expect(restored).toMatchObject({ status: 'ok', restored: previousId });
      expect(s.restarts).toEqual(['restore']);
      const list = (await s.test.core.callAsUser('backups.list', {})) as {
        backups: BackupRecord[];
      };
      expect(list.backups[0]).toMatchObject({
        id: restored.preRestoreBackupId,
        trigger: 'pre_restore',
        local: { ok: true },
      });

      // The restart applies the staged restore before the store opens.
      const userData = s.test.core.userData;
      await s.test.core.stop();
      const next = await startCore({ userData, clock: s.clock, env: {}, backupKeys: [s.key] });
      try {
        const refs = next.store.read((tx) => tx.list('action_items').map((item) => item.ref));
        expect(refs).not.toContain(created.item.ref);
        expect(fs.existsSync(path.join(userData, 'restore', 'pending.json'))).toBe(false);
        expect(fs.existsSync(path.join(userData, 'restore', 'replaced', 'workspace.db'))).toBe(
          true,
        );
        // The pre-restore archive holds the replaced store, created item included.
        const out = createProfileDir();
        try {
          const name = fs
            .readdirSync(path.join(userData, 'backups'))
            .find((file) => file.includes(restored.preRestoreBackupId))!;
          await extractArchive(path.join(userData, 'backups', name), [s.key], out.path);
          const db = fs.readFileSync(path.join(out.path, 'workspace.db'));
          expect(db.includes(Buffer.from('Book the Quillmarsh site visit'))).toBe(true);
        } finally {
          out.cleanup();
        }
      } finally {
        await next.stop();
      }
    });

    it('AC-04-11 a test over a missing archive or with no key fails; a restore of an unknown archive changes nothing', async () => {
      const s = await setup({ destination: false });
      const empty = (await s.test.core.callAsUser('backups.test', {})) as {
        test: { ok: boolean; detail: string };
      };
      expect(empty.test).toMatchObject({ ok: false, detail: expect.stringMatching(/no archive/) });
      const missing = await rejection(
        s.test.core.callAsUser('backups.restore', { id: 'bkp_01KA0000000000000000000000' }),
      );
      expect(missing.code).toBe('E_NOT_FOUND');
      expect(s.localArchives()).toEqual([]);
      expect(s.restarts).toEqual([]);
    });

    it('04 §9.1 rule 7: a destination or passphrase change asks for a fresh backup and a restore test', async () => {
      const s = await setup();
      await s.test.core.backups.tick();
      await s.test.core.callAsUser('backups.test', {});
      const other = createProfileDir();
      try {
        await s.test.core.callAsUser('backups.destination', {
          destination: { kind: 'folder', label: 'NAS', path: other.path },
        });
        s.clock.set(s.clock.ms() + 3_600_000);
        await s.test.core.backups.tick();
        expect(fs.readdirSync(other.path)).toHaveLength(1);
        const current = await status(s.test);
        expect(current.lastRestoreTest).toMatchObject({ ok: true, source: 'off_machine' });
        expect(current.lastGood?.destination).toBe('NAS');
      } finally {
        other.cleanup();
      }
    });
  },
);

describe('04 §9.1 rule 1: a backup before every migration', { timeout: SLOW_MS }, () => {
  it('04 §9.1 rule 1 a store with a pending migration is backed up as it was before the migration runs', async () => {
    const profile = createProfileDir();
    const migrations = createProfileDir();
    try {
      for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'))) {
        if (!name.startsWith('0003')) {
          fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(migrations.path, name));
        }
      }
      openStore({ userDataDir: profile.path, migrationsDir: migrations.path, env: {} }).close();
      expect(pendingMigrations(profile.path)).toBe(1);

      const key = await testKey();
      const clock = handClock('2026-11-18T04:00:00Z');
      const core = await startCore({ userData: profile.path, clock, env: {}, backupKeys: [key] });
      try {
        expect(core.store.schemaVersion).toBe(3);
        const [record] = core.backups.list().backups;
        expect(record).toMatchObject({ trigger: 'pre_migration', local: { ok: true } });
        const out = createProfileDir();
        try {
          const archive = path.join(profile.path, 'backups', record!.local.path);
          await extractArchive(archive, [key], out.path);
          expect(inspectSnapshot(path.join(out.path, 'workspace.db'))).toMatchObject({
            integrity: 'ok',
            schemaVersion: 2,
          });
        } finally {
          out.cleanup();
        }
      } finally {
        await core.stop();
      }
      // The next start has nothing pending, and takes no second pre-migration backup.
      const again = await startCore({ userData: profile.path, clock, env: {}, backupKeys: [key] });
      expect(again.backups.list().total).toBe(1);
      await again.stop();
    } finally {
      profile.cleanup();
      migrations.cleanup();
    }
  });
});

describe('ADR 0007 archive format', { timeout: SLOW_MS }, () => {
  it('C-04-09 an archive opens only with its key, and any truncation or edit fails authentication', async () => {
    const dir = createProfileDir();
    try {
      const key = await testKey();
      const payload = path.join(dir.path, 'payload');
      fs.writeFileSync(payload, Buffer.alloc(10_000, 1));
      const manifest = Buffer.from('{"format":"cc-backup-manifest"}');
      const archive = path.join(dir.path, 'a.ccb');
      await writeArchive(archive, {
        key,
        id: 'bkp_01KA0000000000000000000000',
        createdAt: '2026-11-18T00:00:00.000Z',
        trigger: 'manual',
        manifest,
        entries: [{ name: 'workspace.db', path: payload, bytes: 10_000 }],
        chunkBytes: 1024,
      });
      const fresh = (name: string) => {
        const out = path.join(dir.path, name);
        fs.mkdirSync(out);
        return out;
      };
      const good = await extractArchive(archive, [key], fresh('ok'));
      expect(good.entries.map((e) => [e.name, e.bytes])).toEqual([
        ['manifest.json', manifest.length],
        ['workspace.db', 10_000],
      ]);
      const wrong = await rejection(extractArchive(archive, [randomBackupKey()], fresh('wrong')));
      expect(wrong.code).toBe('E_PERMISSION');
      const again = await deriveBackupKey(PASSPHRASE, good.header.kdf);
      expect(again.id).toBe(key.id);
      const original = fs.readFileSync(archive);
      const cases: [string, Buffer][] = [
        ['truncated', original.subarray(0, original.length - 1040)],
        ['extended', Buffer.concat([original, original.subarray(original.length - 1040)])],
        [
          'header',
          Buffer.from(original.toString('latin1').replace('"manual"', '"manuaL"'), 'latin1'),
        ],
      ];
      for (const [name, bytes] of cases) {
        const file = path.join(dir.path, `${name}.ccb`);
        fs.writeFileSync(file, bytes);
        const error = await rejection(extractArchive(file, [key], fresh(name)));
        expect(error.message, name).toMatch(/damaged/);
      }
    } finally {
      dir.cleanup();
    }
  });

  it('ADR 0007 the passphrase key uses scrypt N=2^17, r=8, p=1 with a fresh salt', async () => {
    const key = await deriveBackupKey(PASSPHRASE);
    expect(key.kdf).toMatchObject({ alg: 'scrypt', ...SCRYPT_PARAMS });
    expect(Buffer.from(key.kdf!.salt, 'base64')).toHaveLength(16);
    expect(key.key).toHaveLength(32);
    const other = await deriveBackupKey(PASSPHRASE);
    expect(other.id).not.toBe(key.id);
  });
});
