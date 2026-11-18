/**
 * Backups (04 §9.1, 09 P1-17): scheduled encrypted snapshots, the local set, the folder
 * destination, the restore test, the status, and the human-only restore.
 *
 * A run: snapshot `workspace.db` with SQLite's online backup API into a work directory under
 * `<userData>/backups/.work/`, read the snapshot (integrity, row counts, last event, the blobs
 * its records reference), seal the manifest, the snapshot and those blobs into one archive
 * (`format.ts`, ADR 0007), and write it to the local set under a temporary name, then its
 * final one. With an off-machine destination and a passphrase, copy the finished archive to
 * the destination the same way. Then prune both sets (`retention.ts`) and delete the work
 * directory: the plaintext snapshot never leaves `<userData>`, and a destination only ever
 * receives finished, encrypted archives, never `workspace.db` or its WAL (C-04-09).
 *
 * The history (each archive, the last restore test, when the state became `failing`) is kept
 * in `<userData>/backups/history.json`, outside the store, because a restore replaces the
 * store and the history of this machine's backups must outlive it.
 *
 * A restore (C-04-10) is staged: back up the current store, decrypt and verify the chosen
 * archive into `<userData>/restore/`, write `pending.json`, and ask for a core restart. The
 * next start applies it before it opens the store (`applyPendingRestore`).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';

import type {
  BackupDestination,
  BackupRecord,
  BackupRestoreTest,
  BackupState,
  BackupStatus,
  BackupTrigger,
} from '@cc/schemas';
import { blobPath, inspectSnapshot, type Store } from '@cc/store';

import type { Clock } from '../clock.js';
import { CoreError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import {
  ARCHIVE_EXTENSION,
  extractArchive,
  writeArchive,
  type BackupKey,
  type ExtractResult,
  type PackEntry,
} from './format.js';
import { DEFAULT_RETENTION, localDay, selectKept, type Retention } from './retention.js';

export const BACKUPS_DIRNAME = 'backups';
export const RESTORE_DIRNAME = 'restore';
export const HISTORY_FILE = 'history.json';
export const PENDING_RESTORE_FILE = 'pending.json';
/** What "Last good backup" calls the local set. */
export const LOCAL_LABEL = 'This computer';

const HOUR_MS = 3_600_000;
/** 04 §9.1 rule 8. */
export const WARNING_AFTER_MS = 48 * HOUR_MS;
export const FAILING_AFTER_MS = 72 * HOUR_MS;
export const DEFAULT_RESTORE_TEST_EVERY_DAYS = 30;
const HISTORY_LIMIT = 500;
/** The daily shutdown series' backbone key (02 §4.5, `onboarding/compose.ts`). */
export const DAILY_SHUTDOWN_KEY = 'portfolio.daily-shutdown';

const ARCHIVE_NAME = /^cc-backup-(\d{8}T\d{6}Z)-(bkp_[0-9A-HJKMNP-TV-Z]{26})\.ccb$/;

/** `cc-backup-20261118T153000Z-bkp_….ccb`: sorts by time, carries the archive ID. */
export function archiveName(id: string, at: string): string {
  const compact = `${at.slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
  return `cc-backup-${compact}-${id}${ARCHIVE_EXTENSION}`;
}

export interface ArchiveFile {
  readonly name: string;
  readonly id: string;
  readonly at: string;
}

export function parseArchiveName(name: string): ArchiveFile | undefined {
  const match = ARCHIVE_NAME.exec(name);
  if (match === null) return undefined;
  const [, compact = '', id = ''] = match;
  const at =
    `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T` +
    `${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  return { name, id, at };
}

/** The archives in a directory, newest first; anything else there is ignored. */
async function archivesIn(dir: string): Promise<ArchiveFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .map(parseArchiveName)
    .filter((file): file is ArchiveFile => file !== undefined)
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Every blob digest in `<userData>/blobs/<aa>/<sha256>`, sorted. */
function allBlobs(blobsDir: string): string[] {
  const digests: string[] = [];
  if (!existsSync(blobsDir)) return digests;
  for (const prefix of fs.readdirSync(blobsDir)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    for (const name of fs.readdirSync(join(blobsDir, prefix))) {
      if (/^[0-9a-f]{64}$/.test(name) && name.startsWith(prefix)) digests.push(name);
    }
  }
  return digests.sort();
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  return hash.digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The manifest sealed first in every archive (04 §9.1 rule 2). */
export interface BackupManifest {
  readonly format: 'cc-backup-manifest';
  readonly v: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly trigger: BackupTrigger;
  readonly schemaVersion: number;
  readonly lastEventId: string | null;
  readonly tables: Readonly<Record<string, number>>;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  /** Digests a record references that the blob directory did not hold. */
  readonly missingBlobs: readonly string[];
}

/** One push the core asks main to show (02 §10; `backup_failing` is pushed, 04 §9.1 rule 8). */
export interface BackupPush {
  readonly id: string;
  readonly kind: 'backup_failing';
  readonly title: string;
  readonly body?: string;
  readonly link?: string;
}

/** An attention entry (02 §5.7): `warning` and `failing` are attention items (rule 8). */
export interface BackupAttention {
  readonly category: 'backup';
  readonly ref: string;
  readonly title: string;
  readonly since: string;
}

interface History {
  v: 1;
  /** When this machine started backing up: the 72-hour rule counts from here. */
  since: string;
  /** Newest first. */
  records: BackupRecord[];
  lastRestoreTest?: BackupRestoreTest;
  /** A destination or key change asks for a backup and a restore test (rule 7). */
  testRequested?: boolean;
  /** The destination and key the last check saw. */
  configSignature?: string;
  /** When an off-machine destination with a passphrase was first seen. */
  offMachineSince?: string;
  /** When the state became `failing`; the push goes out once per spell (rule 8). */
  failingSince?: string;
  lastFailure?: { at: string; trigger: BackupTrigger; error: string };
}

export interface BackupsOptions {
  readonly userData: string;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** The keys main handed over; the last one seals new archives (04 §9.1 rule 3). */
  readonly keys?: readonly BackupKey[];
  /** Pushes a desktop notification (`failing` only). */
  readonly notify?: (push: BackupPush) => void;
  /** Why the app is not idle; scheduled runs wait for idle (rule 1). */
  readonly busy?: () => readonly string[];
  /** Asks the host to restart the core, which applies a staged restore (rule 9). */
  readonly requestRestart?: (reason: string) => void;
  readonly retention?: Retention;
  readonly offMachineRetention?: Retention;
  readonly restoreTestEveryDays?: number;
  /** Archive chunk size; tests use a small one to cross chunk boundaries. */
  readonly chunkBytes?: number;
}

interface Config {
  readonly destination?: BackupDestination;
  readonly timeZone: string;
}

export class Backups {
  readonly #options: BackupsOptions;
  readonly #logger: Logger;
  readonly #dir: string;
  readonly #historyPath: string;
  #keys: readonly BackupKey[];
  #history: History;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: BackupsOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#dir = join(options.userData, BACKUPS_DIRNAME);
    this.#historyPath = join(this.#dir, HISTORY_FILE);
    this.#keys = options.keys ?? [];
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    this.#history = this.#load();
  }

  /** Main hands over new keys after the user sets a passphrase (rule 3, OQ-04-08). */
  setKeys(keys: readonly BackupKey[]): void {
    this.#keys = [...keys];
  }

  get localDir(): string {
    return this.#dir;
  }

  // status (rule 8)

  status(): BackupStatus {
    const now = this.#now();
    const config = this.#config();
    const history = this.#history;
    const good = history.records.filter((r) => r.verified?.ok !== false);
    const lastLocal = good.find((r) => r.local.ok && r.local.pruned !== true);
    const lastOff = good.find((r) => r.offMachine?.ok === true && r.offMachine.pruned !== true);
    const lastGood = good.find(
      (r) =>
        (r.local.ok && r.local.pruned !== true) ||
        (r.offMachine?.ok === true && r.offMachine.pruned !== true),
    );
    const passphraseSet = this.#currentKey()?.origin === 'passphrase';
    const offMachine = config.destination !== undefined && passphraseSet;
    const reasons: string[] = [];
    let state: BackupState = 'ok';

    const test = history.lastRestoreTest;
    if (test?.ok === false) {
      state = 'failing';
      reasons.push(`The last restore test failed: ${test.detail}`);
    }
    const lastAny = lastGood?.at ?? history.since;
    if (now - Date.parse(lastAny) > FAILING_AFTER_MS) {
      state = 'failing';
      reasons.push('No backup has succeeded in 72 hours.');
    }
    if (this.#currentKey() === undefined) {
      reasons.push('There is no backup key: the app has no secret store to keep one in.');
    }
    if (history.lastFailure !== undefined && history.lastFailure.at > (lastGood?.at ?? '')) {
      reasons.push(`The last backup failed: ${history.lastFailure.error}`);
    }
    if (!offMachine) {
      if (state !== 'failing') state = 'not_configured';
      reasons.push(
        config.destination === undefined
          ? 'No off-machine destination is set.'
          : 'No passphrase is set, so nothing is copied off this machine.',
      );
    } else {
      const lastOffAt = lastOff?.at ?? history.offMachineSince ?? history.since;
      if (now - Date.parse(lastOffAt) > WARNING_AFTER_MS) {
        if (state === 'ok') state = 'warning';
        reasons.push('No off-machine backup has succeeded in 48 hours.');
      }
      const off = history.records[0]?.offMachine;
      if (off?.ok === false && off.error !== undefined) {
        reasons.push(`The last off-machine copy failed: ${off.error}`);
      }
    }

    const label = (record: BackupRecord): string =>
      record.offMachine?.ok === true && record.offMachine.pruned !== true
        ? record.offMachine.destination
        : LOCAL_LABEL;
    return {
      state,
      ...(lastLocal === undefined ? {} : { lastGoodLocalAt: lastLocal.at }),
      ...(lastOff === undefined ? {} : { lastGoodOffMachineAt: lastOff.at }),
      ...(lastGood === undefined
        ? {}
        : { lastGood: { id: lastGood.id, at: lastGood.at, destination: label(lastGood) } }),
      ...(test === undefined ? {} : { lastRestoreTest: test }),
      ...(config.destination === undefined ? {} : { destination: config.destination.label }),
      passphraseSet,
      reasons,
    };
  }

  /** The history, newest first (`backups.list`). */
  list(limit?: number): { backups: BackupRecord[]; total: number } {
    const records = this.#history.records;
    return { backups: records.slice(0, limit ?? records.length), total: records.length };
  }

  /** `warning` and `failing` as attention items (rule 8); `not_configured` is not one. */
  attention(): BackupAttention[] {
    const status = this.status();
    if (status.state !== 'warning' && status.state !== 'failing') return [];
    return [
      {
        category: 'backup',
        ref: 'backups',
        title: `Backups ${status.state}: ${status.reasons[0] ?? 'see Settings → Backups'}`,
        since:
          this.#history.failingSince ?? this.#history.lastRestoreTest?.at ?? this.#history.since,
      },
    ];
  }

  /** The state as the pre-read builder names it (02 §5.1, rhythm `backupState`). */
  preReadState(): 'not_configured' | 'healthy' | 'warning' | 'failing' {
    const state = this.status().state;
    return state === 'ok' ? 'healthy' : state;
  }

  // run (rules 1, 2, 4, 5, 6)

  run(trigger: BackupTrigger): Promise<BackupRecord> {
    return this.#exclusive(() => this.#run(trigger));
  }

  async #run(trigger: BackupTrigger): Promise<BackupRecord> {
    try {
      const record = await this.#write(trigger);
      if (this.#history.lastRestoreTest?.ok === false) this.#history.testRequested = true;
      delete this.#history.lastFailure;
      this.#save();
      this.#evaluate();
      return record;
    } catch (error) {
      this.#history.lastFailure = { at: this.#iso(), trigger, error: message(error) };
      this.#save();
      this.#logger.error('backups.failed', { trigger, error: message(error) });
      this.#evaluate();
      throw error;
    }
  }

  async #write(trigger: BackupTrigger): Promise<BackupRecord> {
    const key = this.#currentKey();
    if (key === undefined) {
      throw new CoreError('E_PERMISSION', 'there is no backup key to seal an archive with', [
        'Backups need the OS secret store (04 §9.1 rule 3); run the installed app',
      ]);
    }
    const { store } = this.#options;
    const id = newId('bkp', this.#options.clock);
    const at = this.#iso();
    const work = join(this.#dir, '.work', id);
    await mkdir(work, { recursive: true, mode: 0o700 });
    try {
      const snapshot = join(work, 'workspace.db');
      await store.snapshot(snapshot);
      const info = inspectSnapshot(snapshot);
      if (info.integrity !== 'ok') {
        throw new CoreError(
          'E_INVARIANT',
          `the snapshot fails its integrity check: ${info.integrity}`,
        );
      }
      const dbBytes = (await stat(snapshot)).size;
      const entries: PackEntry[] = [{ name: 'workspace.db', path: snapshot, bytes: dbBytes }];
      const files: { path: string; sha256: string; bytes: number }[] = [
        { path: 'workspace.db', sha256: await sha256OfFile(snapshot), bytes: dbBytes },
      ];
      const missingBlobs: string[] = [];
      // A pre-migration snapshot's records are not readable by this build's table specs, so
      // it takes every blob there is rather than guess which ones it references.
      for (const digest of info.blobDigests ?? allBlobs(store.blobsDir)) {
        const source = blobPath(store.blobsDir, digest);
        if (!existsSync(source)) {
          missingBlobs.push(digest);
          continue;
        }
        const name = `blobs/${digest.slice(0, 2)}/${digest}`;
        const bytes = (await stat(source)).size;
        entries.push({ name, path: source, bytes });
        files.push({ path: name, sha256: await sha256OfFile(source), bytes });
      }
      const manifest: BackupManifest = {
        format: 'cc-backup-manifest',
        v: 1,
        id,
        createdAt: at,
        trigger,
        schemaVersion: info.schemaVersion,
        lastEventId: info.lastEventId,
        tables: info.tables,
        files,
        missingBlobs,
      };
      const name = archiveName(id, at);
      const partial = join(this.#dir, `.${name}.partial`);
      await writeArchive(partial, {
        key,
        id,
        createdAt: at,
        trigger,
        manifest: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        entries,
        ...(this.#options.chunkBytes === undefined ? {} : { chunkBytes: this.#options.chunkBytes }),
      });
      const local = join(this.#dir, name);
      await rename(partial, local);
      const archiveSha256 = await sha256OfFile(local);
      const bytes = (await stat(local)).size;

      const record: BackupRecord = {
        id,
        at,
        trigger,
        archiveSha256,
        bytes,
        local: { path: name, ok: true },
      };
      const config = this.#config();
      let offMachine: BackupRecord['offMachine'];
      if (config.destination !== undefined && key.origin === 'passphrase') {
        offMachine = await this.#copyOff(config.destination, local, name, bytes);
      }
      const written: BackupRecord = offMachine === undefined ? record : { ...record, offMachine };
      this.#history.records.unshift(written);
      this.#history.records.length = Math.min(this.#history.records.length, HISTORY_LIMIT);
      await this.#prune(config);
      this.#save();
      this.#logger.info('backups.written', {
        id,
        trigger,
        bytes,
        offMachine: offMachine === undefined ? 'off' : offMachine.ok ? 'ok' : 'failed',
      });
      return this.#history.records.find((r) => r.id === id) ?? written;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** The folder destination: a temporary name, then the final one (rule 5). */
  async #copyOff(
    destination: BackupDestination,
    local: string,
    name: string,
    bytes: number,
  ): Promise<NonNullable<BackupRecord['offMachine']>> {
    const label = destination.label;
    if (destination.kind !== 'folder') {
      return {
        destination: label,
        ok: false,
        error: `${destination.kind} destinations arrive with their connectors (09 P2-11)`,
      };
    }
    try {
      const info = await stat(destination.path);
      if (!info.isDirectory()) throw new Error(`${destination.path} is not a folder`);
      const partial = join(destination.path, `.${name}.partial`);
      await copyFile(local, partial);
      if ((await stat(partial)).size !== bytes) throw new Error('the copy is incomplete');
      await rename(partial, join(destination.path, name));
      return { destination: label, ok: true };
    } catch (error) {
      const text =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `the folder ${destination.path} is not there (is the disk connected?)`
          : message(error);
      this.#logger.warn('backups.off_machine_failed', { destination: label, error: text });
      return { destination: label, ok: false, error: text };
    }
  }

  async #prune(config: Config): Promise<void> {
    const local = await archivesIn(this.#dir);
    const keep = selectKept(local, this.#options.retention ?? DEFAULT_RETENTION, config.timeZone);
    const kept = new Set([...keep.daily, ...keep.weekly]);
    for (const file of local) {
      if (kept.has(file.id)) continue;
      await unlink(join(this.#dir, file.name)).catch(() => undefined);
      const record = this.#history.records.find((r) => r.id === file.id);
      if (record !== undefined) record.local = { ...record.local, pruned: true };
    }
    const destination = config.destination;
    if (destination?.kind !== 'folder' || !existsSync(destination.path)) return;
    const remote = await archivesIn(destination.path);
    const keepRemote = selectKept(
      remote,
      this.#options.offMachineRetention ?? DEFAULT_RETENTION,
      config.timeZone,
    );
    const keptRemote = new Set([...keepRemote.daily, ...keepRemote.weekly]);
    for (const file of remote) {
      if (keptRemote.has(file.id)) continue;
      await unlink(join(destination.path, file.name)).catch(() => undefined);
      const record = this.#history.records.find((r) => r.id === file.id);
      if (record?.offMachine !== undefined) {
        record.offMachine = { ...record.offMachine, pruned: true };
      }
    }
  }

  // restore test (rule 7)

  test(): Promise<BackupRestoreTest> {
    return this.#exclusive(() => this.#test());
  }

  async #test(): Promise<BackupRestoreTest> {
    const config = this.#config();
    const offMachine =
      config.destination?.kind === 'folder' && this.#currentKey()?.origin === 'passphrase';
    const source: 'local' | 'off_machine' = offMachine ? 'off_machine' : 'local';
    const dir = offMachine ? (config.destination as { path: string }).path : this.#dir;
    const newest = (await archivesIn(dir))[0];
    let result: BackupRestoreTest;
    if (newest === undefined) {
      result = {
        at: this.#iso(),
        ok: false,
        detail:
          source === 'local'
            ? 'there is no archive in the local set to test'
            : `there is no archive in ${config.destination?.label ?? 'the destination'} to test`,
        source,
      };
    } else {
      result = await this.#testArchive(join(dir, newest.name), newest.id, source);
    }
    this.#history.lastRestoreTest = result;
    delete this.#history.testRequested;
    const record = this.#history.records.find((r) => r.id === result.backupId);
    if (record !== undefined) record.verified = { at: result.at, ok: result.ok };
    this.#save();
    this.#logger[result.ok ? 'info' : 'error']('backups.restore_test', {
      ok: result.ok,
      source,
      ...(result.backupId === undefined ? {} : { id: result.backupId }),
    });
    this.#evaluate();
    return result;
  }

  async #testArchive(
    path: string,
    id: string,
    source: 'local' | 'off_machine',
  ): Promise<BackupRestoreTest> {
    await mkdir(join(this.#dir, '.work'), { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.#dir, '.work', 'test-'));
    try {
      const extracted = await extractArchive(path, this.#keys, dir);
      if (extracted.header.id !== id)
        throw new CoreError('E_INVARIANT', 'the archive is not the one its name says');
      const detail = this.#verify(extracted, dir, true);
      return { at: this.#iso(), ok: true, detail, backupId: id, source };
    } catch (error) {
      return { at: this.#iso(), ok: false, detail: message(error), backupId: id, source };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Checks a decrypted archive (rule 7): the manifest's hashes, `PRAGMA integrity_check` on
   * the database opened read-only, its row counts against the manifest, and, when the live
   * store holds the snapshot's last event, the live event count at that event.
   */
  #verify(extracted: ExtractResult, dir: string, compareLive: boolean): string {
    const fail = (detail: string): never => {
      throw new CoreError('E_INVARIANT', detail);
    };
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(extracted.manifest.toString('utf8')) as BackupManifest;
    } catch {
      return fail('the manifest is not JSON');
    }
    if (manifest.format !== 'cc-backup-manifest' || manifest.id !== extracted.header.id) {
      fail('the manifest does not belong to this archive');
    }
    const found = new Map(extracted.entries.map((entry) => [entry.name, entry]));
    for (const file of manifest.files) {
      const entry = found.get(file.path);
      if (entry === undefined) fail(`${file.path} is missing`);
      else if (entry.sha256 !== file.sha256 || entry.bytes !== file.bytes) {
        fail(`${file.path} does not match its manifest hash`);
      }
      if (file.path.startsWith('blobs/') && !file.path.endsWith(`/${file.sha256}`)) {
        fail(`${file.path} is not named by its hash`);
      }
      found.delete(file.path);
    }
    found.delete('manifest.json');
    if (found.size > 0) fail(`${[...found.keys()].join(', ')} is not in the manifest`);
    const info = inspectSnapshot(join(dir, 'workspace.db'));
    if (info.integrity !== 'ok') fail(`the database fails its integrity check: ${info.integrity}`);
    for (const [table, rows] of Object.entries(manifest.tables)) {
      const restored = (info.tables as Record<string, number | undefined>)[table];
      if (restored !== rows) {
        fail(`${table} has ${String(restored ?? 0)} rows, the manifest ${String(rows)}`);
      }
    }
    if (info.lastEventId !== manifest.lastEventId) fail('the last event is not the manifest’s');
    let live = 'no live comparison';
    const events = manifest.tables['events'] ?? 0;
    if (compareLive && manifest.lastEventId !== null) {
      const liveCount = this.#options.store.countEventsThrough(manifest.lastEventId);
      if (liveCount > events) {
        fail(
          `the live store has ${String(liveCount)} events up to ${manifest.lastEventId}, the archive ${String(events)}`,
        );
      }
      live =
        liveCount === events
          ? 'matches the live store at its last event'
          : 'the live store was restored to an earlier point since';
    }
    const blobs = manifest.files.length - 1;
    return `${extracted.header.id}: integrity ok, ${String(Object.keys(manifest.tables).length)} tables, ${String(events)} events, ${String(blobs)} blobs; ${live}`;
  }

  // restore (rule 9, C-04-10)

  restore(id: string): Promise<{ preRestoreBackupId: string; restored: string }> {
    return this.#exclusive(async () => {
      const config = this.#config();
      const name = (await archivesIn(this.#dir)).find((file) => file.id === id)?.name;
      let path = name === undefined ? undefined : join(this.#dir, name);
      if (path === undefined && config.destination?.kind === 'folder') {
        const remote = (await archivesIn(config.destination.path)).find((file) => file.id === id);
        if (remote !== undefined) path = join(config.destination.path, remote.name);
      }
      if (path === undefined) {
        throw new CoreError('E_NOT_FOUND', `no archive ${id} in the local set or the destination`, [
          'Pick an archive from Settings → Backups; pruned archives are gone',
        ]);
      }
      const restoreDir = join(this.#options.userData, RESTORE_DIRNAME);
      const staged = join(restoreDir, `staged-${id}`);
      await rm(staged, { recursive: true, force: true });
      await mkdir(staged, { recursive: true, mode: 0o700 });
      try {
        const extracted = await extractArchive(path, this.#keys, staged);
        this.#verify(extracted, staged, false);
        await rm(join(staged, 'manifest.json'), { force: true });
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        throw new CoreError('E_INVARIANT', `archive ${id} cannot be restored: ${message(error)}`, [
          'Nothing was changed; pick an earlier archive',
        ]);
      }
      // C-04-10: the current store is backed up first; no restore without it.
      let pre: BackupRecord;
      try {
        pre = await this.#run('pre_restore');
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        throw new CoreError(
          'E_INVARIANT',
          `the backup of the current store failed, so nothing was restored: ${message(error)}`,
          ['Fix the backup first (Settings → Backups), then restore'],
        );
      }
      const pending = {
        v: 1,
        restored: id,
        staged: `staged-${id}`,
        preRestoreBackupId: pre.id,
        at: this.#iso(),
      };
      await writeFile(join(restoreDir, PENDING_RESTORE_FILE), `${JSON.stringify(pending)}\n`, {
        mode: 0o600,
      });
      this.#logger.info('backups.restore_staged', { id, preRestoreBackupId: pre.id });
      this.#options.requestRestart?.('restore');
      return { preRestoreBackupId: pre.id, restored: id };
    });
  }

  // schedule (rule 1) and the state's side effects (rule 8)

  /** One scheduler pass: back up when due, test when due, then push on `failing`. */
  tick(): Promise<void> {
    return this.#exclusive(async () => {
      this.#watchConfig();
      if ((this.#options.busy?.() ?? []).length > 0 || this.#currentKey() === undefined) {
        this.#evaluate();
        return;
      }
      if (this.#backupDue()) {
        await this.#run('scheduled').catch(() => undefined);
      }
      if (this.#testDue()) await this.#test();
      this.#evaluate();
    });
  }

  /**
   * Due when no backup succeeded since the last daily shutdown ended, or, in a workspace
   * without one, since the local day began: the first idle check of the day takes it.
   */
  #backupDue(): boolean {
    if (this.#history.testRequested === true) {
      const newest = this.#history.records[0];
      const tested = this.#history.lastRestoreTest?.backupId;
      // A change asks for a fresh archive to test, unless the newest one is untested.
      if (newest === undefined || newest.id === tested) return true;
    }
    const lastOk = this.#history.records.find((r) => r.local.ok)?.at;
    if (lastOk === undefined) return true;
    const shutdown = this.#lastShutdownEnd(this.#now());
    if (shutdown !== undefined) return Date.parse(lastOk) < shutdown;
    const zone = this.#config().timeZone;
    return localDay(lastOk, zone) !== localDay(this.#iso(), zone);
  }

  #testDue(): boolean {
    if (this.#history.records.length === 0) return false;
    if (this.#history.testRequested === true) return true;
    const last = this.#history.lastRestoreTest;
    const every = (this.#options.restoreTestEveryDays ?? DEFAULT_RESTORE_TEST_EVERY_DAYS) * 24;
    return last === undefined || this.#now() - Date.parse(last.at) > every * HOUR_MS;
  }

  /** The end of the newest daily shutdown that has ended (02 §4.5). */
  #lastShutdownEnd(now: number): number | undefined {
    return this.#options.store.read((tx) => {
      const series = tx
        .list('meeting_series')
        .filter((s) => s.backboneMeetingKey === DAILY_SHUTDOWN_KEY)
        .map((s) => s.id as string);
      if (series.length === 0) return undefined;
      let latest: number | undefined;
      for (const instance of tx.list('meeting_instances')) {
        if (!series.includes(instance.seriesId)) continue;
        const end = Date.parse(instance.actualEnd ?? instance.scheduledEnd);
        if (end <= now && (latest === undefined || end > latest)) latest = end;
      }
      return latest;
    });
  }

  /** A new destination or key asks for a backup and a restore test (rule 7). */
  #watchConfig(): void {
    const config = this.#config();
    const key = this.#currentKey();
    const signature = JSON.stringify([config.destination ?? null, key?.id ?? null]);
    const offMachine = config.destination !== undefined && key?.origin === 'passphrase';
    let changed = false;
    if (this.#history.configSignature !== signature) {
      if (this.#history.configSignature !== undefined) this.#history.testRequested = true;
      this.#history.configSignature = signature;
      changed = true;
    }
    if (offMachine && this.#history.offMachineSince === undefined) {
      this.#history.offMachineSince = this.#iso();
      changed = true;
    }
    if (!offMachine && this.#history.offMachineSince !== undefined) {
      delete this.#history.offMachineSince;
      changed = true;
    }
    if (changed) this.#save();
  }

  /** Records when `failing` began and pushes once per spell (rule 8, AC-04-11). */
  #evaluate(): BackupStatus {
    const status = this.status();
    if (status.state === 'failing') {
      if (this.#history.failingSince === undefined) {
        this.#history.failingSince = this.#iso();
        this.#save();
        this.#options.notify?.({
          id: 'backup-failing',
          kind: 'backup_failing',
          title: 'Backups are failing',
          body: status.reasons[0] ?? 'Open Settings → Backups.',
        });
      }
    } else if (this.#history.failingSince !== undefined) {
      delete this.#history.failingSince;
      this.#save();
    }
    return status;
  }

  // plumbing

  #exclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(job, job);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #currentKey(): BackupKey | undefined {
    return this.#keys.at(-1);
  }

  #config(): Config {
    try {
      return this.#options.store.read((tx) => {
        const workspace = tx.list('workspace', { limit: 1 })[0];
        const backup = tx.list('onboarding', { limit: 1 })[0]?.profile.workspace.backup;
        return {
          timeZone: workspace?.timeZone ?? 'UTC',
          ...(backup?.destination === undefined ? {} : { destination: backup.destination }),
        };
      });
    } catch {
      // A store not yet migrated (the pre-migration backup) may lack these tables.
      return { timeZone: 'UTC' };
    }
  }

  #now(): number {
    return this.#options.clock.now().getTime();
  }

  #iso(): string {
    return this.#options.clock.now().toISOString();
  }

  #load(): History {
    try {
      const parsed = JSON.parse(readFileSync(this.#historyPath, 'utf8')) as History;
      if (parsed.v === 1 && Array.isArray(parsed.records) && typeof parsed.since === 'string') {
        return parsed;
      }
    } catch {
      // no history yet, or an unreadable one: start a new one
    }
    const fresh: History = { v: 1, since: this.#iso(), records: [] };
    this.#history = fresh;
    this.#save();
    return fresh;
  }

  #save(): void {
    const temp = `${this.#historyPath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.#history, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.#historyPath);
  }
}

/**
 * Applies a staged restore before the store opens (04 §9.1 rule 9): the current
 * `workspace.db` and its WAL and shared-memory files move to `<userData>/restore/replaced/`,
 * the staged database takes their place, and the staged blobs join `<userData>/blobs/`.
 * Returns the restored archive's ID, or undefined when nothing was pending.
 */
export function applyPendingRestore(
  userData: string,
  logger: Logger = silentLogger,
): string | undefined {
  const restoreDir = join(userData, RESTORE_DIRNAME);
  const pendingPath = join(restoreDir, PENDING_RESTORE_FILE);
  if (!existsSync(pendingPath)) return undefined;
  let pending: { restored?: unknown; staged?: unknown };
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as typeof pending;
  } catch {
    fs.rmSync(pendingPath, { force: true });
    logger.error('backups.restore_unreadable');
    return undefined;
  }
  const staged =
    typeof pending.staged === 'string' && /^staged-bkp_[0-9A-Z]{26}$/.test(pending.staged)
      ? join(restoreDir, pending.staged)
      : undefined;
  const database = staged === undefined ? undefined : join(staged, 'workspace.db');
  if (database === undefined || !existsSync(database)) {
    fs.rmSync(pendingPath, { force: true });
    logger.error('backups.restore_missing', { staged: String(pending.staged) });
    return undefined;
  }
  const replaced = join(restoreDir, 'replaced');
  fs.rmSync(replaced, { recursive: true, force: true });
  fs.mkdirSync(replaced, { recursive: true, mode: 0o700 });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(userData, `workspace.db${suffix}`);
    if (existsSync(file)) renameSync(file, join(replaced, `workspace.db${suffix}`));
  }
  renameSync(database, join(userData, 'workspace.db'));
  const stagedBlobs = join(staged as string, 'blobs');
  if (existsSync(stagedBlobs)) {
    for (const prefix of fs.readdirSync(stagedBlobs)) {
      const target = join(userData, 'blobs', prefix);
      fs.mkdirSync(target, { recursive: true });
      for (const blob of fs.readdirSync(join(stagedBlobs, prefix))) {
        const to = join(target, blob);
        if (!existsSync(to)) fs.copyFileSync(join(stagedBlobs, prefix, blob), to);
      }
    }
  }
  fs.rmSync(staged as string, { recursive: true, force: true });
  fs.rmSync(pendingPath, { force: true });
  const restored = typeof pending.restored === 'string' ? pending.restored : 'an archive';
  logger.info('backups.restored', { id: restored });
  return restored;
}
