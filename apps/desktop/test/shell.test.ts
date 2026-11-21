import { EventEmitter } from 'node:events';

import { deriveBackupKey, type SerializedBackupKey } from '@cc/core/backup-keys';
import { apiMethods, EXTENSION_API_CURRENT } from '@cc/schemas';

import { describe, expect, it } from 'vitest';

import { KEYS_SECRET, LEGACY_PASSPHRASE_SECRET } from '../src/main/backup-keys.js';
import type { CoreLauncher, CoreProcess, MainPort } from '../src/main/core-supervisor.js';
import { AGENT_ONLY_METHODS, UI_METHODS } from '../src/main/generated/ui-methods.js';
import type { InvokeAnswer, InvokeEvent } from '../src/main/ipc.js';
import {
  IDLE_RESTART_POLL_MS,
  RECHECK_MS,
  type RebuildOutcome,
  type RebuildState,
} from '../src/main/rebuild-offer.js';
import type { ShownNotification } from '../src/main/notifications/center.js';
import {
  CONFIRM_ANSWER_CHANNEL,
  promptUrl,
  SECRET_ANSWER_CHANNEL,
  type PromptWindow,
  type PromptWindowSpec,
} from '../src/main/shell-prompts.js';
import {
  SMOKE_TIMEOUT_MS,
  startShell,
  type ShellOptions,
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

/** One of main's prompt windows; its web contents id is what answers must come from. */
class FakePromptWindow implements PromptWindow {
  destroyed = false;
  focused = 0;
  readonly #closed: (() => void)[] = [];
  readonly senderId: number;
  readonly spec: PromptWindowSpec;
  constructor(senderId: number, spec: PromptWindowSpec) {
    this.senderId = senderId;
    this.spec = spec;
  }
  isDestroyed = () => this.destroyed;
  focus = () => void (this.focused += 1);
  close = () => {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.#closed) listener();
  };
  onClosed = (listener: () => void) => void this.#closed.push(listener);
}

class FakeCore extends EventEmitter implements CoreProcess {
  readonly received: MainToHost[] = [];
  /** What the core answers to `activity`. */
  busy: readonly string[] = [];
  port: FakePort | undefined;
  /** Every UI call that reached this core. */
  readonly calls: { method: string; params?: unknown }[] = [];
  postMessage(message: MainToHost, transfer: MainPort[] = []): void {
    this.received.push(message);
    if (message.type === 'init') {
      this.port = transfer[0] as FakePort;
      this.port.on(
        'message',
        ({ data }: { data: { id: number; method: string; params?: unknown } }) => {
          this.calls.push({ method: data.method, params: data.params });
          // A Tier H call (C-04-12): the core answers with an intent instead of running it.
          if (data.method === 'principals.revoke') {
            this.port?.postMessage({
              id: data.id,
              result: { status: 'needs_confirmation', intent: INTENT },
            });
            return;
          }
          this.port?.postMessage({
            id: data.id,
            // The params are echoed for backups.* only, to show what reached the core.
            result: {
              method: data.method,
              ...(data.method.startsWith('backups.') ? { params: data.params } : {}),
            },
          });
        },
      );
      this.port.start();
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
    if (message.type === 'activity') {
      const { id } = message;
      queueMicrotask(() => this.emit('message', { type: 'activity', id, busy: this.busy }));
    }
    if (message.type === 'approve-intent') {
      const { id, intentId, payloadHash } = message;
      queueMicrotask(() =>
        this.emit(
          'message',
          intentId === INTENT.id && payloadHash === INTENT.payloadHash
            ? { type: 'intent-result', id, result: { principal: { name: 'cli-default' } } }
            : {
                type: 'intent-result',
                id,
                error: { code: 'E_PAYLOAD_CHANGED', message: 'not that payload', help: [] },
              },
        ),
      );
    }
    if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0));
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 9));
    return true;
  }
}

/** The intent the fake core issues for `principals.revoke`. */
const INTENT = {
  id: 'cfi_01KA0000000000000000000000',
  method: 'principals.revoke',
  preview: 'Remove access for "cli-default".',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  expiresAt: '2026-11-13T05:35:00.000Z',
};

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
  const refusals: { code: string; message: string; help: readonly string[] }[] = [];
  /** Main's prompt windows, and what the user does in them (`manual`: the test answers). */
  const prompts: FakePromptWindow[] = [];
  const answer = {
    confirmed: true,
    secret: 'correct horse battery staple' as string | undefined,
    folder: '/tmp/cc-test-folder' as string | undefined,
    manual: false,
    hold: undefined as Promise<void> | undefined,
  };
  const folderTitles: string[] = [];
  let nextSender = 100;
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
    prepare: () => {
      calls.prepare += 1;
      return Promise.resolve();
    },
    registerProtocolClient: () => void (calls.registerProtocolClient += 1),
    createWindow: (title) => {
      const window = new FakeWindow(title);
      windows.push(window);
      return window;
    },
    openPrompt: (spec) => {
      const window = new FakePromptWindow(nextSender++, spec);
      prompts.push(window);
      // The user answers in the window, as Playwright clicks it in the app flows.
      void Promise.resolve(answer.hold).then(() => {
        if (answer.manual || window.destroyed) return;
        const event = {
          senderFrame: { url: promptUrl(spec.token), parent: null },
          sender: { id: window.senderId },
        };
        if (spec.kind === 'confirm') {
          handlers.get(CONFIRM_ANSWER_CHANNEL)?.(
            event,
            spec.token,
            answer.confirmed ? 'approve' : 'deny',
          );
        } else {
          handlers.get(SECRET_ANSWER_CHANNEL)?.(event, spec.token, answer.secret ?? null);
        }
      });
      return window;
    },
    chooseFolder: (title) => {
      folderTitles.push(title);
      return Promise.resolve(answer.folder);
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
    refuseStart: (refusal) => void refusals.push(refusal),
    log: (event, fields) => void logs.push({ event, ...(fields === undefined ? {} : { fields }) }),
    ...overrides,
  };

  const emit = (name: string, ...args: unknown[]) =>
    (listeners.get(name) as ((...a: unknown[]) => unknown) | undefined)?.(...args);
  const invoke = (channel: string, url: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ senderFrame: { url, parent: null } }, ...args);
  /** A call with the whole event: the sender's web contents id and frame. */
  const invokeAs = (channel: string, event: InvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)?.(event, ...args);

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
    refusals,
    prompts,
    answer,
    folderTitles,
    emit,
    invoke,
    invokeAs,
    ready: resolveReady,
  };
}

function deferredCheck(): { check: StartCheck; resolve: (mode: StartMode) => void } {
  let resolve: (mode: StartMode) => void = () => undefined;
  const result = new Promise<StartMode>((r) => (resolve = r));
  return { check: () => result.then((mode) => ({ mode, offerRebuild: false })), resolve };
}

/** Secrets kept in memory, as `safeStorage` files would hold them. */
function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    read: (name: string) => Promise.resolve(values.get(name)),
    write: (name: string, value: string) => {
      values.set(name, value);
      return Promise.resolve();
    },
    remove: (name: string) => {
      values.delete(name);
      return Promise.resolve();
    },
  };
}

/** ADR 0007's derivation at a test cost. */
const fastDerive = (passphrase: string) =>
  deriveBackupKey(passphrase, {
    alg: 'scrypt',
    N: 2 ** 10,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16, 3).toString('base64'),
  });

function parseKeysOf(value: string | undefined): SerializedBackupKey[] {
  return value === undefined ? [] : (JSON.parse(value) as SerializedBackupKey[]);
}

async function startedWith(fake: ReturnType<typeof fakePlatform>, options: ShellOptions) {
  const shell = startShell(fake.platform, options);
  fake.ready();
  const value = await shell;
  await settle(20);
  return value;
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
      backupKeys: [],
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
      apiVersion: EXTENSION_API_CURRENT,
    });
  });

  it('ADR 0003 decision 9 main refuses every method not marked ui before the core sees it', async () => {
    const fake = fakePlatform();
    await started(fake);
    const core = fake.cores[0];
    const call = async (method: string) =>
      (await fake.invoke('cc:invoke', 'cc-app://app/', method, {})) as InvokeAnswer;

    // Agent-only methods: the connection handshake and waiting on a confirmation.
    for (const method of ['auth.hello', 'auth.prove', 'confirmations.wait', 'connectors.invoke']) {
      expect(await call(method), method).toMatchObject({
        ok: false,
        error: { code: 'E_FORBIDDEN', message: `${method} is not available to the app window` },
      });
    }
    // Names the local API does not have at all.
    for (const method of ['fs.readFile', 'shell.openExternal', 'items.delete']) {
      expect(await call(method), method).toMatchObject({
        ok: false,
        error: { code: 'E_USAGE', message: `unknown method ${method}` },
      });
    }
    // None of them reached the core; an allowed method does.
    expect(core?.calls).toEqual([]);
    expect(await call('home.get')).toEqual({ ok: true, result: { method: 'home.get' } });
    expect(core?.calls.map((c) => c.method)).toEqual(['home.get']);

    // The allowlist is the methods marked ui, every one of them a local API method.
    const marked = apiMethods.filter((definition) => definition.ui).map((d) => d.method);
    expect([...UI_METHODS].sort()).toEqual(marked.sort());
    expect([...AGENT_ONLY_METHODS].sort()).toEqual(
      apiMethods
        .filter((definition) => !definition.ui)
        .map((d) => d.method)
        .sort(),
    );
    expect(UI_METHODS.has('home.get')).toBe(true);
  });

  it("01 §3.1 row 9, 04 §9.1 rule 3: the passphrase is typed in main's secret prompt and becomes a key in the secret store and the core; the passphrase itself reaches neither, nor the app page", async () => {
    const secrets = memorySecrets();
    const fake = fakePlatform({ secrets });
    await startedWith(fake, { deriveBackupKey: fastDerive });
    // The first start makes the random key of the local set and hands it to the core.
    const first = parseKeysOf(secrets.values.get(KEYS_SECRET));
    expect(first).toEqual([expect.objectContaining({ origin: 'random' })]);
    expect(fake.cores[0]?.received[0]).toMatchObject({ type: 'init', backupKeys: first });

    const passphrase = 'correct horse battery staple';
    // The page never passes a passphrase: such a call is refused and no prompt opens.
    const passed = (await fake.invoke('cc:invoke', 'cc-app://app/', 'backups.passphrase', {
      passphrase,
    })) as InvokeAnswer;
    expect(passed).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
    expect(fake.prompts).toHaveLength(0);

    fake.answer.secret = 'too short';
    const short = (await fake.invoke(
      'cc:invoke',
      'cc-app://app/',
      'backups.passphrase',
      {},
    )) as InvokeAnswer;
    expect(short).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
    expect(parseKeysOf(secrets.values.get(KEYS_SECRET))).toHaveLength(1);

    fake.answer.secret = passphrase;
    const answer = (await fake.invoke(
      'cc:invoke',
      'cc-app://app/',
      'backups.passphrase',
      {},
    )) as InvokeAnswer;
    expect(fake.prompts.map((prompt) => [prompt.spec.kind, prompt.spec.title])).toEqual([
      ['secret', 'Backup password'],
      ['secret', 'Backup password'],
    ]);
    expect(fake.prompts.every((prompt) => prompt.destroyed)).toBe(true);
    const keys = parseKeysOf(secrets.values.get(KEYS_SECRET));
    expect(keys.map((key) => key.origin)).toEqual(['random', 'passphrase']);
    // The derived key went to the running core; the core is called with no params.
    expect(fake.cores[0]?.received).toContainEqual({ type: 'backup-keys', keys });
    expect(answer).toEqual({ ok: true, result: { method: 'backups.passphrase', params: {} } });
    const everything = JSON.stringify([fake.logs, fake.cores[0]?.received, [...secrets.values]]);
    expect(everything).not.toContain(passphrase);

    // Cancel in the prompt sets nothing.
    fake.answer.secret = undefined;
    const cancelled = (await fake.invoke(
      'cc:invoke',
      'cc-app://app/',
      'backups.passphrase',
      {},
    )) as InvokeAnswer;
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'E_HUMAN_REQUIRED' } });
    expect(parseKeysOf(secrets.values.get(KEYS_SECRET))).toHaveLength(2);

    const nowhere = fakePlatform();
    await started(nowhere);
    const refused = (await nowhere.invoke(
      'cc:invoke',
      'cc-app://app/',
      'backups.passphrase',
      {},
    )) as InvokeAnswer;
    expect(refused).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
    expect(nowhere.prompts).toHaveLength(0);
  });

  it("01 §3.1 row 10, 04 §9.1 rule 5: a folder destination's folder is chosen in the system folder picker, never passed by the app page", async () => {
    const fake = fakePlatform();
    await started(fake);
    const set = (destination: unknown) =>
      fake.invoke('cc:invoke', 'cc-app://app/', 'backups.destination', {
        destination,
      }) as Promise<InvokeAnswer>;

    const passed = await set({ kind: 'folder', label: 'Synced folder', path: '/somewhere/else' });
    expect(passed).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
    expect(fake.folderTitles).toEqual([]);

    expect(await set({ kind: 'folder', label: '  Synced folder ' })).toEqual({
      ok: true,
      result: {
        method: 'backups.destination',
        params: {
          destination: { kind: 'folder', label: 'Synced folder', path: '/tmp/cc-test-folder' },
        },
      },
    });
    expect(fake.folderTitles).toEqual(['Choose the folder for Synced folder']);

    fake.answer.folder = undefined;
    expect(await set({ kind: 'folder', label: 'Synced folder' })).toMatchObject({
      ok: false,
      error: { code: 'E_HUMAN_REQUIRED' },
    });
    expect(await set({ kind: 'folder', label: ' ' })).toMatchObject({
      ok: false,
      error: { code: 'E_USAGE' },
    });
    // Clearing the destination goes to the core as it is.
    expect(await set(null)).toEqual({
      ok: true,
      result: { method: 'backups.destination', params: { destination: null } },
    });
    expect(
      fake.cores[0]?.calls.filter((call) => call.method === 'backups.destination'),
    ).toHaveLength(2);
  });

  it('04 §9.1 rule 3: a passphrase the P1-12 build kept becomes its key, and the passphrase file is deleted', async () => {
    const secrets = memorySecrets();
    secrets.values.set(LEGACY_PASSPHRASE_SECRET, 'correct horse battery staple');
    const fake = fakePlatform({ secrets });
    await startedWith(fake, { deriveBackupKey: fastDerive });
    // The derivation runs on the thread pool: wait for the core to start with the keys.
    for (let i = 0; i < 200 && fake.cores.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await settle(5);
    }
    expect(secrets.values.has(LEGACY_PASSPHRASE_SECRET)).toBe(false);
    const keys = parseKeysOf(secrets.values.get(KEYS_SECRET));
    expect(keys.map((key) => key.origin)).toEqual(['random', 'passphrase']);
    expect(keys[1]?.id).toBe((await fastDerive('correct horse battery staple')).id);
    expect(fake.cores[0]?.received[0]).toMatchObject({ backupKeys: keys });
  });

  it('AC-04-12 a core that refuses a data directory inside a synced folder is not restarted: the shell shows the help and exits', async () => {
    const fake = fakePlatform();
    const shell = await started(fake);
    const refusal = {
      type: 'refused',
      code: 'E_GUARD_SYNCED_FOLDER',
      message: 'the Command Center data directory /x/Dropbox/cc is inside Dropbox',
      help: ['move the data directory to a path that no sync client watches, then start CC again'],
    };
    fake.cores[0]?.emit('message', refusal);
    fake.cores[0]?.emit('exit', 1);
    await settle(20);
    expect(fake.refusals).toEqual([
      { type: 'refused', code: refusal.code, message: refusal.message, help: refusal.help },
    ]);
    expect(shell?.core.state).toBe('failed');
    (fake.platform.clock as TimerClock).advance(60_000);
    await settle(20);
    expect(fake.cores).toHaveLength(1);
  });

  it('04 §9.1 rule 9: a staged restore restarts the core at once, with the keys, after the restore call answered', async () => {
    const secrets = memorySecrets();
    const fake = fakePlatform({ secrets });
    const shell = await startedWith(fake, { deriveBackupKey: fastDerive });
    const answer = (await fake.invoke('cc:invoke', 'cc-app://app/', 'backups.restore', {
      id: 'bkp_01KA0000000000000000000000',
    })) as InvokeAnswer;
    expect(answer).toMatchObject({ ok: true });
    fake.cores[0]?.emit('message', { type: 'restart', reason: 'restore' });
    await settle(20);
    expect(fake.cores).toHaveLength(2);
    expect(fake.cores[0]?.received.at(-1)).toEqual({ type: 'stop' });
    expect(fake.cores[1]?.received[0]).toMatchObject({
      type: 'init',
      backupKeys: parseKeysOf(secrets.values.get(KEYS_SECRET)),
    });
    expect(shell?.core.state).toBe('ready');
    // A restart is not a crash: no backoff, and calls go to the new core.
    expect(await fake.invoke('cc:invoke', 'cc-app://app/', 'home.get', {})).toMatchObject({
      ok: true,
    });
    expect(fake.cores[1]?.calls.map((call) => call.method)).toEqual(['home.get']);
  });

  it('C-04-12 a Tier H call is confirmed in the confirm window main opens, then approved over the core-host channel, not the UI port', async () => {
    const fake = fakePlatform();
    await started(fake);
    const answer = (await fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    })) as InvokeAnswer;
    // The window shows the core's preview, not anything the renderer sent.
    const [prompt] = fake.prompts;
    expect(fake.prompts).toHaveLength(1);
    expect(prompt?.spec).toMatchObject({ kind: 'confirm', title: 'Remove access' });
    expect(prompt?.spec.page).toContain('Remove access for &quot;cli-default&quot;.');
    expect(prompt?.destroyed).toBe(true);
    expect(fake.cores[0]?.received.filter((message) => message.type === 'approve-intent')).toEqual([
      {
        type: 'approve-intent',
        id: expect.any(Number) as number,
        intentId: INTENT.id,
        payloadHash: INTENT.payloadHash,
      },
    ]);
    // The renderer gets the operation's result; the UI port carried the one call only.
    expect(answer).toEqual({ ok: true, result: { principal: { name: 'cli-default' } } });
    expect(fake.cores[0]?.calls.map((call) => call.method)).toEqual(['principals.revoke']);
  });

  it('C-04-12 Cancel in the confirm window drops the intent, and the renderer is told nothing changed', async () => {
    const fake = fakePlatform();
    fake.answer.confirmed = false;
    await started(fake);
    const answer = (await fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    })) as InvokeAnswer;
    expect(answer).toMatchObject({ ok: false, error: { code: 'E_HUMAN_REQUIRED' } });
    const sent = fake.cores[0]?.received.map((message) => message.type) ?? [];
    expect(sent).toContain('deny-intent');
    expect(sent).not.toContain('approve-intent');
  });

  it("C-04-12 the confirm window takes its answer only from its own window's top frame and token; the app page cannot approve", async () => {
    const fake = fakePlatform();
    fake.answer.manual = true;
    await started(fake);
    const pending = fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    }) as Promise<InvokeAnswer>;
    await settle(20);
    const prompt = fake.prompts[0];
    if (prompt === undefined) throw new Error('no confirm window');
    const token = prompt.spec.token;
    const own = { url: promptUrl(token), parent: null };
    const refusedAnswers: [InvokeEvent, unknown, unknown][] = [
      // The app window, even with the right token.
      [
        { senderFrame: { url: 'cc-app://app/', parent: null }, sender: { id: 1 } },
        token,
        'approve',
      ],
      // The right URL from another web contents.
      [{ senderFrame: own, sender: { id: prompt.senderId + 1 } }, token, 'approve'],
      // A subframe of the confirm window.
      [{ senderFrame: { ...own, parent: {} }, sender: { id: prompt.senderId } }, token, 'approve'],
      // Another token, or no choice the window offers.
      [{ senderFrame: own, sender: { id: prompt.senderId } }, 'f'.repeat(32), 'approve'],
      [{ senderFrame: own, sender: { id: prompt.senderId } }, token, 'yes'],
      // The secret channel cannot answer a confirm window.
      [{ senderFrame: own, sender: { id: prompt.senderId } }, token, 'approve'],
    ];
    for (const [index, [event, id, choice]] of refusedAnswers.entries()) {
      const channel =
        index === refusedAnswers.length - 1 ? SECRET_ANSWER_CHANNEL : CONFIRM_ANSWER_CHANNEL;
      expect(fake.invokeAs(channel, event, id, choice), String(index)).toBe(false);
    }
    await settle(20);
    expect(prompt.destroyed).toBe(false);
    expect(fake.cores[0]?.received.map((message) => message.type)).not.toContain('approve-intent');

    expect(
      fake.invokeAs(
        CONFIRM_ANSWER_CHANNEL,
        { senderFrame: own, sender: { id: prompt.senderId } },
        token,
        'approve',
      ),
    ).toBe(true);
    expect(await pending).toMatchObject({ ok: true });
    // A second answer finds no open window.
    expect(
      fake.invokeAs(
        CONFIRM_ANSWER_CHANNEL,
        { senderFrame: own, sender: { id: prompt.senderId } },
        token,
        'approve',
      ),
    ).toBe(false);
  });

  it('C-04-12 closing the confirm window, or letting the intent expire, confirms nothing', async () => {
    const fake = fakePlatform();
    fake.answer.manual = true;
    await started(fake);
    const closed = fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    }) as Promise<InvokeAnswer>;
    await settle(20);
    fake.prompts[0]?.close();
    expect(await closed).toMatchObject({ ok: false, error: { code: 'E_HUMAN_REQUIRED' } });

    const expired = fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    }) as Promise<InvokeAnswer>;
    await settle(20);
    expect(fake.prompts[1]?.destroyed).toBe(false);
    (fake.platform.clock as TimerClock).advanceTo(INTENT.expiresAt);
    expect(await expired).toMatchObject({ ok: false, error: { code: 'E_HUMAN_REQUIRED' } });
    expect(fake.prompts[1]?.destroyed).toBe(true);
    const sent = fake.cores[0]?.received.map((message) => message.type) ?? [];
    expect(sent.filter((type) => type === 'deny-intent')).toHaveLength(2);
    expect(sent).not.toContain('approve-intent');
  });

  it('C-04-12 one confirm window at a time: a second Tier H call while one is open is not confirmed', async () => {
    const fake = fakePlatform();
    let release: () => void = () => undefined;
    fake.answer.hold = new Promise<void>((resolve) => (release = resolve));
    await started(fake);
    const first = fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    }) as Promise<InvokeAnswer>;
    await settle(20);
    const second = (await fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    })) as InvokeAnswer;
    expect(second).toMatchObject({ ok: false, error: { code: 'E_HUMAN_REQUIRED' } });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(fake.prompts).toHaveLength(1);
  });

  it('04 §4.3 rule 3, C-04-12 commandcenter://confirmations/<id> of an open intent brings its confirm window to the front instead of routing the app page', async () => {
    const fake = fakePlatform();
    fake.answer.manual = true;
    const shell = await started(fake);
    const pending = fake.invoke('cc:invoke', 'cc-app://app/', 'principals.revoke', {
      name: 'cli-default',
    }) as Promise<InvokeAnswer>;
    await settle(20);
    const prompt = fake.prompts[0];
    const window = fake.windows[0];
    const sentBefore = window?.sent.length ?? 0;
    expect(await shell?.openLink(`commandcenter://confirmations/${INTENT.id}`)).toEqual({
      kind: 'confirmations',
      target: INTENT.id,
    });
    expect(prompt?.focused).toBe(1);
    expect(window?.sent).toHaveLength(sentBefore);
    // Any other confirmation link opens the app page's inline prompt, as before.
    await shell?.openLink('commandcenter://confirmations/cfm_7q2');
    expect(window?.sent.at(-1)).toEqual({
      channel: 'cc:navigate',
      payload: { kind: 'confirmations', target: 'cfm_7q2' },
    });
    prompt?.close();
    await pending;
    // Once it is answered, its link routes the app page too.
    await shell?.openLink(`commandcenter://confirmations/${INTENT.id}`);
    expect(window?.sent.at(-1)).toEqual({
      channel: 'cc:navigate',
      payload: { kind: 'confirmations', target: INTENT.id },
    });
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
    rebuild: async (backup: () => Promise<void>) => {
      await backup();
      runs.push(runs.length + 1);
      return outcome;
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
    // The pre-update backup went through the core first (04 §10 rule 2, §9.1 rule 1).
    expect(core.calls).toContainEqual({ method: 'backups.run', params: { trigger: 'pre_update' } });
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
        // A build with an empty ui/ runs the default UI (AC-08-11, ADR 0008 decision 1).
        ui: 'default',
        uiCall: 'home.get: ok',
        // A new profile: the window opens on onboarding (AC-08-11).
        firstScreen: 'onboarding',
        ms: 0,
      },
    ]);
    expect(fake.cores[0]?.received.map((message) => message.type)).toEqual(['init', 'stop']);
  });

  it("AC-08-11 says when the window runs the engine's own UI", async () => {
    const fake = fakePlatform({
      packaged: true,
      smoke: true,
      ui: 'engine',
      startCheck: () => Promise.resolve({ mode: { kind: 'normal' }, offerRebuild: false }),
    });
    await started(fake);
    await settle(20);
    expect(fake.smokes).toMatchObject([{ ok: true, ui: 'engine', firstScreen: 'onboarding' }]);
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
