/**
 * @cc/desktop main process entry (04 §3): windows, tray, deep links, notifications and the
 * core's supervision. `electron dist/main/index.js [--profile-dir <dir>]`.
 *
 * The flow is `shell.ts`; this file only joins it to Electron.
 */
import { app } from 'electron';

import { createElectronPlatform } from './electron-platform.js';
import { startShell } from './shell.js';

export const PROCESS = 'main';

function fail(error: unknown): void {
  process.stderr.write(`Command Center failed to start: ${String(error)}\n`);
  app.exit(1);
}

try {
  startShell(createElectronPlatform(process.argv)).catch(fail);
} catch (error) {
  fail(error);
}
