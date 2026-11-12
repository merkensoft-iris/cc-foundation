/**
 * The core the shell runs: `@cc/core`'s `startCore` (09 P1-04) behind the host's `StartCore`
 * boundary. The core serves the local API on `<userData>/run` (ADR 0002) and UI calls from
 * the port main transferred, as the user (04 §4.3 rule 1).
 *
 * The start mode and the host events are not yet read by the core: developer mode in core
 * approvals, the notification producers and the workspace quiet-hours policy arrive with the
 * work that owns them (P1-07 to P1-12). Records are the core's default until the store
 * (P1-02) is wired into it.
 */
import { startCore, stderrLogger, systemClock, type CoreOptions } from '@cc/core';

import type { CoreLike, StartCore } from './host.js';

export function realCore(overrides: Omit<CoreOptions, 'userData'> = {}): StartCore {
  return async ({ userData }): Promise<CoreLike> =>
    startCore({ logger: stderrLogger(systemClock), ...overrides, userData });
}
