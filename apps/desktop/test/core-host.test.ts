import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { recordPathOf, silentLogger } from '@cc/core';
import { createProfileDir } from '@cc/test-kit';
import { describe, expect, it } from 'vitest';

import {
  runCoreHost,
  type CoreLike,
  type HostPort,
  type ParentPort,
  type StartCore,
  type StartCoreOptions,
} from '../src/core-host/host.js';
import { realCore } from '../src/core-host/real-core.js';
import type { HostToMain } from '../src/shared/protocol.js';
import { fakeChannel, settle } from './fakes.js';

class FakeParent extends EventEmitter implements ParentPort {
  readonly sent: HostToMain[] = [];
  postMessage(message: HostToMain): void {
    this.sent.push(message);
  }
  deliver(data: unknown, ports: HostPort[] = []): void {
    this.emit('message', { data, ports });
  }
}

/** A core with no handlers: it answers every UI call `E_NOT_FOUND`. */
const fakeCore: StartCore = () => {
  const core: CoreLike = {
    serveUi(port) {
      port.onMessage((message) => {
        const { id, method } = message as { id: number; method: string };
        port.postMessage({ id, error: { code: 'E_NOT_FOUND', message: `no ${method}`, help: [] } });
      });
    },
    stop: () => Promise.resolve(),
  };
  return Promise.resolve(core);
};

function host(startCore: StartCore = fakeCore) {
  const parent = new FakeParent();
  const exits: number[] = [];
  runCoreHost({ parentPort: parent, startCore, exit: (code) => exits.push(code) });
  return { parent, exits };
}

/** Waits for real I/O (the real core listens on a socket). */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('core host (the core utility process, 04 §3)', () => {
  it('starts the core on init, serves the UI port and says ready', async () => {
    const seen: Omit<StartCoreOptions, 'events'>[] = [];
    const startCore: StartCore = async (options) => {
      seen.push({ userData: options.userData, mode: options.mode });
      return fakeCore(options);
    };
    const { parent } = host(startCore);
    const { port1, port2 } = fakeChannel();
    const answers: unknown[] = [];
    port1.on('message', ({ data }: { data: unknown }) => answers.push(data));
    port1.start();

    parent.deliver({ type: 'init', userData: '/tmp/cc-test-a', mode: { kind: 'normal' } }, [port2]);
    await settle();
    expect(seen).toEqual([{ userData: '/tmp/cc-test-a', mode: { kind: 'normal' } }]);
    expect(parent.sent).toEqual([{ type: 'ready' }]);

    port1.postMessage({ id: 7, method: 'home.get', params: {} });
    await settle();
    expect(answers).toEqual([
      { id: 7, error: { code: 'E_NOT_FOUND', message: 'no home.get', help: [] } },
    ]);
  });

  it('forwards the core notifications and policy to main', async () => {
    const startCore: StartCore = async (options) => {
      options.events.setNotificationPolicy({
        timeZone: 'Asia/Kolkata',
        quietHours: [{ start: '23:30', end: '08:00' }],
        protectedBlocks: [],
      });
      options.events.notify({ id: 'n1', kind: 'escalation', title: 'E2 on A-0142' });
      return fakeCore(options);
    };
    const { parent } = host(startCore);
    parent.deliver({ type: 'init', userData: '/tmp/cc-test-b', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    await settle();
    expect(parent.sent.map((message) => message.type)).toEqual([
      'notification-policy',
      'notify',
      'ready',
    ]);
  });

  it('stops the core and exits on stop', async () => {
    let stopped = false;
    const startCore: StartCore = async (options) => ({
      ...(await fakeCore(options)),
      stop: async () => {
        stopped = true;
      },
    });
    const { parent, exits } = host(startCore);
    parent.deliver({ type: 'init', userData: '/tmp/cc-test-c', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    parent.deliver({ type: 'stop' });
    await settle();
    expect(stopped).toBe(true);
    expect(exits).toEqual([0]);
  });

  it('answers activity with what keeps the app busy; before init the app is idle', async () => {
    let busy: readonly string[] = ['1 meeting in progress'];
    const startCore: StartCore = async (options) => ({
      ...(await fakeCore(options)),
      busy: () => busy,
    });
    const { parent } = host(startCore);
    parent.deliver({ type: 'activity', id: 1 });
    await settle();
    const { port2 } = fakeChannel();
    parent.deliver({ type: 'init', userData: '/tmp/cc-test-b', mode: { kind: 'normal' } }, [port2]);
    parent.deliver({ type: 'activity', id: 2 });
    await settle();
    busy = [];
    parent.deliver({ type: 'activity', id: 3 });
    await settle();
    expect(parent.sent).toEqual([
      { type: 'activity', id: 1, busy: [] },
      { type: 'ready' },
      { type: 'activity', id: 2, busy: ['1 meeting in progress'] },
      { type: 'activity', id: 3, busy: [] },
    ]);
  });

  it('reports a core that fails to start, and exits non-zero', async () => {
    const { parent, exits } = host(() => Promise.reject(new Error('store is locked')));
    parent.deliver({ type: 'init', userData: '/tmp/cc-test-d', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    await settle();
    expect(parent.sent).toEqual([{ type: 'fatal', message: 'store is locked' }]);
    expect(exits).toEqual([1]);
  });

  it('ignores malformed messages and a second init', async () => {
    let starts = 0;
    const { parent } = host(async (options) => {
      starts += 1;
      return fakeCore(options);
    });
    parent.deliver({ type: 'init', userData: 42 });
    parent.deliver({ type: 'init', userData: '/x', mode: { kind: 'weird' } }, [
      fakeChannel().port2,
    ]);
    parent.deliver({ type: 'init', userData: '/x', mode: { kind: 'normal' } });
    parent.deliver({ type: 'init', userData: '/x', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    parent.deliver({ type: 'init', userData: '/y', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    await settle();
    expect(starts).toBe(1);
  });

  it('runs the real @cc/core: UI calls reach its dispatcher, stop removes its endpoint', async () => {
    const profile = createProfileDir();
    try {
      const { parent, exits } = host(realCore({ tmpRoot: profile.path, logger: silentLogger }));
      const { port1, port2 } = fakeChannel();
      const answers: unknown[] = [];
      port1.on('message', ({ data }: { data: unknown }) => answers.push(data));
      port1.start();
      parent.deliver({ type: 'init', userData: profile.path, mode: { kind: 'normal' } }, [port2]);
      await waitFor(() => parent.sent.length > 0);

      expect(parent.sent[0]).toMatchObject({
        type: 'ready',
        endpoint: { transport: expect.any(String), path: expect.any(String) },
      });
      expect(fs.existsSync(recordPathOf(profile.path))).toBe(true);

      // The core's own handler answers from the profile's store, which has no workstreams yet.
      port1.postMessage({ id: 1, method: 'workstreams.list', params: {} });
      await waitFor(() => answers.length > 0);
      expect(answers).toEqual([{ id: 1, result: { workstreams: [], total: 0 } }]);

      // 04 §10 rule 2: the real core says whether the app is idle (no meeting in progress).
      parent.deliver({ type: 'activity', id: 4 });
      await waitFor(() => parent.sent.length > 1);
      expect(parent.sent[1]).toEqual({ type: 'activity', id: 4, busy: [] });

      parent.deliver({ type: 'stop' });
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
      expect(fs.existsSync(recordPathOf(profile.path))).toBe(false);
    } finally {
      profile.cleanup();
    }
  });
});
