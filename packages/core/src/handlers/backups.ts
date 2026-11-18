/**
 * The P1-17 methods of `backups.*` (04 §4.1, §9.1): status and history for every caller with
 * `read`; running a backup, running the restore test and restoring only from the app UI
 * (04 §4.3, C-04-10). The dispatcher refuses the human-only ones to every principal with
 * `E_HUMAN_REQUIRED` before they reach these handlers. The S1 answers (`backups.destination`,
 * `backups.passphrase`) are in `onboarding.ts`.
 */
import { methods } from '@cc/schemas';

import type { Backups } from '../backups/engine.js';
import type { Dispatcher } from '../dispatch.js';

export function registerBackupHandlers(dispatcher: Dispatcher, backups: Backups): void {
  dispatcher.register(methods.backupsStatus, () => backups.status());

  dispatcher.register(methods.backupsList, (params) => backups.list(params.limit));

  dispatcher.register(methods.backupsRun, async (params) => {
    const backup = await backups.run(params.trigger ?? 'manual');
    return { backup, status: backups.status() };
  });

  dispatcher.register(methods.backupsTest, async () => {
    const test = await backups.test();
    return { test, status: backups.status() };
  });

  dispatcher.register(methods.backupsRestore, async (params) => {
    const result = await backups.restore(params.id);
    return { status: 'ok' as const, ...result };
  });
}
