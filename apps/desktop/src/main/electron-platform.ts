/**
 * `ShellPlatform` on real Electron. Everything Electron-specific in main is here, so the rest
 * of main is plain TypeScript tested headless (`shell.ts`).
 *
 * Construction must run before the app is ready: it applies `--profile-dir` (the
 * single-instance lock lives in `<userData>`), and registers the app scheme as privileged.
 *
 * A packaged build reads the build stamp `cc-build` wrote at its app root (inside the asar)
 * for the start check and Rebuild now; an unpackaged run has none (`start-mode.ts`).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_STAMP, readBuildStamp, rebuildNow, THEME_CSS } from '@cc/build-runtime';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  session,
  Tray,
  utilityProcess,
} from 'electron';

import {
  APP_ORIGIN,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  APP_URL,
  resolveAppRequest,
  type AppResource,
} from './app-protocol.js';
import { CONFIRM_PATH, confirmChoice, confirmPage } from './confirm-prompt.js';
import { parseShellArgs } from './args.js';
import { systemClock } from './clock.js';
import type { CoreLauncher, CoreProcess, MainPort } from './core-supervisor.js';
import { DEEP_LINK_PROTOCOL } from './deep-links.js';
import {
  CONTENT_SECURITY_POLICY,
  hardenSession,
  hardenWebContents,
  SECURE_WEB_PREFERENCES,
  type HardenableSession,
  type HardenableWebContents,
} from './hardening.js';
import type { IpcMainLike } from './ipc.js';
import type { ShownNotification } from './notifications/center.js';
import type { RebuildOutcome } from './rebuild-offer.js';
import type { ShellPlatform, ShellTray, ShellWindow, SmokeResult } from './shell.js';
import { APP_NAME, stampCheck, unpackagedCheck } from './start-mode.js';
import { trayIconBitmap, TRAY_ICON_SIZE } from './tray-icon.js';
import type { TrayMenuItem } from './tray.js';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Build layout: dist/main, dist/preload, dist/renderer, dist/core-host. */
const PRELOAD = here('../preload/index.cjs');
const RENDERER_ROOT = here('../renderer');
const CORE_HOST = here('../core-host/index.js');

const RESPONSE_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

async function respond(resource: AppResource): Promise<Response> {
  if (resource.kind === 'not-found') return new Response('not found', { status: 404 });
  const headers = { ...RESPONSE_HEADERS, 'Content-Type': resource.contentType };
  if (resource.kind === 'inline') return new Response(resource.body, { headers });
  try {
    return new Response(await readFile(resource.path), { headers });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

function toMenu(items: readonly TrayMenuItem[]): Electron.Menu {
  return Menu.buildFromTemplate(
    items.map((item) => ({
      ...(item.label === undefined ? {} : { label: item.label }),
      ...(item.type === undefined ? {} : { type: item.type }),
      ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
      ...(item.click === undefined ? {} : { click: item.click }),
    })),
  );
}

function trayImage(variant: 'normal' | 'developer'): Electron.NativeImage {
  return nativeImage.createFromBitmap(trayIconBitmap(variant), {
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE,
  });
}

export function createElectronPlatform(argv: readonly string[]): ShellPlatform {
  const args = parseShellArgs(argv.slice(1));
  // An unpackaged run has no productName; <userData> is "Command Center" either way (04 §9).
  app.setName(APP_NAME);
  app.setPath('userData', args.profileDir ?? join(app.getPath('appData'), APP_NAME));
  protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
  const userData = app.getPath('userData');

  // The build stamp and the compiled theme sit at the packaged app's root (the asar).
  const appRoot = app.getAppPath();
  const stamp = app.isPackaged ? readBuildStamp(join(appRoot, BUILD_STAMP)) : null;
  const themeFile = app.isPackaged ? join(appRoot, THEME_CSS) : undefined;

  /** Rebuild now; the shell passes the pre-update backup the core takes (04 §10 rule 2). */
  const rebuild =
    stamp === null
      ? undefined
      : async (backup: () => Promise<void>): Promise<RebuildOutcome> => {
          const result = await rebuildNow({
            stamp,
            buildsDir: join(userData, 'builds'),
            backup,
          });
          return result.ok ? { ok: true, app: result.app, log: result.log } : result;
        };

  /** `<userData>/secrets/<name>`, in a 0700 directory (04 §9 rule 1). */
  const secretPath = (name: string): string => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`not a secret name: ${name}`);
    const dir = join(userData, 'secrets');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return join(dir, name);
  };
  /** Rejects when the OS secret store cannot encrypt (04 §9 rule 1): secrets never go plain. */
  const secretStoreAvailable = async (): Promise<void> => {
    if (await safeStorage.isAsyncEncryptionAvailable()) return;
    const backend =
      process.platform === 'linux' ? ` (backend ${safeStorage.getSelectedStorageBackend()})` : '';
    throw new Error(`safeStorage is not available${backend}`);
  };
  const writeSecret = async (name: string, value: string): Promise<void> => {
    const file = secretPath(name);
    const temp = `${file}.tmp`;
    writeFileSync(temp, await safeStorage.encryptStringAsync(value), { mode: 0o600 });
    renameSync(temp, file);
    log('secrets.stored', { name });
  };

  /** The page of each open Tier H prompt, by its token (`confirm-prompt.ts`). */
  const confirmPages = new Map<string, string>();

  /** Notifications are kept referenced until closed, or their click handler is lost. */
  const live = new Set<Notification>();

  const launcher: CoreLauncher = {
    fork: (): CoreProcess =>
      utilityProcess.fork(CORE_HOST, [], {
        serviceName: 'Command Center core',
        stdio: 'inherit',
      }) as unknown as CoreProcess,
    channel: () => {
      const channel = new MessageChannelMain();
      return {
        port1: channel.port1 as unknown as MainPort,
        port2: channel.port2 as unknown as MainPort,
      };
    },
  };

  return {
    argv,
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData,
    clock: systemClock,
    ipc: ipcMain as unknown as IpcMainLike,
    launcher,
    startCheck: app.isPackaged ? stampCheck(stamp) : unpackagedCheck,
    ...(rebuild === undefined ? {} : { rebuild }),
    ...(args.smoke === true ? { smoke: true } : {}),
    secrets: {
      // The asynchronous safeStorage API: Electron 45 deprecates the synchronous one, whose
      // key is not read from the Secret Service on Linux. It decrypts what the synchronous
      // API wrote, and asks for a re-encryption when the key changed.
      read: async (name) => {
        const file = secretPath(name);
        if (!existsSync(file)) return undefined;
        await secretStoreAvailable();
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          await readFile(file),
        );
        if (shouldReEncrypt) await writeSecret(name, result);
        return result;
      },
      write: async (name, value) => {
        await secretStoreAvailable();
        await writeSecret(name, value);
      },
      remove: (name) => {
        rmSync(secretPath(name), { force: true });
        log('secrets.removed', { name });
        return Promise.resolve();
      },
    },
    refuseStart: (refusal) => {
      log('shell.refused', { code: refusal.code });
      dialog.showErrorBox(
        'Command Center cannot open its data here',
        [refusal.message, '', ...refusal.help].join('\n'),
      );
      app.exit(1);
    },
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: (listener) => {
      app.on('second-instance', (_event, secondArgv) => listener(secondArgv));
    },
    onOpenUrl: (listener) => {
      app.on('open-url', (event, url) => {
        event.preventDefault();
        listener(url);
      });
    },
    onActivate: (listener) => {
      app.on('activate', () => listener());
    },
    onWindowAllClosed: (listener) => {
      app.on('window-all-closed', () => listener());
    },
    onBeforeQuit: (listener) => {
      app.on('before-quit', (event) => listener(event));
    },
    whenReady: () => app.whenReady(),
    prepare: () => {
      const allowDevTools = !app.isPackaged;
      hardenSession(session.defaultSession as unknown as HardenableSession, {
        allowDevTools,
        onBlocked: (url) => log('hardening.request_blocked', { url: url.slice(0, 200) }),
      });
      app.on('web-contents-created', (_event, contents) =>
        hardenWebContents(contents as unknown as HardenableWebContents, (what, url) =>
          log('hardening.blocked', { what, url: url.slice(0, 200) }),
        ),
      );
      protocol.handle(APP_SCHEME, (request) =>
        respond(
          resolveAppRequest(request.url, RENDERER_ROOT, themeFile, (token) =>
            confirmPages.get(token),
          ),
        ),
      );
    },
    registerProtocolClient: () => {
      app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
    },
    createWindow: (title): ShellWindow => {
      const win = new BrowserWindow({
        title,
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
          ...SECURE_WEB_PREFERENCES,
          preload: PRELOAD,
          devTools: !app.isPackaged,
        },
      });
      // The window title is the shell's (it carries the mode label), not the page's.
      win.on('page-title-updated', (event) => event.preventDefault());
      const loaded = new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.once('closed', () => resolve());
      });
      void win.loadURL(APP_URL);
      return {
        loaded,
        isDestroyed: () => win.isDestroyed(),
        isMinimized: () => win.isMinimized(),
        restore: () => win.restore(),
        show: () => win.show(),
        focus: () => win.focus(),
        setTitle: (next) => win.setTitle(next),
        send: (channel, payload) => win.webContents.send(channel, payload),
        onClosed: (listener) => {
          win.once('closed', listener);
        },
      };
    },
    confirm: (prompt) =>
      new Promise<boolean>((resolve) => {
        // TEMPORARY (C-04-12): replaced by the foundation-owned confirm window (F2).
        const token = randomBytes(16).toString('hex');
        confirmPages.set(token, confirmPage(prompt, token));
        const win = new BrowserWindow({
          title: prompt.title,
          width: 560,
          height: 440,
          show: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          alwaysOnTop: true,
          // No preload: the page has no script and no `window.cc`.
          webPreferences: { ...SECURE_WEB_PREFERENCES, devTools: false },
        });
        let settled = false;
        const settle = (confirmed: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          confirmPages.delete(token);
          log('confirm.answered', { confirmed });
          resolve(confirmed);
          if (!win.isDestroyed()) win.close();
        };
        const timer = setTimeout(
          () => settle(false),
          Math.max(0, Date.parse(prompt.expiresAt) - Date.now()),
        );
        // The hardening blocks every navigation; in this window only, a blocked navigation to
        // one of the prompt's two links is the user's choice.
        win.webContents.on('will-navigate', (_event, url) => {
          if (!url.startsWith(`${APP_ORIGIN}${CONFIRM_PATH}`)) return;
          const choice = confirmChoice(url, token);
          if (choice !== undefined) settle(choice === 'confirm');
        });
        win.on('page-title-updated', (event) => event.preventDefault());
        win.once('ready-to-show', () => {
          win.show();
          win.focus();
        });
        win.once('closed', () => settle(false));
        void win.loadURL(`${APP_ORIGIN}${CONFIRM_PATH}${token}`);
      }),
    createTray: (): ShellTray => {
      const tray = new Tray(trayImage('normal'));
      return {
        set: (state) => {
          tray.setImage(trayImage(state.icon));
          tray.setToolTip(state.tooltip);
          tray.setContextMenu(toMenu(state.menu));
        },
        destroy: () => tray.destroy(),
      };
    },
    showNotification: (shown: ShownNotification, onClick) => {
      if (!Notification.isSupported()) {
        log('notify.unsupported');
        return;
      }
      const notification = new Notification({ title: shown.title, body: shown.body });
      live.add(notification);
      notification.on('click', () => {
        live.delete(notification);
        onClick();
      });
      notification.on('close', () => live.delete(notification));
      notification.show();
    },
    quit: () => app.quit(),
    relaunch: (executable) => {
      // The new build keeps this run's profile; a smoke flag is never carried over.
      app.relaunch({
        execPath: executable,
        args: process.argv.slice(1).filter((arg) => arg !== '--smoke'),
      });
    },
    finishSmoke: (result: SmokeResult) => {
      try {
        writeFileSync(join(userData, 'smoke.json'), `${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        log('shell.smoke_write_failed', { error: String(error) });
      }
      app.exit(result.ok ? 0 : 1);
    },
    log,
  };
}
