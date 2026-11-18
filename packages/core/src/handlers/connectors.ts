/**
 * The connector and confirmation methods the MCP tools call (07 §7, 09 P1-13):
 * `connectors.actions` and `connectors.invoke` (`cc_connector_actions`, `cc_connector_invoke`),
 * and `confirmations.get` and `confirmations.wait` (`cc_confirmation_status`).
 *
 * Phase 1 installs no connector: the Connector Host and the installed manifests arrive with
 * P2-02 (05). So `connectors.actions` returns the definitive empty list, and
 * `connectors.invoke` finds no action to run (`E_NOT_FOUND`), whatever the binding. Nothing
 * creates a confirmation in phase 1 either (04 §7.3; the Policy Engine is P2-01), but the
 * confirmation methods read the store's `confirmations` table, so they serve the first ones
 * unchanged. Approving and denying stay human-only (04 §4.3): they are not methods here, and
 * the dispatcher refuses them by name.
 */
import { ConfirmationRequest, methods } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { Clock } from '../clock.js';
import type { Dispatcher } from '../dispatch.js';
import { CoreError } from '../errors.js';

/** Why no connector action is listed or run in this build. */
export const NO_CONNECTORS_HELP =
  'No connector is installed until phase 2 (P2-02), so there is no connector action yet';

/** How often `confirmations.wait` looks at the request again. */
export const WAIT_POLL_MS = 1000;

function readConfirmation(store: Store, clock: Clock, id: string): ConfirmationRequest {
  const row = store.read((tx) => tx.get('confirmations', id));
  if (row === undefined) {
    throw new CoreError('E_NOT_FOUND', `no confirmation ${id}`, [
      'A confirmation ID comes from a pending_confirmation result; none is created until phase 2',
    ]);
  }
  const parsed = ConfirmationRequest.safeParse({ ...row.doc, id: row.id });
  if (!parsed.success) {
    throw new CoreError('E_INTERNAL', `confirmation ${id} is not a valid request`, [
      'The core logged the failure; retry, and report it if it repeats',
    ]);
  }
  const request = parsed.data;
  // A pending request past its expiry reads as expired (04 §7.3: default 24 h).
  if (request.status === 'pending' && Date.parse(request.expiresAt) <= clock.now().getTime()) {
    return { ...request, status: 'expired' };
  }
  return request;
}

export function registerConnectorHandlers(
  dispatcher: Dispatcher,
  store: Store,
  clock: Clock,
): void {
  dispatcher.register(methods.connectorsActions, () => ({ actions: [], total: 0 }));

  dispatcher.register(methods.connectorsInvoke, (params) => {
    throw new CoreError(
      'E_NOT_FOUND',
      `no connector action ${params.action} on binding ${params.binding}`,
      [NO_CONNECTORS_HELP],
    );
  });

  dispatcher.register(methods.confirmationsGet, (params) => ({
    confirmation: readConfirmation(store, clock, params.id),
  }));

  dispatcher.register(methods.confirmationsWait, async (params) => {
    // Waits count the clock's timer ticks rather than reading its time, so a test clock that
    // stands still still times out.
    let left = params.timeoutSeconds * 1000;
    let confirmation = readConfirmation(store, clock, params.id);
    while (confirmation.status === 'pending') {
      if (left <= 0) return { confirmation, timedOut: true };
      const step = Math.min(WAIT_POLL_MS, left);
      await new Promise<void>((resolve) => {
        clock.setTimeout(resolve, step);
      });
      left -= step;
      confirmation = readConfirmation(store, clock, params.id);
    }
    return { confirmation, timedOut: false };
  });
}
