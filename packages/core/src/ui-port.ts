/**
 * The app UI's path to the core (04 §3, 04 §4.3 rule 1): renderer → main → core over IPC.
 * Calls arriving here run as actor `user`; the main process attaches it, and the renderer
 * cannot claim another actor because messages carry only a method and params.
 *
 * Calls go through `ConfirmIntents.fromUi`, not straight to the dispatcher: a Tier H operation
 * (04 §4.3 rule 4, C-04-12) answers `{ status: 'needs_confirmation', intent }` and changes
 * nothing until the app shell approves the intent over the main ↔ core-host channel. No
 * message on this port can approve one.
 *
 * The desktop shell (P1-10) adapts Electron's `MessagePortMain` to `UiPort`; tests use a
 * Node `MessageChannel`.
 */
import type { ApiErrorData } from '@cc/schemas';

import type { ConfirmIntents } from './confirm-intents.js';
import { CoreError, isCoreError } from './errors.js';

export interface UiPort {
  postMessage(message: UiResponse): void;
  onMessage(listener: (message: unknown) => void): void;
}

export interface UiRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export type UiResponse =
  | { readonly id: number | string | null; readonly result: unknown }
  | { readonly id: number | string | null; readonly error: ApiErrorData };

function isUiRequest(value: unknown): value is UiRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  return (
    (typeof message['id'] === 'number' || typeof message['id'] === 'string') &&
    typeof message['method'] === 'string' &&
    keys.every((key) => key === 'id' || key === 'method' || key === 'params')
  );
}

/**
 * Serves UI calls from `port` as the user, through the same dispatcher (C-04-01), with Tier H
 * operations turned into confirmation intents (C-04-12).
 */
export function serveUiPort(intents: Pick<ConfirmIntents, 'fromUi'>, port: UiPort): void {
  port.onMessage((message) => {
    if (!isUiRequest(message)) {
      const id =
        typeof message === 'object' && message !== null && 'id' in message
          ? ((message as { id?: unknown }).id as number | string | null)
          : null;
      port.postMessage({
        id: typeof id === 'number' || typeof id === 'string' ? id : null,
        error: new CoreError('E_USAGE', 'a UI call is { id, method, params }', []).toData(),
      });
      return;
    }
    intents.fromUi(message.method, message.params).then(
      (result) => port.postMessage({ id: message.id, result }),
      (error: unknown) =>
        port.postMessage({
          id: message.id,
          error: isCoreError(error)
            ? error.toData()
            : new CoreError('E_INTERNAL', `internal error in ${message.method}`, []).toData(),
        }),
    );
  });
}
