/**
 * Runtime hardening of the renderer (04 §3 renderer row, 04 §10 rule 5, 04 §11): context
 * isolation, the sandbox, no Node integration, a strict CSP, no remote content, window
 * opening denied, navigation blocked and every permission request denied.
 *
 * The fuses of 04 §10 rule 5 are flipped in the packaged binary by `@cc/build` (P1-16); their
 * list is `@cc/build`'s `REQUIRED_FUSES`. This module is what the running shell enforces.
 *
 * The Electron objects are reached through the small interfaces below, so tests check the
 * handlers without an Electron binary.
 */
import { APP_ORIGIN } from './app-protocol.js';

/** `webPreferences` for every window the shell opens. */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: false,
} as const;

/**
 * The renderer's CSP, sent as a response header on every app page. Scripts and styles come
 * only from the app's own origin; there is no network (`connect-src 'none'`), no framing,
 * no plugins and no inline script.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** URLs the app's sessions may load: the app's own pages, and DevTools in development. */
export function isAllowedRequestUrl(url: string, allowDevTools: boolean): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  return allowDevTools && url.startsWith('devtools://');
}

type Callback<T> = (value: T) => void;

/** The parts of `Electron.Session` the shell hardens. */
export interface HardenableSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: Callback<boolean>,
      details: unknown,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
  setDevicePermissionHandler(handler: (...args: unknown[]) => boolean): void;
  readonly webRequest: {
    onBeforeRequest(
      listener: (
        details: { readonly url: string },
        callback: Callback<{ readonly cancel: boolean }>,
      ) => void,
    ): void;
  };
}

/** Denies every permission and cancels every request that is not for the app's origin. */
export function hardenSession(
  session: HardenableSession,
  options: { readonly allowDevTools: boolean; readonly onBlocked?: (url: string) => void },
): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequestUrl(details.url, options.allowDevTools);
    if (!allowed) options.onBlocked?.(details.url);
    callback({ cancel: !allowed });
  });
}

interface PreventableEvent {
  preventDefault(): void;
}

/** The parts of `Electron.WebContents` the shell hardens. */
export interface HardenableWebContents {
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: PreventableEvent, url: string) => void): void;
  on(event: 'will-redirect', listener: (event: PreventableEvent, url: string) => void): void;
  on(event: 'will-attach-webview', listener: (event: PreventableEvent) => void): void;
}

/**
 * Blocks window opening, navigation, redirects and `<webview>` in a web contents. The app
 * is one page; moving between screens never navigates the document, and a reload is not a
 * navigation event.
 */
export function hardenWebContents(
  contents: HardenableWebContents,
  onBlocked?: (what: string, url: string) => void,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    onBlocked?.('window.open', url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    onBlocked?.('navigation', url);
  });
  contents.on('will-redirect', (event, url) => {
    event.preventDefault();
    onBlocked?.('redirect', url);
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    onBlocked?.('webview', '');
  });
}
