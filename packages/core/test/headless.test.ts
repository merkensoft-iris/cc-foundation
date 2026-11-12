import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { createProfileDir, startFixtureServer } from '@cc/test-kit';
import { describe, expect, it } from 'vitest';

import { connectLocalApi } from '../src/client.js';
import { recordPathOf } from '../src/endpoint.js';
import { assertHeadlessAllowed, startHeadless } from '../src/headless.js';
import { headlessMainPath, rejection, seedWorkspace, sentMessage } from './helpers.js';
import { listeningPortsByTool } from './tcp-listeners.js';

interface Ready {
  ready: true;
  pid: number;
  endpoint: { path: string; transport: string };
}

function waitReady(child: ChildProcess): Promise<Ready> {
  return new Promise((resolve, reject) => {
    if (child.stdout === null) return reject(new Error('no stdout'));
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    lines.once('line', (line) => resolve(JSON.parse(line) as Ready));
    child.once('exit', (code) => reject(new Error(`headless core exited ${code}: ${stderr}`)));
  });
}

/** The built headless runner as a child, with an IPC channel for the `"stop"` message. */
function spawnHeadless(profileDir: string): ChildProcess {
  return spawn(process.execPath, [headlessMainPath(), '--profile-dir', profileDir], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

describe('headless mode (04 §3 rule 2, D7)', () => {
  it('refuses to start when NODE_ENV=production', async () => {
    expect(() => assertHeadlessAllowed({ NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
    const profile = createProfileDir();
    try {
      const error = await rejection(
        startHeadless({ profileDir: profile.path, env: { NODE_ENV: 'production' } }),
      );
      expect(error.code).toBe('E_USAGE');
      expect(fs.readdirSync(profile.path)).toEqual([]);
    } finally {
      profile.cleanup();
    }
  });

  it('serves the local API and items.* from the profile directory’s own workspace store', async () => {
    const profile = createProfileDir();
    try {
      const core = await startHeadless({ profileDir: profile.path, env: {} });
      expect(core.store.path).toBe(path.join(profile.path, 'workspace.db'));
      seedWorkspace(core.store);
      const client = await connectLocalApi({ userData: profile.path, principal: 'cli-default' });
      expect(client.principal.name).toBe('cli-default');
      const claimed = await client.call<{ status: string; item: { lifecycle: string } }>(
        'items.claim',
        { ref: 'A-0142', evidence: [sentMessage()] },
      );
      expect(claimed).toMatchObject({ status: 'ok', item: { lifecycle: 'claimed_done' } });
      client.close();
      await core.stop();
    } finally {
      profile.cleanup();
    }
  });

  it('the TCP listener check finds a listening port when there is one', async () => {
    const server = await startFixtureServer((_request, response) => response.end());
    try {
      const port = Number(new URL(server.url).port);
      const found = listeningPortsByTool(process.pid);
      expect(Object.keys(found).length).toBeGreaterThan(0);
      for (const [tool, ports] of Object.entries(found)) expect(ports, tool).toContain(port);
    } finally {
      await server.close();
    }
  });

  it('AC-04-08 C-04-04 the headless core owns no listening TCP socket; it serves the local API over its UNIX socket or pipe only', async () => {
    const profile = createProfileDir();
    const child = spawnHeadless(profile.path);
    try {
      const ready = await waitReady(child);
      expect(ready.pid).toBe(child.pid);
      // It is serving: a client authenticates through the record.
      const client = await connectLocalApi({ userData: profile.path, principal: 'cli-default' });
      expect(client.principal.name).toBe('cli-default');

      const found = listeningPortsByTool(ready.pid);
      expect(Object.keys(found).length).toBeGreaterThan(0);
      for (const [tool, ports] of Object.entries(found)) expect(ports, tool).toEqual([]);
      client.close();

      // Graceful stop, on every platform, removes the socket and the record.
      child.send('stop');
      expect(await waitExit(child)).toBe(0);
      expect(fs.existsSync(recordPathOf(profile.path))).toBe(false);
      if (ready.endpoint.transport === 'unix')
        expect(fs.existsSync(ready.endpoint.path)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      profile.cleanup();
    }
  });

  // Windows has no catchable SIGTERM from another process: kill() there terminates at once,
  // so the signal path is checked on POSIX and the IPC stop above covers every platform.
  it.runIf(process.platform !== 'win32')(
    'stops gracefully on SIGTERM and SIGINT (POSIX signals)',
    async () => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const profile = createProfileDir();
        const child = spawnHeadless(profile.path);
        try {
          const ready = await waitReady(child);
          child.kill(signal);
          expect(await waitExit(child), signal).toBe(0);
          expect(fs.existsSync(recordPathOf(profile.path))).toBe(false);
          expect(fs.existsSync(ready.endpoint.path)).toBe(false);
        } finally {
          if (child.exitCode === null) child.kill('SIGKILL');
          profile.cleanup();
        }
      }
    },
  );
});
