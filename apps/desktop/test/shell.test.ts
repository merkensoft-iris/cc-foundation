import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { CoreLauncher, CoreProcess, MainPort } from '../src/main/core-supervisor.js';
import type { InvokeAnswer, InvokeEvent } from '../src/main/ipc.js';
import {
  IDLE_RESTART_POLL_MS,
  RECHECK_MS,
  type RebuildOutcome,
  type RebuildState,
} from '../src/main/rebuild-offer.js';
import type { ShownNotification } from '../src/main/notifications/center.js';
import {
  SMOKE_TIMEOUT_MS,
  startShell,
  type ShellPlatform,
  type ShellTray,
  type ShellWindow,
  type SmokeResult,
} from '../src/main/shell.js';
import { UNPACKAGED_REASON, unpackagedCheck, type StartCheck } from '../src/main/start-mode.js';
import type { trayState } from '../src/main/tray.js';
import type { MainToHost, StartMode } from '../src/shared/protocol.js';
import { fakeChannel, settle, timerClock, type FakePort, type TimerClock } from './fakes.js';

class FakeWindow implements ShellWindow {
  readonly loaded = Promise.resolve();
  readonly sent: { channel: string; payload: unknown }[] = [];
  destroyed = false;
  minimized = false;
  shown = 0;
  focused = 0;
  readonly #closed: (() => void)[] = [];
  title: string;
  constructor(title: string) {
    this.title = title;
  }
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore = () => void (this.minimized = false);
  show = () => void (this.shown += 1);
  focus = () => void (this.focused += 1);
  setTitle = (title: string) => void (this.title = title);
  send = (channel: string, payload: unknown) => void this.sent.push({ channel, payload });
  onClosed = (listener: () => void) => void this.#closed.push(listener);
  close(): void {
    this.destroyed = true;
    for (const listener of this.#closed) listener();
  }
}

class FakeCore extends EventEmitter implements CoreProcess {
  readonly received: MainToHost[] = [];
  /** What the core answers to `activity`. */
  busy: readonly string[] = [];
  port: FakePort | undefined;
  postMessage(message: MainToHost, transfer: MainPort[] = []): void {
    this.received.push(message);
    if (message.type === 'init') {
      this.port = transfer[0] as FakePort;
      this.port.on(
        'message',
        ({ data }: { data: { id: number; method: string; params?: unknown } }) =>
          this.port?.postMessage({
            id: data.id,
            // The params are echoed for backups.* only, to show what reached the core.
            result: {
              method: data.method,
              ...(data.method.startsWith('backups.') ? { params: data.params } : {}),
            },
          }),
      );
      this.port.start();
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
    if (message.type === 'activity') {
      const { id } = message;
      queueMicrotask(() => this.emit('message', { type: 'activity', id, busy: this.busy }));
    }
    if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0));
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 9));
    return true;
  }
}

type Listener = (...args: never[]) => unknown;

function fakePlatform(overrides: Partial<ShellPlatform> = {}) {
  const listeners = new Map<string, Listener>();
  const handlers = new Map<string, (event: InvokeEvent, ...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  const cores: FakeCore[] = [];
  const notifications: { shown: ShownNotification; click: () => void }[] = [];
  const traySets: ReturnType<typeof trayState>[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const calls = { quit: 0, prepare: 0, registerProtocolClient: 0, trayDestroyed: 0 };
  const relaunched: string[] = [];
  const smokes: SmokeResult[] = [];
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  const launcher: CoreLauncher = {
    fork: () => {
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    channel: fakeChannel,
  };
  const on =
    (name: string) =>
    (listener: Listener): void =>
      void listeners.set(name, listener);

  const platform: ShellPlatform = {
    argv: ['/opt/cc/command-center'],
    packaged: false,
    version: '0.0.0-test',
    userData: '/tmp/cc-test-shell',
    clock: timerClock('2026-11-13T05:30:00Z'),
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
    launcher,
    startCheck: unpackagedCheck,
    requestSingleInstanceLock: () => true,
    onSecondInstance: on('second-instance'),
    onOpenUrl: on('open-url'),
    onActivate: on('activate'),
    onWindowAllClosed: on('window-all-closed'),
    onBeforeQuit: on('before-quit'),
    whenReady: () => ready,
    prepare: () => void (calls.prepare += 1),
    registerProtocolClient: () => void (calls.registerProtocolClient += 1),
    createWindow: (title) => {
      const window = new FakeWindow(title);
      windows.push(window);
      return window;
    },
    createTray: (): ShellTray => ({
      set: (state) => void traySets.push(state),
      destroy: () => void (calls.trayDestroyed += 1),
    }),
    showNotification: (shown, click) => void notifications.push({ shown, click }),
    quit: () => {
      calls.quit += 1;
      const beforeQuit = listeners.get('before-quit') as
        ((event: { preventDefault(): void }) => void) | undefined;
      let prevented = false;
      beforeQuit?.({ preventDefault: () => (prevented = true) });
      if (!prevented) logs.push({ event: 'test.app_quit' });
    },
    relaunch: (executable) => void relaunched.push(executable),
    finishSmoke: (result) => void smokes.push(result),
    log: (event, fields) => void logs.push({ event, ...(fields === undefined ? {} : { fields }) }),
    ...overrides,
  };

  const emit = (name: string, ...args: unknown[]) =>
    (listeners.get(name) as ((...a: unknown[]) => unknown) | undefined)?.(...args);
  const invoke = (channel: string, url: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ senderFrame: { url, parent: null } }, ...args);

  return {
    platform,
    windows,
    cores,
    notifications,
    traySets,
    logs,
    calls,
    relaunched,
    smokes,
    emit,
    invoke,
    ready: resolveReady,
  };
}

function deferredCheck(): { check: StartCheck; resolve: (mode: StartMode) => void } {
  let resolve: (mode: StartMode) => void = () => undefined;
  const result = new Promise<StartMode>((r) => (resolve = r));
  return { check: () => result.then((mode) => ({ mode, offerRebuild: false })), resolve };
}

async function started(fake: ReturnType<typeof fakePlatform>) {
  const shell = startShell(fake.platform);
  fake.ready();
  const value = await shell;
  await settle(20);
  return value;
}

describe('desktop shell main process (04 §3)', () => {
  it('quits a second instance: the first one gets its argv', async () => {
    const fake = fakePlatform({ requestSingleInstanceLock: () => false });
    expect(await startShell(fake.platform)).toBeUndefined();
    expect(fake.calls.quit).toBe(1);
    expect(fake.windows).toHaveLength(0);
    expect(fake.cores).toHaveLength(0);
  });

  it('creates the window and tray while the clean-tree check runs, and starts the core after it', async () => {
    const { check, resolve } = deferredCheck();
    const fake = fakePlatform({ startCheck: check });
    const shell = await started(fake);
    expect(fake.calls.prepare).toBe(1);
    expect(fake.windows).toHaveLength(1);
    expect(fake.windows[0]?.title).toBe('Command Center');
    expect(fake.traySets).toHaveLength(1);
    // ADR 0004 decision 3: no core before the mode is known.
    expect(fake.cores).toHaveLength(0);

    resolve({ kind: 'developer', reasons: ['tracked file modified: ui/home.tsx'] });
    await settle(20);
    expect(fake.cores).toHaveLength(1);
    expect(fake.cores[0]?.received[0]).toEqual({
      type: 'init',
      userData: '/tmp/cc-test-shell',
      mode: { kind: 'developer', reasons: ['tracked file modified: ui/home.tsx'] },
    });
    expect(shell?.core.state).toBe('ready');
    // ADR 0004 decision 7: the window title and the tray carry the mode.
    expect(fake.windows[0]?.title).toBe('Command Center [developer]');
    const tray = fake.traySets[fake.traySets.length - 1];
    expect(tray?.icon).toBe('developer');
    expect(tray?.tooltip).toBe(
      'Command Center: developer mode (tracked file modified: ui/home.tsx)',
    );
    expect(tray?.menu.map((item) => item.label)).toContain(
      'Developer mode: tracked file modified: ui/home.tsx',
    );
  });

  it('starts an unpackaged run in developer mode, and a failing check never gives normal', async () => {
    const unpackaged = await started(fakePlatform());
    expect(await unpackaged?.mode).toEqual({ kind: 'developer', reasons: [UNPACKAGED_REASON] });

    const failing = await started(
      fakePlatform({ startCheck: () => Promise.reject(new Error('git not on PATH')) }),
    );
    expect(await failing?.mode).toEqual({
      kind: 'developer',
      reasons: ['cannot verify tree: git not on PATH'],
    });

    const normal = fakePlatform({
      startCheck: () => Promise.resolve({ mode: { kind: 'normal' }, offerRebuild: false }),
    });
    await started(normal);
    expect(normal.windows[0]?.title).toBe('Command Center');
    expect(normal.traySets[normal.traySets.length - 1]?.icon).toBe('normal');
  });

  it('opens a deep link given at launch (Windows and Linux argv)', async () => {
    const fake = fakePlatform({
      argv: ['/opt/cc/command-center', 'commandcenter://items/A-0142'],
    });
    await started(fake);
    expect(fake.windows[0]?.sent).toEqual([
      { channel: 'cc:navigate', payload: { kind: 'items', target: 'A-0142' } },
    ]);
  });

  it('opens a macOS open-url link that arrives before ready', async () => {
    const fake = fakePlatform();
    const shell = startShell(fake.platform);
    await settle();
    fake.emit('open-url', 'commandcenter://confirmations/cfm_7q2');
    fake.ready();
    await shell;
    await settle(20);
    expect(fake.windows[0]?.sent).toEqual([
      { channel: 'cc:navigate', payload: { kind: 'confirmations', target: 'cfm_7q2' } },
    ]);
  });

  it('focuses the window and routes the link of a second instance; drops a bad link', async () => {
    const fake = fakePlatform();
    await started(fake);
    const window = fake.windows[0];
    window!.minimized = true;
    fake.emit('second-instance', ['/opt/cc/command-center', 'commandcenter://requests/req_01J9']);
    await settle();
    expect(window?.minimized).toBe(false);
    expect(window?.focused).toBeGreaterThan(1);
    expect(window?.sent).toEqual([
      { channel: 'cc:navigate', payload: { kind: 'requests', target: 'req_01J9' } },
    ]);

    fake.emit('second-instance', ['/opt/cc/command-center', 'commandcenter://evil/../x']);
    await settle();
    expect(window?.sent).toHaveLength(1);
    expect(fake.logs.map(({ event }) => event)).toContain('deeplink.rejected');
  });

  it('keeps running in the tray when every window is closed, and reopens a window', async () => {
    const fake = fakePlatform();
    await started(fake);
    fake.windows[0]?.close();
    fake.emit('window-all-closed');
    expect(fake.calls.quit).toBe(0);

    fake.emit('second-instance', ['/opt/cc/command-center']);
    expect(fake.windows).toHaveLength(2);
    expect(fake.windows[1]?.shown).toBe(1);

    // The tray's Open item also reopens it.
    fake.windows[1]?.close();
    fake.traySets[fake.traySets.length - 1]?.menu[0]?.click?.();
    expect(fake.windows).toHaveLength(3);
  });

  it('stops the core gracefully before quitting', async () => {
    const fake = fakePlatform();
    const shell = await started(fake);
    const quitItem = fake.traySets[fake.traySets.length - 1]?.menu.find(
      (item) => item.label === 'Quit Command Center',
    );
    quitItem?.click?.();
    // The first quit is held while the core stops.
    expect(fake.logs.map(({ event }) => event)).not.toContain('test.app_quit');
    await settle(20);
    expect(fake.cores[0]?.received.map((message) => message.type)).toEqual(['init', 'stop']);
    expect(shell?.core.state).toBe('stopped');
    expect(fake.calls.trayDestroyed).toBe(1);
    expect(fake.logs.map(({ event }) => event)).toContain('test.app_quit');
  });

  it('shows pushed notifications and opens their link on click', async () => {
    const fake = fakePlatform();
    await started(fake);
    fake.cores[0]?.emit('message', {
      type: 'notify',
      notification: {
        id: 'cfm_7q2',
        kind: 'confirmation_waiting',
        title: 'A send is waiting for your confirmation',
        link: 'commandcenter://confirmations/cfm_7q2',
      },
    });
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]?.shown.title).toBe('A send is waiting for your confirmation');
    fake.notifications[0]?.click();
    await settle();
    expect(fake.windows[0]?.sent).toEqual([
      { channel: 'cc:navigate', payload: { kind: 'confirmations', target: 'cfm_7q2' } },
    ]);
  });

  it('holds notifications under the policy the core sends (AC-02-09 wiring)', async () => {
    const fake = fakePlatform({ clock: timerClock('2026-11-13T13:45:00Z') }); // Fri 19:15 IST
    const shell = await started(fake);
    fake.cores[0]?.emit('message', {
      type: 'notification-policy',
      policy: {
        timeZone: 'Asia/Kolkata',
        quietHours: [],
        protectedBlocks: [
          {
            id: 'pb_evening',
            label: 'Evening block',
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0',
            timeZone: 'Asia/Kolkata',
            durationMinutes: 300,
            policy: 'hard',
          },
        ],
      },
    });
    fake.cores[0]?.emit('message', {
      type: 'notify',
      notification: { id: 'r1', kind: 'meeting_reminder', title: 'Weekly CEO review' },
    });
    expect(fake.notifications).toHaveLength(0);
    expect(shell?.notifications.deliverAt?.toISOString()).toBe('2026-11-13T17:30:00.000Z');
  });

  it('forwards UI calls from the app window to the core as the user, and refuses other frames', async () => {
    const fake = fakePlatform();
    await started(fake);
    const answer = (await fake.invoke(
      'cc:invoke',
      'cc-app://app/',
      'home.get',
      {},
    )) as InvokeAnswer;
    expect(answer).toEqual({ ok: true, result: { method: 'home.get' } });

    const foreign = (await fake.invoke(
      'cc:invoke',
      'https://example.invalid/',
      'home.get',
      {},
    )) as InvokeAnswer;
    expect(foreign).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });

    const bad = (await fake.invoke('cc:invoke', 'cc-app://app/', 'not a method')) as InvokeAnswer;
    expect(bad).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });

    expect(await fake.invoke('cc:shell', 'cc-app://app/')).toEqual({
      mode: { kind: 'developer', reasons: [UNPACKAGED_REASON] },
      version: '0.0.0-test',
    });
  });

  it('01 §3.1 row 9: the backup passphrase goes to the secret store, and the core only learns that it is set', async () => {
    const stored: [string, string][] = [];
    const fake = fakePlatform({
      storeSecret: (name, value) => {
        stored.push([name, value]);
        return Promise.resolve();
      },
    });
    await started(fake);
    const short = (await fake.invoke('cc:invoke', 'cc-app://app/', 'backups.passphrase', {
      passphrase: 'too short',
    })) as InvokeAnswer;
    expect(short).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
    expect(stored).toEqual([]);

    const passphrase = 'correct horse battery staple';
    const answer = (await fake.invoke('cc:invoke', 'cc-app://app/', 'backups.passphrase', {
      passphrase,
    })) as InvokeAnswer;
    expect(stored).toEqual([['backup-passphrase', passphrase]]);
    // The core is called with no params: the passphrase never reaches it.
    expect(answer).toEqual({ ok: true, result: { method: 'backups.passphrase', params: {} } });
    expect(JSON.stringify(fake.logs)).not.toContain(passphrase);

    const nowhere = fakePlatform();
    await started(nowhere);
    const refused = (await nowhere.invoke('cc:invoke', 'cc-app://app/', 'backups.passphrase', {
      passphrase,
    })) as InvokeAnswer;
    expect(refused).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
  });

  it('registers commandcenter:// with the OS only in a packaged build', async () => {
    const dev = fakePlatform();
    await started(dev);
    expect(dev.calls.registerProtocolClient).toBe(0);
    const packaged = fakePlatform({ packaged: true });
    await started(packaged);
    expect(packaged.calls.registerProtocolClient).toBe(1);
  });
});

const STALE: StartMode = {
  kind: 'developer',
  reasons: ['build out of date: the checkout is at 2b7e4f0c91aa, the build at 9f1c22d0e4b7'],
};
const staleCheck: StartCheck = () => Promise.resolve({ mode: STALE, offerRebuild: true });

/** The rebuild a packaged build runs, as a stand-in that records its calls. */
function fakeRebuild(outcome: RebuildOutcome) {
  const runs: number[] = [];
  return {
    runs,
    rebuild: () => {
      runs.push(runs.length + 1);
      return Promise.resolve(outcome);
    },
  };
}

const rebuildStates = (fake: ReturnType<typeof fakePlatform>) =>
  (fake.windows[0]?.sent ?? [])
    .filter((message) => message.channel === 'cc:rebuild-state')
    .map((message) => (message.payload as RebuildState).kind);

const trayLabels = (fake: ReturnType<typeof fakePlatform>) =>
  fake.traySets[fake.traySets.length - 1]?.menu.map((item) => item.label) ?? [];

describe('Rebuild now in the shell (04 §10 rule 2)', () => {
  it('AC-04-14 a clean checkout whose build is out of date gets Rebuild now; the app relaunches on the new build at the first idle moment', async () => {
    const built = fakeRebuild({ ok: true, app: '/builds/9f1c/out/command-center', log: '/l' });
    const fake = fakePlatform({ packaged: true, startCheck: staleCheck, rebuild: built.rebuild });
    const shell = await started(fake);
    expect(shell?.rebuild.state).toEqual({
      kind: 'offered',
      reason: STALE.reasons[0],
      deferred: false,
    });
    expect(await fake.invoke('cc:rebuild', 'cc-app://app/', 'state')).toMatchObject({
      kind: 'offered',
    });
    expect(trayLabels(fake)).toContain('Rebuild now (this app is older than its checkout)');

    // A meeting is in progress: the build finishes, the restart waits.
    const core = fake.cores[0];
    if (core === undefined) throw new Error('no core');
    core.busy = ['1 meeting in progress'];
    expect(await fake.invoke('cc:rebuild', 'cc-app://app/', 'now')).toEqual({
      kind: 'waiting-for-idle',
      busy: [],
    });
    await settle(20);
    expect(built.runs).toEqual([1]);
    expect(shell?.rebuild.state).toEqual({
      kind: 'waiting-for-idle',
      busy: ['1 meeting in progress'],
    });
    expect(fake.relaunched).toEqual([]);

    core.busy = [];
    (fake.platform.clock as TimerClock).advance(IDLE_RESTART_POLL_MS);
    await settle(20);
    expect(fake.relaunched).toEqual(['/builds/9f1c/out/command-center']);
    expect(shell?.rebuild.state).toEqual({ kind: 'restarting' });
    // The relaunch quits this run, and the core stops gracefully first.
    expect(core.received.map((message) => message.type)).toContain('stop');
    expect(rebuildStates(fake)).toEqual([
      'offered',
      'building',
      'waiting-for-idle',
      'waiting-for-idle',
      'restarting',
    ]);
  });

  it('Later hides the offer for this run but keeps it in the tray; only the app window may ask', async () => {
    const built = fakeRebuild({ ok: true, app: '/b/app', log: '/l' });
    const fake = fakePlatform({ packaged: true, startCheck: staleCheck, rebuild: built.rebuild });
    await started(fake);
    await expect(fake.invoke('cc:rebuild', 'https://example.invalid/', 'now')).rejects.toThrow(
      'refused',
    );
    expect(built.runs).toEqual([]);
    expect(await fake.invoke('cc:rebuild', 'cc-app://app/', 'later')).toMatchObject({
      kind: 'offered',
      deferred: true,
    });
    expect(trayLabels(fake)).toContain('Rebuild now (this app is older than its checkout)');
  });

  it('a failed rebuild changes nothing and shows its reason and log', async () => {
    const failed = fakeRebuild({
      ok: false,
      reason: 'build failed; see the build log',
      log: '/b/build.log',
    });
    const fake = fakePlatform({ packaged: true, startCheck: staleCheck, rebuild: failed.rebuild });
    const shell = await started(fake);
    expect(await shell?.rebuild.rebuildNow()).toEqual({
      kind: 'failed',
      reason: 'build failed; see the build log',
      log: '/b/build.log',
    });
    expect(fake.relaunched).toEqual([]);
    expect(fake.cores[0]?.received.map((message) => message.type)).toEqual(['init']);
    // The user may try again from the window or the tray.
    expect(trayLabels(fake)).toContain('Rebuild now (this app is older than its checkout)');
  });

  it('AC-04-14 a dirty checkout gets no offer, and an unpackaged run has nothing to rebuild', async () => {
    const built = fakeRebuild({ ok: true, app: '/b/app', log: '/l' });
    const dirty = fakePlatform({
      packaged: true,
      startCheck: () =>
        Promise.resolve({
          mode: { kind: 'developer', reasons: ['uncommitted changes: ui/home.tsx'] },
          offerRebuild: false,
        }),
      rebuild: built.rebuild,
    });
    await started(dirty);
    expect(await dirty.invoke('cc:rebuild', 'cc-app://app/', 'now')).toEqual({ kind: 'none' });
    expect(built.runs).toEqual([]);
    expect(trayLabels(dirty)).not.toContain('Rebuild now (this app is older than its checkout)');

    const unpackaged = fakePlatform({ startCheck: staleCheck });
    const shell = await started(unpackaged);
    expect(shell?.rebuild.state).toEqual({ kind: 'none' });
  });

  it('re-checks when idle, so a pull while the app runs brings the offer', async () => {
    let stale = false;
    const fake = fakePlatform({
      packaged: true,
      startCheck: () =>
        Promise.resolve(
          stale
            ? { mode: STALE, offerRebuild: true }
            : { mode: { kind: 'normal' }, offerRebuild: false },
        ),
      rebuild: fakeRebuild({ ok: true, app: '/b/app', log: '/l' }).rebuild,
    });
    const shell = await started(fake);
    expect(shell?.rebuild.state).toEqual({ kind: 'none' });
    stale = true;
    (fake.platform.clock as TimerClock).advance(RECHECK_MS);
    await settle(20);
    expect(shell?.rebuild.state).toMatchObject({ kind: 'offered' });
    // The mode decided at start stays (ADR 0004 decision 7): only the offer changes.
    expect(await shell?.mode).toEqual({ kind: 'normal' });
  });
});

describe('--smoke (09 P1-16: the packaged start on CI)', () => {
  it('AC-08-11 reports the mode once the core is ready, a UI call went through and the window loaded, and the first screen, then stops the core and exits', async () => {
    const fake = fakePlatform({
      packaged: true,
      smoke: true,
      startCheck: () => Promise.resolve({ mode: { kind: 'normal' }, offerRebuild: false }),
    });
    await started(fake);
    await settle(20);
    expect(fake.smokes).toEqual([
      {
        ok: true,
        mode: { kind: 'normal' },
        offerRebuild: false,
        packaged: true,
        version: '0.0.0-test',
        uiCall: 'home.get: ok',
        // A new profile: the window opens on onboarding (AC-08-11).
        firstScreen: 'onboarding',
        ms: 0,
      },
    ]);
    expect(fake.cores[0]?.received.map((message) => message.type)).toEqual(['init', 'stop']);
  });

  it('never rebuilds, and fails when the core does not come up in time', async () => {
    const built = fakeRebuild({ ok: true, app: '/b/app', log: '/l' });
    const fake = fakePlatform({
      packaged: true,
      smoke: true,
      startCheck: staleCheck,
      rebuild: built.rebuild,
      launcher: {
        fork: () => {
          const silent = new FakeCore();
          silent.postMessage = (message) => void silent.received.push(message);
          return silent;
        },
        channel: fakeChannel,
      },
    });
    const shell = await started(fake);
    expect(shell?.rebuild.state).toEqual({ kind: 'none' });
    expect(await fake.invoke('cc:rebuild', 'cc-app://app/', 'now')).toEqual({ kind: 'none' });
    (fake.platform.clock as TimerClock).advance(SMOKE_TIMEOUT_MS);
    await settle(20);
    expect(fake.smokes).toEqual([
      {
        ok: false,
        reason: `timed out after ${SMOKE_TIMEOUT_MS} ms (core starting)`,
        ms: SMOKE_TIMEOUT_MS,
      },
    ]);
    expect(built.runs).toEqual([]);
  });
});
