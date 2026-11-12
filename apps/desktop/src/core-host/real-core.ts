/**
 * The core the shell runs: `@cc/core`'s `startCore` (09 P1-04) behind the host's `StartCore`
 * boundary. The core serves the local API on `<userData>/run` (ADR 0002) and UI calls from
 * the port main transferred, as the user (04 §4.3 rule 1).
 *
 * The notification policy (02 §10 rule 4) comes from the onboarding answers (P1-12): quiet
 * hours and the hard protected blocks, sent to main at start once onboarding is committed and
 * again after the commit. The start mode and the notification producers are not yet read by the
 * core: developer mode in core approvals and the producers arrive with the work that owns them.
 */
import { startCore, stderrLogger, systemClock, type CoreOptions } from '@cc/core';
import type { OnboardingProfile } from '@cc/schemas';

import type { NotificationPolicy } from '../shared/protocol.js';
import type { CoreLike, StartCore } from './host.js';

/** The workspace's quiet hours and protected blocks, as main's notification centre reads them. */
export function notificationPolicy(profile: OnboardingProfile): NotificationPolicy {
  return {
    timeZone: profile.workspace.timeZone,
    quietHours: profile.workspace.quietHours,
    protectedBlocks: profile.workspace.protectedBlocks,
  };
}

export function realCore(overrides: Omit<CoreOptions, 'userData'> = {}): StartCore {
  return async ({ userData, events }): Promise<CoreLike> => {
    const core = await startCore({
      logger: stderrLogger(systemClock),
      onOnboardingCommitted: (profile) => events.setNotificationPolicy(notificationPolicy(profile)),
      ...overrides,
      userData,
    });
    const committed = core.store.read((tx) => tx.list('onboarding', { limit: 1 })[0]);
    if (committed?.committedAt !== undefined) {
      events.setNotificationPolicy(notificationPolicy(committed.profile));
    }
    return core;
  };
}
