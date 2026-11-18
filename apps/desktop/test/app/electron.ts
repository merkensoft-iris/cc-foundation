/**
 * The built desktop app under Playwright (08 §8 item 4; 09 P1-15): each test starts Electron on
 * its own profile directory, as `pnpm dev` does, and drives the renderer the user sees. The app
 * runs unchanged: its own core in a `utilityProcess`, its hardening, its single-instance lock and
 * its system clock. Nothing here reaches past the UI: human-only operations happen only by
 * clicking the screens (04 §4.3).
 *
 * A seeded profile comes from `seedScenario` (the `cc:seed` seeder), stopped before the app
 * opens it, so the store has one writer at a time. The scenario's own clock is fake; the app's
 * is not, so these tests open records by ref and deep link, never by "today".
 *
 * On Linux the app needs a display and Chromium's sandbox: CI runs these under `xvfb-run` with
 * unprivileged user namespaces allowed, as its engine-template job does.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The Electron binary of @cc/desktop's devDependency (downloaded on first use). */
function electronBinary(): string {
  return createRequire(path.join(desktop, 'package.json'))('electron') as string;
}

export interface RunningApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** The element with `data-test="<id>"`. */
  byTest(id: string): Locator;
  /** Closes the app and waits for it to exit. */
  close(): Promise<void>;
}

/**
 * Starts the built app on `profileDir`; `link` is a `commandcenter://` deep link it opens with,
 * as Windows and Linux pass one in argv (04 §3).
 */
export async function launchApp(profileDir: string, link?: string): Promise<RunningApp> {
  const options = {
    executablePath: electronBinary(),
    args: [
      path.join(desktop, 'dist', 'main', 'index.js'),
      '--profile-dir',
      profileDir,
      ...(link === undefined ? [] : [link]),
    ],
    cwd: desktop,
    // Playwright turns Chromium's sandbox off on Linux unless asked; the app keeps it on.
    chromiumSandbox: true,
    timeout: 60_000,
  };
  let app: ElectronApplication;
  try {
    app = await _electron.launch(options);
  } catch (error) {
    // The first start of a freshly downloaded Electron on a CI runner (Windows above all) can
    // miss Playwright's attach; Playwright has killed that process, so start once more.
    if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    app = await _electron.launch(options);
  }
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const byTest = (id: string) => page.locator(`[data-test="${id}"]`);
  return {
    app,
    page,
    byTest,
    async close() {
      await app.close();
    },
  };
}

/** The status line an action leaves (`flash`), once it says `text`. */
export async function flashSays(running: RunningApp, text: string | RegExp): Promise<void> {
  await running.byTest('flash').filter({ hasText: text }).waitFor();
}
