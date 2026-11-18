/**
 * P1-15, backups in the app (04 §9.1; 08 §8 item 4): the human-only restore and the "last good
 * backup" status arrive with P1-17. This run holds their place in the app suite; P1-17 replaces
 * the pending check with the Playwright steps, on a profile `seedScenario` prepares with a folder
 * destination, a passphrase and a corrupted newest archive.
 */
import { describe, it } from 'vitest';

describe('P1-15 backups in the app', () => {
  it.todo(
    'AC-04-11 Settings → Backups and Home show the last good backup when the newest archive fails its restore test, and restoring that previous archive in the app first backs up the current store (P1-17)',
  );
});
