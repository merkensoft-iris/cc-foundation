/**
 * The core service (04 §3): the one process that serves the local API, owns the principals
 * and runs the schedulers. Under Electron it runs in a `utilityProcess` started by main
 * (P1-10); for development and tests it runs headless under plain Node (`./headless.ts`).
 *
 * Start-up: make `<userData>` and `<userData>/run` private, make sure `cli-default` exists,
 * plan and prepare the endpoint (ADR 0002), listen, write the endpoint record, and start the
 * endpoint watchdog and the rhythm jobs on the scheduler (rhythm-jobs.ts: the horizon
 * extension, pre-reads, the missed check and the nightly escalation). Stop reverses it: stop
 * the scheduler, close the listener and connections, remove the record (if ours) and the
 * fallback directory.
 *
 * Records: the core opens the workspace store in `<userData>` (@cc/store, 04 §9) unless the
 * caller hands it one, keeps the principals in its `agent_principals` table and serves the
 * domain-backed handlers (P1-03) over it. More handlers can be added through `register`.
 *
 * Backups (04 §9.1, P1-17): a staged restore is applied before the store opens; the backup
 * check runs on the scheduler every ten minutes; the keys come from the caller (main hands
 * them over from `safeStorage`, 04 §3), never from a file the core reads.
 */
import fs from 'node:fs';
import type net from 'node:net';
import path from 'node:path';

import { assertNotSyncedFolder, openStore, pendingMigrations, type Store } from '@cc/store';

import { applyPendingRestore, Backups, type BackupPush } from './backups/engine.js';
import type { BackupKey } from './backups/format.js';
import type { Retention } from './backups/retention.js';

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { Dispatcher } from './dispatch.js';
import {
  type EndpointRecord,
  type PreparedEndpoint,
  listenPrivate,
  makeFallbackDir,
  planEndpoint,
  prepareEndpoint,
  recordPathOf,
  removeRecord,
  SOCKET_NAME,
  writeRecord,
} from './endpoint.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { registerConnectorHandlers } from './handlers/connectors.js';
import { registerBackupHandlers } from './handlers/backups.js';
import { registerItemHandlers } from './handlers/items.js';
import { registerMeetingHandlers } from './handlers/meetings.js';
import { registerOnboardingHandlers, type CommittedListener } from './handlers/onboarding.js';
import { registerPrincipalHandlers } from './handlers/principals.js';
import { registerReadHandlers } from './handlers/reads.js';
import { registerReviewHandlers } from './handlers/review.js';
import { registerWriteHandlers } from './handlers/writes.js';
import { Meetings } from './meetings.js';
import { Principals } from './principals.js';
import { scheduleRhythmJobs, type RhythmJobs, type RhythmListener } from './rhythm-jobs.js';
import { StorePrincipalDirectory } from './store-principals.js';
import { StoreRecordStore, type InstalledActions } from './store-records.js';
import { Scheduler } from './scheduler.js';
import { LocalApiServer } from './server.js';
import { serveUiPort, type UiPort } from './ui-port.js';

/** ADR 0002 decision 4: the watchdog runs every 60 s. */
export const WATCHDOG_INTERVAL_MS = 60_000;
export const WATCHDOG_JOB = 'endpoint-watchdog';
/** The backup check (04 §9.1 rule 1): due runs, due restore tests, the state's pushes. */
export const BACKUP_JOB = 'backups';
export const BACKUP_CHECK_INTERVAL_MS = 10 * 60_000;

export interface CoreOptions {
  /** `<userData>`: Electron's `app.getPath('userData')`, or the headless `--profile-dir`. */
  readonly userData: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /**
   * An open workspace store to use; the caller keeps it and closes it. By default the core
   * opens the store in `<userData>` and closes it on stop.
   */
  readonly store?: Store;
  /** The environment the store's synced-folder check reads (04 §9 rule 5); `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The installed connector actions (INV-03-08); none until the Connector Host (P2). */
  readonly installedActions?: InstalledActions;
  /** Called after the onboarding commit, with the committed answers (01 §3 S9). */
  readonly onOnboardingCommitted?: CommittedListener;
  /** Registers the method handlers on the dispatcher. */
  readonly register?: (dispatcher: Dispatcher, core: CoreHandle) => void;
  /** Where fallback directories go; `/tmp` by default (ADR 0002 decision 4). */
  readonly tmpRoot?: string;
  readonly watchdogIntervalMs?: number;
  /** Called after each rhythm job that changed something (rhythm-jobs.ts). */
  readonly onRhythmRun?: RhythmListener;
  readonly authTimeoutMs?: number;
  readonly validateResults?: boolean;
  /**
   * The backup keys, the newest last (04 §9.1 rule 3). Main reads them from `safeStorage`;
   * headless mode has none unless a test passes them, and then backups cannot run.
   */
  readonly backupKeys?: readonly BackupKey[];
  /** Pushes a desktop notification (02 §10); main shows it. */
  readonly notify?: (push: BackupPush) => void;
  /** Asks the host to restart the core: a staged restore applies at the next start. */
  readonly requestRestart?: (reason: string) => void;
  /** Overrides for tests: retention, the restore-test period, chunk size, check interval. */
  readonly backups?: {
    readonly retention?: Retention;
    readonly offMachineRetention?: Retention;
    readonly restoreTestEveryDays?: number;
    readonly chunkBytes?: number;
    readonly checkIntervalMs?: number;
  };
}

/** What handler registration may use. */
export interface CoreHandle {
  readonly userData: string;
  /** The workspace store the core reads and writes. */
  readonly store: Store;
  /** The records the handlers run their commands on. */
  readonly records: StoreRecordStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly principals: Principals;
  readonly scheduler: Scheduler;
  /** The backups of 04 §9.1. */
  readonly backups: Backups;
}

export interface CoreService extends CoreHandle {
  readonly dispatcher: Dispatcher;
  /** The endpoint as recorded in `<userData>/run/endpoint`. */
  readonly endpoint: EndpointRecord;
  /** Runs one call as the user, as the UI path does (04 §4.3 rule 1). */
  callAsUser(method: string, params?: unknown): Promise<unknown>;
  /** Serves UI calls from a port as the user (P1-10 passes the MessagePort from main). */
  serveUi(port: UiPort): void;
  /** The rhythm jobs the scheduler runs (02 §4.1 rule 2, §4.2 rule 2, §4.7, §7.2 rule 1). */
  readonly rhythm: RhythmJobs;
  /** One watchdog pass (ADR 0002 decision 4); the scheduler runs it every interval. */
  checkEndpoint(): Promise<WatchdogOutcome>;
  /**
   * Why the app is not idle now; empty when it is. Idle means no meeting `in_progress` and
   * no run in flight (04 §10 rule 2): the shell restarts on a new build only when idle.
   * Runs arrive with the orchestrator (P3); until then only meetings count.
   */
  busy(): readonly string[];
  /** Main hands over new backup keys after the user sets a passphrase (04 §9.1 rule 3). */
  setBackupKeys(keys: readonly BackupKey[]): void;
  stop(): Promise<void>;
}

export type WatchdogOutcome =
  | 'ok'
  | 'stopped'
  | 'record rewritten'
  | 'rebound'
  | 'rebound in a new fallback directory'
  | 'replaced by another file; left alone';

function inodeOf(file: string): number | undefined {
  try {
    return fs.lstatSync(file).ino;
  } catch {
    return undefined;
  }
}

export async function startCore(options: CoreOptions): Promise<CoreService> {
  const userData = path.resolve(options.userData);
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const tmpRoot = options.tmpRoot ?? '/tmp';

  const ownsStore = options.store === undefined;
  // 04 §9 rule 5, AC-04-12: refuse a synced folder before anything is written there.
  if (ownsStore) assertNotSyncedFolder(userData, options.env);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  // A restore staged before the restart replaces the store before it opens (04 §9.1 rule 9).
  if (ownsStore) applyPendingRestore(userData, logger);
  // 04 §9.1 rule 1: a backup before every migration.
  if (ownsStore) await preMigrationBackup(options, userData, clock, logger);
  const store =
    options.store ??
    openStore({
      userDataDir: userData,
      now: () => clock.now().toISOString(),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  try {
    return await serve(options, { userData, clock, logger, tmpRoot, store, ownsStore });
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
}

/**
 * Backs up the store as it is before migrations change it (04 §9.1 rule 1). With no key
 * (headless mode without a test keyring) there is nothing to seal with, and the log says so;
 * with a key, a failed backup stops the start, so no migration runs without one.
 */
async function preMigrationBackup(
  options: CoreOptions,
  userData: string,
  clock: Clock,
  logger: Logger,
): Promise<void> {
  const pending = pendingMigrations(userData);
  if (pending === 0) return;
  if (options.backupKeys === undefined || options.backupKeys.length === 0) {
    logger.warn('backups.pre_migration_skipped', { pending, reason: 'no backup key' });
    return;
  }
  const store = openStore({
    userDataDir: userData,
    now: () => clock.now().toISOString(),
    migrate: false,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  try {
    const backups = new Backups({ userData, store, clock, logger, keys: options.backupKeys });
    const record = await backups.run('pre_migration');
    logger.info('backups.pre_migration', { id: record.id, pending });
  } finally {
    store.close();
  }
}

interface Basics {
  readonly userData: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly tmpRoot: string;
  readonly store: Store;
  readonly ownsStore: boolean;
}

async function serve(options: CoreOptions, basics: Basics): Promise<CoreService> {
  const { userData, clock, logger, tmpRoot, store, ownsStore } = basics;
  const records = new StoreRecordStore(store, {
    ...(options.installedActions === undefined
      ? {}
      : { installedActions: options.installedActions }),
  });
  const principals = new Principals({
    userData,
    directory: new StorePrincipalDirectory(store),
    clock,
  });
  const scheduler = new Scheduler({ clock, logger });
  const backups = new Backups({
    userData,
    store,
    clock,
    logger,
    ...(options.backupKeys === undefined ? {} : { keys: options.backupKeys }),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.requestRestart === undefined ? {} : { requestRestart: options.requestRestart }),
    busy: () => busyReasons(store),
    ...(options.backups?.retention === undefined ? {} : { retention: options.backups.retention }),
    ...(options.backups?.offMachineRetention === undefined
      ? {}
      : { offMachineRetention: options.backups.offMachineRetention }),
    ...(options.backups?.restoreTestEveryDays === undefined
      ? {}
      : { restoreTestEveryDays: options.backups.restoreTestEveryDays }),
    ...(options.backups?.chunkBytes === undefined
      ? {}
      : { chunkBytes: options.backups.chunkBytes }),
  });
  const dispatcher = new Dispatcher({
    clock,
    logger,
    ...(options.validateResults === undefined ? {} : { validateResults: options.validateResults }),
  });
  const handle: CoreHandle = {
    userData,
    store,
    records,
    clock,
    logger,
    principals,
    scheduler,
    backups,
  };

  const plan = planEndpoint({ userData, tmpRoot });
  let prepared: PreparedEndpoint = await prepareEndpoint(plan, { userData });
  for (const note of prepared.notes) logger.info('endpoint.prepare', { note });

  await principals.ensureDefault();
  registerItemHandlers(dispatcher, records);
  registerReadHandlers(dispatcher, store, clock, () => {
    const status = backups.status();
    return {
      state: status.state,
      ...(status.lastGood === undefined ? {} : { lastGood: status.lastGood }),
    };
  });
  registerWriteHandlers(dispatcher, records, store, clock);
  registerReviewHandlers(dispatcher, records, store);
  const meetings = new Meetings(store, {
    clock,
    backupState: () => backups.preReadState(),
    attention: () => backups.attention(),
  });
  registerMeetingHandlers(dispatcher, meetings, store, clock);
  registerPrincipalHandlers(dispatcher, principals);
  registerConnectorHandlers(dispatcher, store, clock);
  // The commit writes the series and their instances: the rhythm jobs plan around them.
  // They are scheduled once the core listens, below.
  let replanRhythm = (): void => undefined;
  registerOnboardingHandlers(dispatcher, store, {
    onCommitted: (profile) => {
      replanRhythm();
      options.onOnboardingCommitted?.(profile);
    },
  });
  registerBackupHandlers(dispatcher, backups);
  options.register?.(dispatcher, handle);

  const api = new LocalApiServer({
    dispatcher,
    principals,
    clock,
    logger,
    ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
  });
  let listener: net.Server = api.createListener();
  try {
    await listenPrivate(listener, prepared.path);
  } catch (error) {
    if (prepared.fallbackDir !== undefined)
      fs.rmSync(prepared.fallbackDir, { recursive: true, force: true });
    throw error;
  }
  let boundInode = prepared.transport === 'unix' ? inodeOf(prepared.path) : undefined;
  let record = writeRecord(userData, prepared, clock.now());
  logger.info('endpoint.listening', { path: record.path, transport: record.transport });

  let stopped = false;

  const rebind = async (next: PreparedEndpoint): Promise<void> => {
    const old = listener;
    listener = api.createListener();
    // Close the old listener first: closing a UNIX listener unlinks its path.
    old.close();
    await listenPrivate(listener, next.path);
    prepared = next;
    boundInode = inodeOf(next.path);
    record = writeRecord(userData, next, clock.now());
  };

  const checkEndpoint = async (): Promise<WatchdogOutcome> => {
    if (stopped) return 'stopped';
    if (prepared.transport === 'pipe') return 'ok';
    if (prepared.fallbackDir !== undefined && !fs.existsSync(prepared.fallbackDir)) {
      const dir = makeFallbackDir(tmpRoot);
      await rebind({
        transport: 'unix',
        path: path.join(dir, SOCKET_NAME),
        fallbackDir: dir,
        notes: [],
      });
      logger.warn('endpoint.rebound', { reason: 'fallback directory deleted', path: record.path });
      return 'rebound in a new fallback directory';
    }
    const inode = inodeOf(prepared.path);
    if (inode === undefined) {
      await rebind(prepared);
      logger.warn('endpoint.rebound', { reason: 'socket deleted', path: record.path });
      return 'rebound';
    }
    if (inode !== boundInode) {
      logger.error('endpoint.replaced', { path: prepared.path });
      return 'replaced by another file; left alone';
    }
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(fs.readFileSync(recordPathOf(userData), 'utf8'));
    } catch {
      onDisk = undefined;
    }
    const current = onDisk as Partial<EndpointRecord> | undefined;
    if (current?.path !== record.path || current.pid !== process.pid) {
      record = writeRecord(userData, prepared, clock.now());
      logger.warn('endpoint.record_rewritten', { path: record.path });
      return 'record rewritten';
    }
    return 'ok';
  };

  scheduler.every(BACKUP_JOB, options.backups?.checkIntervalMs ?? BACKUP_CHECK_INTERVAL_MS, () =>
    backups.tick(),
  );

  scheduler.every(WATCHDOG_JOB, options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS, async () => {
    const outcome = await checkEndpoint();
    if (outcome !== 'ok') logger.info('endpoint.watchdog', { outcome });
  });
  const rhythm = scheduleRhythmJobs(scheduler, {
    store,
    records,
    meetings,
    clock,
    logger,
    ...(options.onRhythmRun === undefined ? {} : { onRun: options.onRhythmRun }),
  });
  replanRhythm = () => rhythm.replan();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await scheduler.stop();
    await api.close();
    removeRecord(userData);
    if (prepared.fallbackDir !== undefined) {
      fs.rmSync(prepared.fallbackDir, { recursive: true, force: true });
    }
    if (ownsStore) store.close();
    logger.info('core.stopped');
  };

  return {
    ...handle,
    dispatcher,
    rhythm,
    get endpoint() {
      return record;
    },
    callAsUser: (method, params) => dispatcher.call({ kind: 'user' }, method, params),
    serveUi: (port) => serveUiPort(dispatcher, port),
    checkEndpoint,
    busy: () => busyReasons(store),
    setBackupKeys: (keys) => backups.setKeys(keys),
    stop,
  };
}

/** The idle test of 04 §10 rule 2 over the workspace store. */
export function busyReasons(store: Store): string[] {
  const meetings = store
    .read((tx) => tx.list('meeting_instances'))
    .filter((instance) => instance.state === 'in_progress');
  // TODO(P3): runs in flight, once the orchestrator records them.
  return meetings.length === 0
    ? []
    : [`${meetings.length} meeting${meetings.length === 1 ? '' : 's'} in progress`];
}
