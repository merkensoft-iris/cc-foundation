import fs from 'node:fs';
import path from 'node:path';

import { createProfileDir, FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { connectLocalApi } from '../src/client.js';
import {
  assertSocketPathFits,
  discoverEndpoint,
  maxSocketPathBytes,
  planEndpoint,
  recordPathOf,
  runDirOf,
} from '../src/endpoint.js';
import { startCore } from '../src/service.js';
import { makeStaleSocket, rejection, startTestCore, type TestCore } from './helpers.js';

const posix = process.platform !== 'win32';
const mode = (file: string) => fs.lstatSync(file).mode & 0o777;

/** A sub-directory name that pushes `<profile>/run/cc.sock` past the byte limit. */
const LONG =
  'a-profile-directory-name-long-enough-to-push-the-socket-path-past-the-limit-of-adr-0002';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

async function start(options: Parameters<typeof startTestCore>[0] = {}): Promise<TestCore> {
  const test = await startTestCore(options);
  open.push(test);
  return test;
}

describe('endpoint planning (ADR 0002 decisions 3, 4 and 6)', () => {
  it('uses sizeof(sun_path) - 1 bytes: 107 on Linux, 103 on macOS', () => {
    expect(maxSocketPathBytes('linux')).toBe(107);
    expect(maxSocketPathBytes('darwin')).toBe(103);
    expect(() => assertSocketPathFits(`/${'x'.repeat(106)}`, 'linux')).not.toThrow();
    expect(() => assertSocketPathFits(`/${'x'.repeat(107)}`, 'linux')).toThrow(/108 bytes/);
    // Multi-byte characters count in bytes, not characters.
    expect(() => assertSocketPathFits(`/${'é'.repeat(54)}`, 'linux')).toThrow(/109 bytes/);
  });

  it('prefers <userData>/run/cc.sock and falls back only when it is too long', () => {
    expect(planEndpoint({ userData: '/tmp/cc-test-x', platform: 'linux' })).toEqual({
      transport: 'unix',
      fallback: false,
      path: '/tmp/cc-test-x/run/cc.sock',
    });
    const long = planEndpoint({ userData: `/tmp/${LONG}`, platform: 'darwin' });
    expect(long).toMatchObject({ transport: 'unix', fallback: true, maxBytes: 103 });
  });

  it('gives the Windows pipe name an unguessable part (C-08-05)', () => {
    const env = { USERNAME: 'sample user' };
    const first = planEndpoint({ userData: 'C:\\p', platform: 'win32', env });
    const second = planEndpoint({ userData: 'C:\\p', platform: 'win32', env });
    if (first.transport !== 'pipe' || second.transport !== 'pipe') throw new Error('not a pipe');
    expect(first.path).toMatch(/^\\\\\.\\pipe\\command-center-sample_user-[0-9a-f]{32}$/);
    expect(first.path).not.toBe(second.path);
  });
});

describe.runIf(posix)('the core endpoint on a UNIX socket (04 §4.1 rule 1, ADR 0002)', () => {
  it('listens at <userData>/run/cc.sock (0600, directory 0700) and always writes the record', async () => {
    const { core } = await start();
    const socketPath = path.join(runDirOf(core.userData), 'cc.sock');
    expect(core.endpoint).toMatchObject({
      v: 1,
      transport: 'unix',
      path: socketPath,
      pid: process.pid,
    });
    expect(core.endpoint.fallbackDir).toBeUndefined();
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(mode(socketPath)).toBe(0o600);
    expect(mode(runDirOf(core.userData))).toBe(0o700);
    const recordFile = recordPathOf(core.userData);
    expect(mode(recordFile)).toBe(0o600);
    const text = fs.readFileSync(recordFile, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual(core.endpoint);
    expect(discoverEndpoint({ userData: core.userData })).toMatchObject({
      path: socketPath,
      via: 'record',
    });
  });

  it('falls back to a mkdtemp directory under /tmp when the preferred path is too long', async () => {
    const test = await start({ subdir: LONG });
    const { core } = test;
    expect(Buffer.byteLength(path.join(core.userData, 'run/cc.sock'))).toBeGreaterThan(107);
    const { fallbackDir } = core.endpoint;
    expect(fallbackDir).toMatch(
      new RegExp(`^/tmp/command-center-${process.getuid?.()}-[A-Za-z0-9]{6}$`),
    );
    expect(core.endpoint.path).toBe(`${fallbackDir}/cc.sock`);
    expect(mode(fallbackDir ?? '')).toBe(0o700);
    expect(mode(core.endpoint.path)).toBe(0o600);
    // A client finds it only through the record, and verifies it before sending a token.
    const client = await test.connect();
    expect(client.principal.name).toBe('cli-default');
    client.close();
    await core.stop();
    expect(fs.existsSync(fallbackDir ?? '')).toBe(false);
    expect(fs.existsSync(recordPathOf(core.userData))).toBe(false);
  });

  it('unlinks a stale socket left by a crash, and starts', async () => {
    const profile = createProfileDir();
    try {
      fs.mkdirSync(runDirOf(profile.path), { mode: 0o700 });
      const socketPath = path.join(runDirOf(profile.path), 'cc.sock');
      makeStaleSocket(socketPath);
      const core = await startCore({ userData: profile.path });
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      const client = await connectLocalApi({ userData: profile.path, principal: 'cli-default' });
      client.close();
      await core.stop();
    } finally {
      profile.cleanup();
    }
  });

  it('removes the fallback directory of a crashed run, found through the old record', async () => {
    const profile = createProfileDir();
    const userData = path.join(profile.path, LONG);
    try {
      fs.mkdirSync(runDirOf(userData), { recursive: true, mode: 0o700 });
      const oldDir = fs.mkdtempSync('/tmp/command-center-');
      makeStaleSocket(path.join(oldDir, 'cc.sock'));
      fs.writeFileSync(
        recordPathOf(userData),
        `${JSON.stringify({ v: 1, transport: 'unix', path: `${oldDir}/cc.sock`, fallbackDir: oldDir, pid: 1, startedAt: '2026-11-04T00:00:00.000Z' })}\n`,
        { mode: 0o600 },
      );
      const core = await startCore({ userData });
      expect(fs.existsSync(oldDir)).toBe(false);
      expect(core.endpoint.fallbackDir).not.toBe(oldDir);
      await core.stop();
    } finally {
      profile.cleanup();
    }
  });

  it('refuses a second instance on the same profile with E_ALREADY_RUNNING; the first stays reachable', async () => {
    const test = await start();
    const error = await rejection(startCore({ userData: test.core.userData }));
    expect(error.code).toBe('E_ALREADY_RUNNING');
    const client = await test.connect();
    expect(client.principal.name).toBe('cli-default');
  });

  it('never deletes a non-socket at the socket path: E_ENDPOINT_UNSAFE', async () => {
    const profile = createProfileDir();
    try {
      fs.mkdirSync(runDirOf(profile.path), { mode: 0o700 });
      const planted = path.join(runDirOf(profile.path), 'cc.sock');
      fs.writeFileSync(planted, 'not a socket');
      const error = await rejection(startCore({ userData: profile.path }));
      expect(error.code).toBe('E_ENDPOINT_UNSAFE');
      expect(fs.readFileSync(planted, 'utf8')).toBe('not a socket');
    } finally {
      profile.cleanup();
    }
  });

  it('narrows a wider run directory to 0700 on start', async () => {
    const profile = createProfileDir();
    try {
      fs.mkdirSync(runDirOf(profile.path), { mode: 0o755 });
      fs.chmodSync(runDirOf(profile.path), 0o755);
      const core = await startCore({ userData: profile.path });
      expect(mode(runDirOf(profile.path))).toBe(0o700);
      await core.stop();
    } finally {
      profile.cleanup();
    }
  });

  it('the client verifies before it sends a token: unsafe record, run directory or fallback directory', async () => {
    const test = await start({ subdir: LONG });
    const { userData } = test.core;
    const recordFile = recordPathOf(userData);

    fs.chmodSync(recordFile, 0o644);
    expect((await rejection(test.connect())).code).toBe('E_ENDPOINT_UNSAFE');
    fs.chmodSync(recordFile, 0o600);

    fs.chmodSync(runDirOf(userData), 0o755);
    expect((await rejection(test.connect())).code).toBe('E_ENDPOINT_UNSAFE');
    fs.chmodSync(runDirOf(userData), 0o700);

    const fallbackDir = test.core.endpoint.fallbackDir ?? '';
    fs.chmodSync(fallbackDir, 0o755);
    expect((await rejection(test.connect())).code).toBe('E_ENDPOINT_UNSAFE');
    fs.chmodSync(fallbackDir, 0o700);

    // A record that points somewhere else is refused too.
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      recordFile,
      `${JSON.stringify({ ...record, path: '/tmp/elsewhere/cc.sock' })}\n`,
    );
    expect((await rejection(test.connect())).code).toBe('E_ENDPOINT_UNSAFE');
    fs.writeFileSync(recordFile, `${JSON.stringify(record)}\n`);

    const client = await test.connect();
    expect(client.principal.name).toBe('cli-default');
  });

  it('a client without a record or socket gets E_APP_NOT_RUNNING', async () => {
    const profile = createProfileDir();
    try {
      const error = await rejection(
        connectLocalApi({
          userData: profile.path,
          principal: 'cli-default',
          token: 'a'.repeat(64),
        }),
      );
      expect(error.code).toBe('E_APP_NOT_RUNNING');
      expect(error.help).toContain('Open Command Center, then retry');
      const long = path.join(profile.path, LONG);
      expect(() => discoverEndpoint({ userData: long })).toThrow(/no endpoint record/);
    } finally {
      profile.cleanup();
    }
  });

  it('a profile the app never ran in (no token file either) gets E_APP_NOT_RUNNING, not E_FORBIDDEN', async () => {
    const profile = createProfileDir();
    try {
      const error = await rejection(
        connectLocalApi({ userData: profile.path, principal: 'cli-default' }),
      );
      expect(error.code).toBe('E_APP_NOT_RUNNING');
    } finally {
      profile.cleanup();
    }
  });
});

describe.runIf(posix)('the endpoint watchdog (ADR 0002 decision 4)', () => {
  it('rebinds a socket deleted by a cleaner, on the 60 s schedule of the injected clock', async () => {
    const clock = new FakeTimerClock('2026-11-04T09:00:00Z');
    const test = await start({ clock });
    const { core } = test;
    expect(core.scheduler.status('endpoint-watchdog')?.nextDueAt).toEqual(
      new Date('2026-11-04T09:01:00Z'),
    );
    const before = await test.connect();
    fs.unlinkSync(core.endpoint.path);
    expect((await rejection(test.connect())).code).toBe('E_APP_NOT_RUNNING');
    await clock.advance(60_000);
    expect(core.scheduler.status('endpoint-watchdog')).toMatchObject({ runs: 1, failures: 0 });
    expect(fs.lstatSync(core.endpoint.path).isSocket()).toBe(true);
    expect(mode(core.endpoint.path)).toBe(0o600);
    const after = await test.connect();
    expect(after.principal.name).toBe('cli-default');
    // Connections made before the rebind keep working.
    expect(await before.call('items.list', {})).toEqual({ items: [], total: 0 });
  });

  it('makes a new fallback directory and rewrites the record when the directory is gone', async () => {
    const test = await start({ subdir: LONG });
    const { core } = test;
    const oldDir = core.endpoint.fallbackDir ?? '';
    fs.rmSync(oldDir, { recursive: true });
    expect(await core.checkEndpoint()).toBe('rebound in a new fallback directory');
    expect(core.endpoint.fallbackDir).not.toBe(oldDir);
    expect(JSON.parse(fs.readFileSync(recordPathOf(core.userData), 'utf8'))).toEqual(core.endpoint);
    const client = await test.connect();
    expect(client.principal.name).toBe('cli-default');
  });

  it('rewrites a deleted record, and leaves a socket path that something else took over', async () => {
    const test = await start();
    const { core } = test;
    expect(await core.checkEndpoint()).toBe('ok');
    fs.rmSync(recordPathOf(core.userData));
    expect(await core.checkEndpoint()).toBe('record rewritten');
    expect(fs.existsSync(recordPathOf(core.userData))).toBe(true);

    fs.unlinkSync(core.endpoint.path);
    fs.writeFileSync(core.endpoint.path, 'someone else');
    expect(await core.checkEndpoint()).toBe('replaced by another file; left alone');
    expect(fs.readFileSync(core.endpoint.path, 'utf8')).toBe('someone else');
    fs.rmSync(core.endpoint.path);
  });
});
