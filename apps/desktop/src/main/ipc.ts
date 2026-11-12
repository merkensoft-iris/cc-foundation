/**
 * The renderer's typed IPC (04 §3): `window.cc.invoke(method, params)` in the preload
 * becomes one `cc:invoke` call here, which main forwards to the core as the user (04 §4.3
 * rule 1). The renderer names only a method and params; it cannot name an actor, a
 * principal or a token.
 *
 * Only the app's own top frame may call: a frame from any other origin, or a subframe, is
 * refused. Answers are an envelope, because Electron passes only an `Error`'s message
 * across `invoke`, and the renderer needs the code and help lines (07 §4.4).
 *
 * `cc:rebuild` is the window's Rebuild now and Later (04 §10 rule 2). It is a shell action,
 * not a core method, so no local API client (CLI, MCP) can reach it (OQ-04-11).
 *
 * `backups.passphrase` (onboarding S1, 01 §3.1 row 9; 04 §9.1 rule 3) is answered here first:
 * main keeps the passphrase in the OS secret store (`safeStorage`, `<userData>/secrets/`), and
 * the core is told only that it is set. The passphrase never reaches the core, the store or a
 * log.
 */
import type { ApiErrorData } from '@cc/schemas';

import type { StartMode } from '../shared/protocol.js';
import { APP_URL } from './app-protocol.js';
import { UiCallError } from './core-supervisor.js';
import type { RebuildState } from './rebuild-offer.js';

export const INVOKE_CHANNEL = 'cc:invoke';
export const SHELL_CHANNEL = 'cc:shell';
export const NAVIGATE_CHANNEL = 'cc:navigate';
export const REBUILD_CHANNEL = 'cc:rebuild';
/** main → renderer: the Rebuild now offer changed. */
export const REBUILD_STATE_CHANNEL = 'cc:rebuild-state';

export type RebuildAction = 'state' | 'now' | 'later';

/** The human-only method whose secret main keeps (04 §9.1 rule 3). */
export const BACKUP_PASSPHRASE_METHOD = 'backups.passphrase';
/** The shortest backup passphrase accepted; CC cannot recover a lost one (04 §9.1 rule 3). */
export const MIN_PASSPHRASE_LENGTH = 12;

export type InvokeAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ApiErrorData };

/** What the renderer learns about the shell. */
export interface ShellInfo {
  readonly mode: StartMode;
  readonly version: string;
}

/** The `IpcMainInvokeEvent` parts the bridge reads. */
export interface InvokeEvent {
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEvent, ...args: unknown[]) => unknown): void;
}

export interface BridgeOptions {
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly shellInfo: () => Promise<ShellInfo>;
  /** The Rebuild now offer; absent in tests that do not need it. */
  readonly rebuild?: {
    readonly state: () => Promise<RebuildState>;
    readonly now: () => Promise<RebuildState>;
    readonly later: () => Promise<RebuildState>;
  };
  /** Keeps the backup passphrase in the secret store; absent where there is none. */
  readonly storeBackupPassphrase?: (passphrase: string) => Promise<void>;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

const METHOD = /^[a-z]+(?:\.[a-zA-Z]+)+$/;
const MAX_METHOD_LENGTH = 64;

/** The app's own top frame, and nothing else. */
export function isTrustedSender(event: InvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && frame.url.startsWith(APP_URL);
}

function refused(message: string): InvokeAnswer {
  return { ok: false, error: { code: 'E_FORBIDDEN', message, help: [] } };
}

function failed(code: string, message: string, help: string[] = []): InvokeAnswer {
  return { ok: false, error: { code, message, help } };
}

/** S1's passphrase: into the secret store, then the core records that it is set. */
async function setBackupPassphrase(options: BridgeOptions, params: unknown): Promise<InvokeAnswer> {
  const passphrase =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)['passphrase']
      : undefined;
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return failed(
      'E_USAGE',
      `a backup passphrase has at least ${String(MIN_PASSPHRASE_LENGTH)} characters`,
      ['Command Center cannot recover a lost passphrase: keep it somewhere safe (04 §9.1)'],
    );
  }
  if (options.storeBackupPassphrase === undefined) {
    return failed('E_FORBIDDEN', 'this app has no secret store to keep the passphrase in', [
      'Set the passphrase in the installed app',
    ]);
  }
  try {
    await options.storeBackupPassphrase(passphrase);
  } catch {
    options.log?.('ipc.secret_store_failed', { method: BACKUP_PASSPHRASE_METHOD });
    return failed('E_PERMISSION', 'the OS secret store refused the passphrase', [
      'Check that the system keychain is unlocked, then try again',
    ]);
  }
  try {
    return { ok: true, result: await options.call(BACKUP_PASSPHRASE_METHOD, {}) };
  } catch (error) {
    if (error instanceof UiCallError) return { ok: false, error: error.data };
    return failed('E_CRASH', `${BACKUP_PASSPHRASE_METHOD} failed in the app`);
  }
}

export async function handleInvoke(
  options: BridgeOptions,
  event: InvokeEvent,
  method: unknown,
  params: unknown,
): Promise<InvokeAnswer> {
  if (!isTrustedSender(event)) {
    options.log?.('ipc.refused', { url: event.senderFrame?.url ?? null });
    return refused('only the app window may call the core');
  }
  if (typeof method !== 'string' || method.length > MAX_METHOD_LENGTH || !METHOD.test(method)) {
    return {
      ok: false,
      error: { code: 'E_USAGE', message: 'a method is <namespace>.<verb>', help: [] },
    };
  }
  if (method === BACKUP_PASSPHRASE_METHOD) return setBackupPassphrase(options, params);
  try {
    return { ok: true, result: await options.call(method, params) };
  } catch (error) {
    if (error instanceof UiCallError) return { ok: false, error: error.data };
    options.log?.('ipc.internal_error', { method });
    return {
      ok: false,
      error: { code: 'E_CRASH', message: `${method} failed in the app`, help: [] },
    };
  }
}

export function registerBridge(ipc: IpcMainLike, options: BridgeOptions): void {
  ipc.handle(INVOKE_CHANNEL, (event, method, params) =>
    handleInvoke(options, event, method, params),
  );
  ipc.handle(SHELL_CHANNEL, (event) => {
    if (!isTrustedSender(event)) return Promise.reject(new Error('refused'));
    return options.shellInfo();
  });
  ipc.handle(REBUILD_CHANNEL, (event, action) => {
    if (!isTrustedSender(event)) {
      options.log?.('ipc.refused', { url: event.senderFrame?.url ?? null });
      return Promise.reject(new Error('refused'));
    }
    const rebuild = options.rebuild;
    if (rebuild === undefined) return Promise.resolve({ kind: 'none' } satisfies RebuildState);
    switch (action as RebuildAction) {
      case 'state':
        return rebuild.state();
      case 'now':
        return rebuild.now();
      case 'later':
        return rebuild.later();
      default:
        return Promise.reject(new Error('unknown rebuild action'));
    }
  });
}
