/**
 * The core host: the code that runs in the core's `utilityProcess` (04 §3). It waits for
 * main's `init`, starts the core service with main's `<userData>` and start mode, serves UI
 * calls from the transferred port as the user, and stops the core on `stop`.
 *
 * Backups (04 §9.1): the keys main sends in `init` and `backup-keys` go to the core; a staged
 * restore asks main for a restart. A core that refuses to start for a reason a restart cannot
 * fix (`E_GUARD_*`, such as a data directory inside a synced folder, 04 §9 rule 5) is
 * reported as `refused` with its help lines, so main shows them and exits (AC-04-12).
 *
 * The core is reached through `StartCore`, the shape of `@cc/core`'s `startCore` (09 P1-04);
 * `index.ts` passes the real one (`real-core.ts`), tests pass fakes.
 */
import type { UiPort } from '@cc/core';
import type { SerializedBackupKey } from '@cc/core/backup-keys';

import type {
  HostToMain,
  MainToHost,
  NotificationPolicy,
  PushRequest,
  StartMode,
} from '../shared/protocol.js';

/** What the host needs of a started core (`@cc/core` `CoreService` has it). */
export interface CoreLike {
  readonly endpoint?: { readonly transport: string; readonly path: string };
  serveUi(port: UiPort): void;
  /** Why the app is not idle; empty when it is (`@cc/core` `CoreService.busy`). */
  busy?(): readonly string[];
  /** Replaces the backup keys (`@cc/core` `CoreService.setBackupKeys`). */
  setBackupKeys?(keys: readonly SerializedBackupKey[]): void;
  stop(): Promise<void>;
}

/** What a core may tell main. */
export interface HostEvents {
  notify(notification: PushRequest): void;
  setNotificationPolicy(policy: NotificationPolicy): void;
  /** Asks main to restart the core (a staged restore, 04 §9.1 rule 9). */
  requestRestart(reason: string): void;
}

export interface StartCoreOptions {
  readonly userData: string;
  readonly mode: StartMode;
  readonly events: HostEvents;
  /** The backup keys main keeps wrapped by `safeStorage` (04 §9.1 rule 3). */
  readonly backupKeys: readonly SerializedBackupKey[];
}

export type StartCore = (options: StartCoreOptions) => Promise<CoreLike>;

/** The core end of the UI channel (Electron `MessagePortMain` in the utility process). */
export interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
}

/** `process.parentPort` in a utility process. */
export interface ParentPort {
  postMessage(message: HostToMain): void;
  on(
    event: 'message',
    listener: (event: { readonly data: unknown; readonly ports: readonly HostPort[] }) => void,
  ): void;
}

/** Adapts a `MessagePortMain` to `@cc/core`'s `UiPort`. */
export function uiPortOf(port: HostPort): UiPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', ({ data }) => listener(data));
      port.start();
    },
  };
}

function isMainMessage(value: unknown): value is MainToHost {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message['type'] === 'stop') return true;
  if (message['type'] === 'activity') return typeof message['id'] === 'number';
  if (message['type'] === 'backup-keys') return Array.isArray(message['keys']);
  if (message['backupKeys'] !== undefined && !Array.isArray(message['backupKeys'])) return false;
  if (message['type'] !== 'init' || typeof message['userData'] !== 'string') return false;
  const mode = message['mode'] as Record<string, unknown> | undefined;
  return (
    mode?.['kind'] === 'normal' ||
    (mode?.['kind'] === 'developer' && Array.isArray(mode['reasons']))
  );
}

/** A start failure no restart can fix: an `E_GUARD_*` error with its help lines. */
function refusalOf(
  error: unknown,
): { code: string; message: string; help: readonly string[] } | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, help } = error as Error & { code?: unknown; help?: unknown };
  if (typeof code !== 'string' || !code.startsWith('E_GUARD_')) return undefined;
  return {
    code,
    message: error.message,
    help: Array.isArray(help)
      ? help.filter((line): line is string => typeof line === 'string')
      : [],
  };
}

export interface HostOptions {
  readonly parentPort: ParentPort;
  readonly startCore: StartCore;
  /** Ends the process; `process.exit` in the utility process. */
  readonly exit: (code: number) => void;
}

export function runCoreHost(options: HostOptions): void {
  const { parentPort, startCore, exit } = options;
  let core: Promise<CoreLike> | undefined;

  const events: HostEvents = {
    notify: (notification) => parentPort.postMessage({ type: 'notify', notification }),
    setNotificationPolicy: (policy) =>
      parentPort.postMessage({ type: 'notification-policy', policy }),
    requestRestart: (reason) => parentPort.postMessage({ type: 'restart', reason }),
  };

  const fatal = (error: unknown): void => {
    const refusal = refusalOf(error);
    if (refusal !== undefined) {
      parentPort.postMessage({ type: 'refused', ...refusal });
      exit(1);
      return;
    }
    parentPort.postMessage({
      type: 'fatal',
      message: error instanceof Error ? error.message : String(error),
    });
    exit(1);
  };

  parentPort.on('message', ({ data, ports }) => {
    if (!isMainMessage(data)) return;
    if (data.type === 'init') {
      const port = ports[0];
      if (core !== undefined || port === undefined) return;
      core = startCore({
        userData: data.userData,
        mode: data.mode,
        events,
        backupKeys: data.backupKeys ?? [],
      });
      core.then((started) => {
        started.serveUi(uiPortOf(port));
        parentPort.postMessage({
          type: 'ready',
          ...(started.endpoint === undefined ? {} : { endpoint: started.endpoint }),
        });
      }, fatal);
      return;
    }
    if (data.type === 'activity') {
      const answer = (busy: readonly string[]) =>
        parentPort.postMessage({ type: 'activity', id: data.id, busy });
      if (core === undefined) {
        answer([]);
        return;
      }
      const failed = (error: unknown) =>
        answer([`cannot read activity: ${error instanceof Error ? error.message : String(error)}`]);
      core.then((started) => {
        try {
          answer(started.busy?.() ?? []);
        } catch (error) {
          failed(error);
        }
      }, failed);
      return;
    }
    if (data.type === 'backup-keys') {
      void core?.then(
        (started) => started.setBackupKeys?.(data.keys),
        () => undefined,
      );
      return;
    }
    // stop
    if (core === undefined) {
      exit(0);
      return;
    }
    core
      .then((started) => started.stop())
      .then(
        () => exit(0),
        () => exit(1),
      );
  });
}
