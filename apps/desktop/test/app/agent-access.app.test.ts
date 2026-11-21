/**
 * P1-15, Remove access in the app (07 §5 rule 1; 04 §4.3 rule 4, C-04-12): removing an agent's
 * access is a Tier H operation. Settings → Agent access explains it, then main's confirm window
 * shows the core's preview, and only Confirm there removes the access. The window is driven
 * like any window: there is no test hook (AGENTS rule 4).
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProfileDir, seedScenario, type ProfileDir } from '@cc/test-kit';

import { clickClosing, flashSays, launchApp, windowOpenedBy, type RunningApp } from './electron.ts';

let profile: ProfileDir;
let running: RunningApp;

/** The agent the scenario connects; its key file goes when its access is removed. */
const AGENT = 'cli-default';

function tokenFile(): string {
  return path.join(profile.path, 'run', 'tokens', `${AGENT}.token`);
}

beforeAll(async () => {
  profile = createProfileDir();
  const s = await seedScenario({ profileDir: profile.path });
  await s.stop();
  running = await launchApp(profile.path);
}, 120_000);

afterAll(async () => {
  await running?.close();
  profile?.cleanup();
});

describe('P1-15 Remove access is confirmed in the shell', { timeout: 120_000 }, () => {
  it('C-04-12 Cancel in the confirm window changes nothing; Confirm there removes the access and its key', async () => {
    await running.byTest('nav-settings').click();
    await running.byTest('overview').waitFor();
    await running.byTest('tab-agents').click();
    await running.byTest(`principal-${AGENT}`).waitFor();
    await expect.poll(() => fs.existsSync(tokenFile()), { timeout: 60_000 }).toBe(true);

    await running.byTest(`revoke-${AGENT}`).click();
    let prompt = await windowOpenedBy(running, () => running.byTest(`revoke-now-${AGENT}`).click());
    await running.byTest(`revoke-in-window-${AGENT}`).waitFor();
    await expect(prompt.locator('[data-test="confirm-title"]').textContent()).resolves.toBe(
      'Remove access',
    );
    await expect(prompt.locator('[data-test="confirm-preview"]').textContent()).resolves.toContain(
      `Remove access for "${AGENT}"`,
    );
    await clickClosing(prompt, 'confirm-cancel');
    await flashSays(running, /was not confirmed, so nothing changed/);
    await running.byTest(`principal-${AGENT}`).waitFor();
    expect(fs.existsSync(tokenFile())).toBe(true);

    await running.byTest(`revoke-${AGENT}`).click();
    prompt = await windowOpenedBy(running, () => running.byTest(`revoke-now-${AGENT}`).click());
    await clickClosing(prompt, 'confirm-approve');
    await flashSays(running, `${AGENT} can no longer reach Command Center`);
    await expect.poll(() => running.byTest(`principal-${AGENT}`).count()).toBe(0);
    expect(fs.existsSync(tokenFile())).toBe(false);
  });
});
