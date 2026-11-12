import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkElectron,
  checkOptionalCli,
  checkSocketPaths,
  parseArgs,
  parseVersion,
  satisfiesPin,
  socketPathLimit,
  summarize,
} from '../doctor.ts';

describe('cc:doctor', () => {
  it('accepts the pinned version and newer releases of the same major only', () => {
    const pin = parseVersion('26.13.0');
    expect(pin).toEqual([26, 13, 0]);
    if (pin === undefined) return;
    expect(satisfiesPin([26, 13, 0], pin)).toBe(true);
    expect(satisfiesPin([26, 14, 1], pin)).toBe(true);
    expect(satisfiesPin([26, 12, 9], pin)).toBe(false);
    expect(satisfiesPin([27, 0, 0], pin)).toBe(false);
    expect(parseVersion('v26.13.0')).toEqual([26, 13, 0]);
    expect(parseVersion('next')).toBeUndefined();
  });

  it('a missing optional AI CLI warns and does not fail', () => {
    const missing = checkOptionalCli('codex', () => undefined);
    expect(missing.status).toBe('warn');
    const present = checkOptionalCli('claude', (command, args) =>
      command === 'claude' && args[0] === '--version' ? '2.1.318 (Claude Code)' : undefined,
    );
    expect(present).toEqual({ name: 'claude', status: 'ok', detail: '2.1.318 (Claude Code)' });
    expect(summarize([missing, present]).exitCode).toBe(0);
    expect(summarize([missing, { name: 'node', status: 'fail', detail: '' }]).exitCode).toBe(1);
  });

  it('warns when a socket path would exceed the UNIX limit: 104 bytes on macOS, 108 on Linux', () => {
    expect(socketPathLimit('darwin')).toBe(104);
    expect(socketPathLimit('linux')).toBe(108);
    // '/run/cc.sock' adds 12 bytes to the profile directory.
    const at = (length: number) => [{ label: 'p', dir: `/${'x'.repeat(length - 1)}` }];
    expect(checkSocketPaths(at(92), 'darwin').status).toBe('ok');
    expect(checkSocketPaths(at(93), 'darwin').status).toBe('warn');
    expect(checkSocketPaths(at(96), 'linux').status).toBe('ok');
    expect(checkSocketPaths(at(97), 'linux').detail).toBe(
      'over the 108-byte UNIX limit: p 109 bytes; use a shorter --profile-dir',
    );
    expect(checkSocketPaths(at(500), 'win32').status).toBe('ok');
  });

  it('rejects unknown arguments', () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(['--profile-dir', '/tmp/p'])).toEqual({ profileDir: '/tmp/p' });
    expect(parseArgs(['--profile-dir'])).toBeUndefined();
    expect(parseArgs(['--fix'])).toBeUndefined();
  });

  it('checks the Electron binary without loading the electron package, which would download it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-doctor-'));
    try {
      const desktop = join(root, 'apps', 'desktop');
      const electron = join(desktop, 'node_modules', 'electron');
      mkdirSync(electron, { recursive: true });
      writeFileSync(join(desktop, 'package.json'), JSON.stringify({ name: '@cc/desktop' }));
      writeFileSync(
        join(electron, 'package.json'),
        JSON.stringify({ name: 'electron', main: 'index.js' }),
      );
      // Loading this package would be a download; the check must never do it.
      writeFileSync(join(electron, 'index.js'), "throw new Error('electron package was loaded');");
      const runner = () => 'ok';

      const missing = checkElectron(root, runner);
      expect(missing.status).toBe('warn');
      expect(missing.detail).toMatch(/not downloaded/);

      writeFileSync(join(electron, 'path.txt'), 'electron');
      mkdirSync(join(electron, 'dist'));
      writeFileSync(join(electron, 'dist', 'electron'), '');
      expect(checkElectron(root, runner)).toMatchObject({
        status: 'ok',
        detail: 'no native modules yet',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
