/**
 * The desktop shell's main process (04 §3 main row): the single-instance lock, the window,
 * the tray, `commandcenter://` deep links, OS notifications and the core's supervision.
 *
 * Electron is reached only through `ShellPlatform`; `electron-platform.ts` implements it,
 * and tests drive this module with a fake one, so the whole flow runs headless in CI.
 *
 * Start-up order (ADR 0004 decision 3): take the lock; when Electron is ready, run the
 * clean-tree check in parallel with creating the window and the tray; start the core once
 * the mode is known. Closing the last window keeps CC running in the tray (04 §1 rule 1);
 * quitting stops the core gracefully first. A packaged build whose checkout moved on gets the
 * Rebuild now offer (`rebuild-offer.ts`); `--smoke` runs the start once and exits
 * (`args.ts`).
 */
import type { HostToMain, StartMode } from '../shared/protocol.js';
import type { Clock, TimerHandle } from './clock.js';
import {
  CoreSupervisor,
  UiCallError,
  type CoreLauncher,
  type CoreState,
  type SupervisorTiming,
} from './core-supervisor.js';
import { deepLinkInArgv, parseDeepLink, type Route } from './deep-links.js';
import {
  NAVIGATE_CHANNEL,
  REBUILD_STATE_CHANNEL,
  registerBridge,
  type IpcMainLike,
  type ShellInfo,
} from './ipc.js';
import { NotificationCenter, type ShownNotification } from './notifications/center.js';
import { unsupportedBlocks } from './notifications/quiet-hours.js';
import { RebuildOffer, type RebuildOutcome } from './rebuild-offer.js';
import { resolveStartMode, windowTitle, type StartCheck, type StartVerdict } from './start-mode.js';
import { trayState } from './tray.js';

/** What `--smoke` reports in `<userData>/smoke.json`. */
export type SmokeResult =
  | {
      readonly ok: true;
      readonly mode: StartMode;
      readonly offerRebuild: boolean;
      readonly packaged: boolean;
      readonly version: string;
      /** What the UI call through main to the core answered (`home.get`). */
      readonly uiCall: string;
      /**
       * The screen the window opens on (AC-08-11): `onboarding` until onboarding is committed,
       * then `home` (01 §1 item 7; the renderer's `App.start` applies the same rule).
       */
      readonly firstScreen: string;
      readonly ms: number;
    }
  | { readonly ok: false; readonly reason: string; readonly ms: number };

/** How long a smoke run may take before it fails. */
export const SMOKE_TIMEOUT_MS = 120_000;

export interface ShellWindow {
  /** Resolves once the page has loaded, so a route sent after it is not lost. */
  readonly loaded: Promise<void>;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  setTitle(title: string): void;
  send(channel: string, payload: unknown): void;
  onClosed(listener: () => void): void;
}

export interface ShellTray {
  set(state: ReturnType<typeof trayState>): void;
  destroy(): void;
}

export interface ShellPlatform {
  readonly argv: readonly string[];
  readonly packaged: boolean;
  readonly version: string;
  /** `<userData>` (04 §9), after any `--profile-dir`. */
  readonly userData: string;
  readonly clock: Clock;
  readonly ipc: IpcMainLike;
  readonly launcher: CoreLauncher;
  readonly startCheck: StartCheck;
  /** Rebuild now for this build (04 §10 rule 2); absent without a build stamp. */
  readonly rebuild?: () => Promise<RebuildOutcome>;
  /** `--smoke`: start once, report and exit. */
  readonly smoke?: boolean;
  /**
   * Keeps a secret in `<userData>/secrets/<name>`, encrypted with the OS keychain
   * (`safeStorage`, 04 §9 rule 1); absent where the OS offers none.
   */
  readonly storeSecret?: (name: string, value: string) => Promise<void>;
  requestSingleInstanceLock(): boolean;
  onSecondInstance(listener: (argv: readonly string[]) => void): void;
  /** macOS delivers deep links as `open-url`; register before ready. */
  onOpenUrl(listener: (url: string) => void): void;
  onActivate(listener: () => void): void;
  onWindowAllClosed(listener: () => void): void;
  onBeforeQuit(listener: (event: { preventDefault(): void }) => void): void;
  whenReady(): Promise<void>;
  /** After ready: the app protocol, session and web-contents hardening. */
  prepare(): void;
  /** Makes CC the OS handler of `commandcenter://` (packaged builds only). */
  registerProtocolClient(): void;
  createWindow(title: string): ShellWindow;
  createTray(): ShellTray;
  showNotification(notification: ShownNotification, onClick: () => void): void;
  quit(): void;
  /** Starts `executable` with this run's arguments once this run has quit. */
  relaunch(executable: string): void;
  /** Ends a smoke run: writes `<userData>/smoke.json` and exits 0, or 1 when it failed. */
  finishSmoke(result: SmokeResult): void;
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface ShellOptions {
  readonly timing?: Partial<SupervisorTiming>;
}

export interface Shell {
  readonly mode: Promise<StartMode>;
  readonly rebuild: RebuildOffer;
  readonly core: CoreSupervisor;
  readonly notifications: NotificationCenter;
  /** Opens a deep link: shows the window and sends the route to the renderer. */
  openLink(link: string): Promise<Route | undefined>;
  /** Shows the window, creating it if every window was closed. */
  showWindow(): ShellWindow;
}

/**
 * Starts the shell. Resolves `undefined` when another instance holds the lock: that instance
 * gets this one's argv (and its deep link) through `second-instance`, and this one quits.
 */
export async function startShell(
  platform: ShellPlatform,
  options: ShellOptions = {},
): Promise<Shell | undefined> {
  if (!platform.requestSingleInstanceLock()) {
    platform.log('shell.second_instance_exit');
    platform.quit();
    return undefined;
  }

  let mode: StartMode | undefined;
  let window: ShellWindow | undefined;
  const trayRef: { current?: ShellTray } = {};
  let ready = false;
  let quitting = false;
  const earlyLinks: string[] = [];
  const initialLink = deepLinkInArgv(platform.argv);
  if (initialLink !== undefined) earlyLinks.push(initialLink);

  const notifications = new NotificationCenter({
    clock: platform.clock,
    show: (notification) =>
      platform.showNotification(notification, () => void openLink(notification.link)),
    onRefused: (_request, reason) => platform.log('notify.refused', { reason }),
  });

  const onHostMessage = (message: HostToMain): void => {
    switch (message.type) {
      case 'ready':
        platform.log('core.ready', { endpoint: message.endpoint?.path });
        break;
      case 'notify':
        notifications.push(message.notification);
        break;
      case 'notification-policy':
        for (const block of unsupportedBlocks(message.policy)) {
          platform.log('notify.block_rule_unsupported', { block: block.id });
        }
        notifications.setPolicy(message.policy);
        break;
      case 'fatal':
        break;
    }
  };

  const coreStateListeners = new Set<(state: CoreState) => void>();
  const core = new CoreSupervisor({
    launcher: platform.launcher,
    userData: platform.userData,
    clock: platform.clock,
    onHostMessage,
    onStateChange: (state) => {
      platform.log('core.state', { state });
      for (const listener of coreStateListeners) listener(state);
    },
    log: (event, fields) => platform.log(event, fields),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });

  const showWindow = (): ShellWindow => {
    if (window === undefined || window.isDestroyed()) {
      const created = platform.createWindow(windowTitle(mode));
      created.onClosed(() => {
        if (window === created) window = undefined;
      });
      window = created;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  };

  const openLink = async (link: string): Promise<Route | undefined> => {
    const route = parseDeepLink(link);
    if (route === undefined) {
      platform.log('deeplink.rejected', { length: link.length });
      return undefined;
    }
    if (!ready) {
      earlyLinks.push(link);
      return route;
    }
    const target = showWindow();
    await target.loaded;
    if (!target.isDestroyed()) target.send(NAVIGATE_CHANNEL, route);
    return route;
  };

  platform.onOpenUrl((url) => void openLink(url));
  platform.onSecondInstance((argv) => {
    const link = deepLinkInArgv(argv);
    if (link === undefined) {
      if (ready) showWindow();
    } else {
      void openLink(link);
    }
  });
  platform.onActivate(() => {
    if (ready) showWindow();
  });
  // Closing every window leaves CC in the tray (04 §1 rule 1): no quit here.
  platform.onWindowAllClosed(() => platform.log('shell.windows_closed'));
  platform.onBeforeQuit((event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    notifications.dispose();
    rebuild.dispose();
    core.stop().then(
      () => {
        trayRef.current?.destroy();
        platform.quit();
      },
      () => platform.quit(),
    );
  });

  await platform.whenReady();
  platform.prepare();
  if (platform.packaged) platform.registerProtocolClient();

  const verdictPromise = resolveStartMode(platform.startCheck);
  const modePromise = verdictPromise.then((verdict) => verdict.mode);

  const rebuild = new RebuildOffer({
    clock: platform.clock,
    check: platform.startCheck,
    rebuild: platform.smoke === true ? undefined : platform.rebuild,
    activity: () => core.activity(),
    relaunch: (executable) => {
      platform.relaunch(executable);
      platform.quit();
    },
    onChange: (state) => {
      if (window !== undefined && !window.isDestroyed()) window.send(REBUILD_STATE_CHANNEL, state);
      refreshTray();
    },
    log: (event, fields) => platform.log(event, fields),
  });

  registerBridge(platform.ipc, {
    call: (method, params) => core.call(method, params),
    shellInfo: async () => ({ mode: await modePromise, version: platform.version }),
    rebuild: {
      state: async () => {
        await verdictPromise;
        return rebuild.state;
      },
      now: () => rebuild.rebuildNow(),
      later: () => {
        rebuild.later();
        return Promise.resolve(rebuild.state);
      },
    },
    ...(platform.storeSecret === undefined
      ? {}
      : {
          storeBackupPassphrase: (passphrase: string) =>
            (platform.storeSecret as NonNullable<ShellPlatform['storeSecret']>)(
              'backup-passphrase',
              passphrase,
            ),
        }),
    log: (event, fields) => platform.log(event, fields),
  });

  ready = true;
  const tray = platform.createTray();
  trayRef.current = tray;
  const actions = { open: () => void showWindow(), quit: () => platform.quit() };
  function refreshTray(): void {
    tray.set(
      trayState(mode, {
        ...actions,
        ...(rebuild.actionable
          ? {
              rebuild: () => {
                showWindow();
                void rebuild.rebuildNow();
              },
            }
          : {}),
      }),
    );
  }
  refreshTray();
  showWindow();

  void verdictPromise.then((verdict) => {
    const resolved = verdict.mode;
    mode = resolved;
    platform.log('shell.mode', {
      mode: resolved.kind,
      ...(resolved.kind === 'developer' ? { reasons: resolved.reasons } : {}),
      ...(verdict.offerRebuild ? { offerRebuild: true } : {}),
    });
    if (window !== undefined && !window.isDestroyed()) window.setTitle(windowTitle(resolved));
    if (!quitting) core.start(resolved);
    rebuild.start(verdict);
    refreshTray();
  });

  for (const link of earlyLinks.splice(0)) void openLink(link);

  if (platform.smoke === true) {
    void runSmoke({
      platform,
      core,
      verdict: verdictPromise,
      window: () => window,
      onCoreState: (listener) => coreStateListeners.add(listener),
      stop: () => {
        quitting = true;
        notifications.dispose();
        rebuild.dispose();
        return core.stop();
      },
    });
  }

  const shell: Shell = {
    mode: modePromise,
    rebuild,
    core,
    notifications,
    openLink,
    showWindow,
  };
  return shell;
}

interface SmokeRun {
  readonly platform: ShellPlatform;
  readonly core: CoreSupervisor;
  readonly verdict: Promise<StartVerdict>;
  readonly window: () => ShellWindow | undefined;
  readonly onCoreState: (listener: (state: CoreState) => void) => void;
  readonly stop: () => Promise<void>;
}

/**
 * `--smoke`: the start check gave a mode, the core reached `ready`, a UI call went through
 * main to the core and back, and the window loaded. Then the core stops gracefully and the
 * app exits with the result.
 */
async function runSmoke(run: SmokeRun): Promise<void> {
  const { platform, core } = run;
  const started = platform.clock.now().getTime();
  const elapsed = () => platform.clock.now().getTime() - started;
  let timer: TimerHandle | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = platform.clock.setTimeout(
      () => reject(new Error(`timed out after ${SMOKE_TIMEOUT_MS} ms (core ${core.state})`)),
      SMOKE_TIMEOUT_MS,
    );
  });
  const coreReady = new Promise<void>((resolve, reject) => {
    const settle = (state: CoreState) => {
      if (state === 'ready') resolve();
      if (state === 'failed') reject(new Error('the core failed to start'));
    };
    run.onCoreState(settle);
    settle(core.state);
  });
  let result: SmokeResult;
  try {
    const verdict = await Promise.race([run.verdict, timeout]);
    await Promise.race([coreReady, timeout]);
    let uiCall: string;
    try {
      await Promise.race([core.call('home.get', {}), timeout]);
      uiCall = 'home.get: ok';
    } catch (error) {
      if (
        !(error instanceof UiCallError) ||
        ['E_APP_NOT_RUNNING', 'E_CRASH'].includes(error.data.code)
      ) {
        throw error;
      }
      // The core answered with an API error: it is running and the UI path works.
      uiCall = `home.get: ${error.data.code}`;
    }
    let firstScreen: string;
    try {
      const status = (await Promise.race([core.call('onboarding.status', {}), timeout])) as {
        state?: unknown;
      };
      firstScreen = status.state === 'committed' ? 'home' : 'onboarding';
    } catch (error) {
      if (!(error instanceof UiCallError)) throw error;
      firstScreen = `home (onboarding.status: ${error.data.code})`;
    }
    const target = run.window();
    if (target === undefined) throw new Error('no window');
    await Promise.race([target.loaded, timeout]);
    result = {
      ok: true,
      mode: verdict.mode,
      offerRebuild: verdict.offerRebuild,
      packaged: platform.packaged,
      version: platform.version,
      uiCall,
      firstScreen,
      ms: elapsed(),
    };
  } catch (error) {
    result = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ms: elapsed(),
    };
  }
  if (timer !== undefined) platform.clock.clearTimeout(timer);
  platform.log('shell.smoke', { ...result });
  try {
    await run.stop();
  } catch {
    // the result stands; finishSmoke exits either way
  }
  platform.finishSmoke(result);
}

export type { ShellInfo };
