import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  CoreSupervisor,
  UiCallError,
  type CoreLauncher,
  type CoreProcess,
  type CoreState,
  type MainPort,
} from '../src/main/core-supervisor.js';
import type { HostToMain, MainToHost, StartMode } from '../src/shared/protocol.js';
import { fakeChannel, settle, timerClock, type FakePort } from './fakes.js';

class FakeCore extends EventEmitter implements CoreProcess {
  readonly received: { message: MainToHost; transfer: MainPort[] }[] = [];
  killed = false;
  port: FakePort | undefined;
  /** Answer UI calls on the transferred port: `{ echo: method }`, or an error for `fail.*`. */
  answering = true;

  postMessage(message: MainToHost, transfer: MainPort[] = []): void {
    this.received.push({ message, transfer });
    if (message.type === 'init') {
      this.port = transfer[0] as FakePort;
      this.port.on('message', ({ data }: { data: { id: number; method: string } }) => {
        if (!this.answering) return;
        this.port?.postMessage(
          data.method.startsWith('fail.')
            ? { id: data.id, error: { code: 'E_NOT_FOUND', message: 'no such', help: ['h'] } }
            : { id: data.id, result: { echo: data.method } },
        );
      });
      this.port.start();
    }
    if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0));
  }

  say(message: HostToMain | Record<string, unknown>): void {
    this.emit('message', message);
  }

  crash(code = 1): void {
    this.emit('exit', code);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 9));
    return true;
  }
}

const NORMAL: StartMode = { kind: 'normal' };

function harness(timing = {}) {
  const clock = timerClock('2026-11-13T05:30:00Z');
  const cores: FakeCore[] = [];
  const states: CoreState[] = [];
  const messages: HostToMain[] = [];
  const launcher: CoreLauncher = {
    fork: () => {
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    channel: fakeChannel,
  };
  const supervisor = new CoreSupervisor({
    launcher,
    userData: '/tmp/cc-test-profile',
    clock,
    timing,
    onStateChange: (state) => states.push(state),
    onHostMessage: (message) => messages.push(message),
  });
  return { clock, cores, states, messages, supervisor, latest: () => cores[cores.length - 1] };
}

async function rejection(promise: Promise<unknown>): Promise<UiCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiCallError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('core supervision (04 §3)', () => {
  it('starts the core in a utility process with <userData>, the mode and the UI port', () => {
    const { cores, supervisor } = harness();
    const mode: StartMode = { kind: 'developer', reasons: ['build out of date'] };
    supervisor.start(mode);
    expect(cores).toHaveLength(1);
    const [init] = cores[0]?.received ?? [];
    expect(init?.message).toEqual({ type: 'init', userData: '/tmp/cc-test-profile', mode });
    expect(init?.transfer).toHaveLength(1);
    expect(supervisor.state).toBe('starting');
  });

  it('queues UI calls until the core is ready, then answers them in order', async () => {
    const { supervisor, latest, messages } = harness();
    supervisor.start(NORMAL);
    const first = supervisor.call('home.get', {});
    const second = supervisor.call('items.list');
    await settle();
    latest()?.say({ type: 'ready' });
    expect(supervisor.state).toBe('ready');
    await expect(first).resolves.toEqual({ echo: 'home.get' });
    await expect(second).resolves.toEqual({ echo: 'items.list' });
    expect(messages).toEqual([{ type: 'ready' }]);
  });

  it('passes the local API error of a failed call through', async () => {
    const { supervisor, latest } = harness();
    supervisor.start(NORMAL);
    latest()?.say({ type: 'ready' });
    const error = await rejection(supervisor.call('fail.this'));
    expect(error.data).toEqual({ code: 'E_NOT_FOUND', message: 'no such', help: ['h'] });
  });

  it('drops malformed host messages', () => {
    const { supervisor, latest, messages } = harness();
    supervisor.start(NORMAL);
    latest()?.say({ type: 'notify', notification: { id: 'x', kind: 'progress', title: 't' } });
    latest()?.say({ type: 'nonsense' });
    expect(messages).toEqual([]);
  });

  it('restarts a crashed core with backoff; in-flight calls fail with E_CRASH', async () => {
    const { clock, cores, supervisor, latest, states } = harness();
    supervisor.start(NORMAL);
    latest()!.answering = false;
    latest()?.say({ type: 'ready' });
    const inFlight = supervisor.call('home.get');
    await settle();
    latest()?.crash();
    expect((await rejection(inFlight)).data.code).toBe('E_CRASH');
    expect(supervisor.state).toBe('restarting');

    // A call made while restarting waits for the new core.
    const waiting = supervisor.call('items.list');
    clock.advance(999);
    expect(cores).toHaveLength(1);
    clock.advance(1);
    expect(cores).toHaveLength(2);
    latest()?.say({ type: 'ready' });
    await expect(waiting).resolves.toEqual({ echo: 'items.list' });

    // Second crash in a row: 2 s.
    latest()?.crash();
    clock.advance(1_999);
    expect(cores).toHaveLength(2);
    clock.advance(1);
    expect(cores).toHaveLength(3);
    expect(states).toEqual([
      'starting',
      'ready',
      'restarting',
      'starting',
      'ready',
      'restarting',
      'starting',
    ]);
  });

  it('gives up after repeated crashes instead of looping, and says why', async () => {
    const { clock, cores, supervisor, latest } = harness({ crashLimit: 3 });
    supervisor.start(NORMAL);
    for (let crash = 0; crash < 4; crash += 1) {
      latest()?.crash();
      clock.advance(60_000);
    }
    expect(cores).toHaveLength(4);
    expect(supervisor.state).toBe('failed');
    const error = await rejection(supervisor.call('home.get'));
    expect(error.data.code).toBe('E_APP_NOT_RUNNING');
    expect(error.data.message).toMatch(/repeated crashes/);
  });

  it('resets the backoff after a stable run', () => {
    const { clock, cores, supervisor, latest } = harness();
    supervisor.start(NORMAL);
    latest()?.crash();
    clock.advance(1_000);
    latest()?.say({ type: 'ready' });
    clock.advance(120_000);
    latest()?.crash();
    clock.advance(1_000);
    expect(cores).toHaveLength(3);
  });

  it('kills a core that never says ready, and restarts it', () => {
    const { clock, cores, supervisor } = harness({ startTimeoutMs: 5_000 });
    supervisor.start(NORMAL);
    clock.advance(5_000);
    expect(cores[0]?.killed).toBe(true);
  });

  it('stops gracefully; calls after stop fail with E_APP_NOT_RUNNING', async () => {
    const { supervisor, latest } = harness();
    supervisor.start(NORMAL);
    latest()?.say({ type: 'ready' });
    await supervisor.stop();
    expect(latest()?.received.map(({ message }) => message.type)).toEqual(['init', 'stop']);
    expect(latest()?.killed).toBe(false);
    expect(supervisor.state).toBe('stopped');
    expect((await rejection(supervisor.call('home.get'))).data.code).toBe('E_APP_NOT_RUNNING');
  });

  it('asks the core whether the app is idle; a core that is starting or silent counts as busy', async () => {
    const { clock, supervisor, latest } = harness({ activityTimeoutMs: 1_000 });
    expect(await supervisor.activity()).toEqual([]);
    supervisor.start(NORMAL);
    expect(await supervisor.activity()).toEqual(['the core is starting']);
    latest()?.say({ type: 'ready' });
    const asked = supervisor.activity();
    const question = latest()?.received.at(-1)?.message;
    expect(question).toEqual({ type: 'activity', id: expect.any(Number) });
    latest()?.say({
      type: 'activity',
      id: (question as { id: number }).id,
      busy: ['1 meeting in progress'],
    });
    expect(await asked).toEqual(['1 meeting in progress']);

    const silent = supervisor.activity();
    clock.advance(1_000);
    expect(await silent).toEqual(['the core did not answer']);
  });

  it('kills a core that does not stop in time', async () => {
    const { clock, supervisor, latest } = harness({ stopTimeoutMs: 2_000 });
    supervisor.start(NORMAL);
    const core = latest()!;
    core.postMessage = (message) => void core.received.push({ message, transfer: [] });
    const stopped = supervisor.stop();
    clock.advance(2_000);
    await stopped;
    expect(core.killed).toBe(true);
    expect(supervisor.state).toBe('stopped');
  });

  it('does not restart a core that exits during stop', async () => {
    const { clock, cores, supervisor } = harness();
    supervisor.start(NORMAL);
    await supervisor.stop();
    clock.advance(60_000);
    expect(cores).toHaveLength(1);
  });
});
