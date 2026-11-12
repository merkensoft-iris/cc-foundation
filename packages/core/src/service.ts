/**
 * The core service (04 §3): the one process that serves the local API, owns the principals
 * and runs the schedulers. Under Electron it runs in a `utilityProcess` started by main
 * (P1-10); for development and tests it runs headless under plain Node (`./headless.ts`).
 *
 * Start-up: make `<userData>` and `<userData>/run` private, make sure `cli-default` exists,
 * plan and prepare the endpoint (ADR 0002), listen, write the endpoint record, and start the
 * endpoint watchdog on the scheduler. Stop reverses it: stop the scheduler, close the
 * listener and connections, remove the record (if ours) and the fallback directory.
 *
 * Records: the core opens the workspace store in `<userData>` (@cc/store, 04 §9) unless the
 * caller hands it one, keeps the principals in its `agent_principals` table and serves the
 * domain-backed handlers (P1-03) over it. More handlers can be added through `register`.
 */
import fs from 'node:fs';
import type net from 'node:net';
import path from 'node:path';

import { openStore, type Store } from '@cc/store';

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
import { registerItemHandlers } from './handlers/items.js';
import { registerMeetingHandlers } from './handlers/meetings.js';
import { registerOnboardingHandlers, type CommittedListener } from './handlers/onboarding.js';
import { registerPrincipalHandlers } from './handlers/principals.js';
import { registerReadHandlers } from './handlers/reads.js';
import { registerReviewHandlers } from './handlers/review.js';
import { registerWriteHandlers } from './handlers/writes.js';
import { Meetings } from './meetings.js';
import { Principals } from './principals.js';
import { StorePrincipalDirectory } from './store-principals.js';
import { StoreRecordStore, type InstalledActions } from './store-records.js';
import { Scheduler } from './scheduler.js';
import { LocalApiServer } from './server.js';
import { serveUiPort, type UiPort } from './ui-port.js';

/** ADR 0002 decision 4: the watchdog runs every 60 s. */
export const WATCHDOG_INTERVAL_MS = 60_000;
export const WATCHDOG_JOB = 'endpoint-watchdog';

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
  readonly authTimeoutMs?: number;
  readonly validateResults?: boolean;
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
}

export interface CoreService extends CoreHandle {
  readonly dispatcher: Dispatcher;
  /** The endpoint as recorded in `<userData>/run/endpoint`. */
  readonly endpoint: EndpointRecord;
  /** Runs one call as the user, as the UI path does (04 §4.3 rule 1). */
  callAsUser(method: string, params?: unknown): Promise<unknown>;
  /** Serves UI calls from a port as the user (P1-10 passes the MessagePort from main). */
  serveUi(port: UiPort): void;
  /** One watchdog pass (ADR 0002 decision 4); the scheduler runs it every interval. */
  checkEndpoint(): Promise<WatchdogOutcome>;
  /**
   * Why the app is not idle now; empty when it is. Idle means no meeting `in_progress` and
   * no run in flight (04 §10 rule 2): the shell restarts on a new build only when idle.
   * Runs arrive with the orchestrator (P3); until then only meetings count.
   */
  busy(): readonly string[];
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

  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const ownsStore = options.store === undefined;
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
  const dispatcher = new Dispatcher({
    clock,
    logger,
    ...(options.validateResults === undefined ? {} : { validateResults: options.validateResults }),
  });
  const handle: CoreHandle = { userData, store, records, clock, logger, principals, scheduler };

  const plan = planEndpoint({ userData, tmpRoot });
  let prepared: PreparedEndpoint = await prepareEndpoint(plan, { userData });
  for (const note of prepared.notes) logger.info('endpoint.prepare', { note });

  await principals.ensureDefault();
  registerItemHandlers(dispatcher, records);
  registerReadHandlers(dispatcher, store, clock);
  registerWriteHandlers(dispatcher, records, store, clock);
  registerReviewHandlers(dispatcher, records, store);
  registerMeetingHandlers(dispatcher, new Meetings(store, { clock }), store, clock);
  registerPrincipalHandlers(dispatcher, principals);
  registerOnboardingHandlers(dispatcher, store, {
    ...(options.onOnboardingCommitted === undefined
      ? {}
      : { onCommitted: options.onOnboardingCommitted }),
  });
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

  scheduler.every(WATCHDOG_JOB, options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS, async () => {
    const outcome = await checkEndpoint();
    if (outcome !== 'ok') logger.info('endpoint.watchdog', { outcome });
  });

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
    get endpoint() {
      return record;
    },
    callAsUser: (method, params) => dispatcher.call({ kind: 'user' }, method, params),
    serveUi: (port) => serveUiPort(dispatcher, port),
    checkEndpoint,
    busy: () => busyReasons(store),
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
