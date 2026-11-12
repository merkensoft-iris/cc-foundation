import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_URL, resolveAppRequest } from '../src/main/app-protocol.js';
import {
  CONTENT_SECURITY_POLICY,
  hardenSession,
  hardenWebContents,
  isAllowedRequestUrl,
  SECURE_WEB_PREFERENCES,
  type HardenableSession,
  type HardenableWebContents,
} from '../src/main/hardening.js';
import { APP_PAGE } from '../src/main/renderer-page.js';

describe('renderer hardening (04 §3, 04 §10 rule 5)', () => {
  it('runs every window isolated and sandboxed, without Node', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });

  it('sends a strict CSP: own origin only, no network, no inline script', () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split('; ').map((directive) => {
        const [name = '', ...values] = directive.split(' ');
        return [name, values.join(' ')];
      }),
    );
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe("'none'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    // The page has no inline script for the CSP to forbid.
    expect(APP_PAGE).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('denies every permission and cancels every request outside the app origin', () => {
    const handlers: {
      request?: (wc: unknown, permission: string, cb: (ok: boolean) => void, d: unknown) => void;
      check?: (...args: unknown[]) => boolean;
      device?: (...args: unknown[]) => boolean;
      before?: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void;
    } = {};
    const session: HardenableSession = {
      setPermissionRequestHandler: (handler) => (handlers.request = handler),
      setPermissionCheckHandler: (handler) => (handlers.check = handler),
      setDevicePermissionHandler: (handler) => (handlers.device = handler),
      webRequest: { onBeforeRequest: (listener) => (handlers.before = listener) },
    };
    const blocked: string[] = [];
    hardenSession(session, { allowDevTools: false, onBlocked: (url) => blocked.push(url) });

    for (const permission of ['notifications', 'media', 'geolocation', 'clipboard-read']) {
      let granted: boolean | undefined;
      handlers.request?.({}, permission, (ok) => (granted = ok), {});
      expect(granted, permission).toBe(false);
    }
    expect(handlers.check?.()).toBe(false);
    expect(handlers.device?.()).toBe(false);

    const cancelled = (url: string) => {
      let result: boolean | undefined;
      handlers.before?.({ url }, ({ cancel }) => (result = cancel));
      return result;
    };
    expect(cancelled(`${APP_URL}renderer/index.js`)).toBe(false);
    expect(cancelled('https://example.invalid/x.js')).toBe(true);
    expect(cancelled('file:///etc/passwd')).toBe(true);
    expect(cancelled('devtools://devtools/bundled/x')).toBe(true);
    expect(blocked).toHaveLength(3);
    expect(isAllowedRequestUrl('devtools://devtools/bundled/x', true)).toBe(true);
  });

  it('blocks window.open, navigation, redirects and webviews', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const contents = {
      setWindowOpenHandler: (handler: typeof openHandler) => (openHandler = handler),
      on: (event: string, listener: (event: { preventDefault(): void }, url: string) => void) =>
        listeners.set(event, listener),
    } as unknown as HardenableWebContents;
    const blocked: string[] = [];
    hardenWebContents(contents, (what) => blocked.push(what));

    expect(openHandler?.({ url: 'https://example.invalid' })).toEqual({ action: 'deny' });
    for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
      let prevented = false;
      listeners.get(event)?.({ preventDefault: () => (prevented = true) }, 'https://x.invalid');
      expect(prevented, event).toBe(true);
    }
    expect(blocked).toEqual(['window.open', 'navigation', 'redirect', 'webview']);
  });
});

describe('the app origin cc-app://app', () => {
  const root = path.resolve('/opt/cc/dist/renderer');

  it('serves the page, its stylesheet and the renderer build', () => {
    expect(resolveAppRequest('cc-app://app/', root)).toMatchObject({
      kind: 'inline',
      contentType: 'text/html; charset=utf-8',
    });
    expect(resolveAppRequest('cc-app://app/app.css', root)).toMatchObject({ kind: 'inline' });
    // The engine's compiled theme: from the packaged app, empty in an unpackaged run.
    expect(resolveAppRequest('cc-app://app/theme.css', root)).toEqual({
      kind: 'inline',
      body: '',
      contentType: 'text/css; charset=utf-8',
    });
    expect(
      resolveAppRequest('cc-app://app/theme.css', root, '/opt/cc/app.asar/cc-theme.css'),
    ).toEqual({
      kind: 'file',
      path: '/opt/cc/app.asar/cc-theme.css',
      contentType: 'text/css; charset=utf-8',
    });
    expect(resolveAppRequest('cc-app://app/renderer/index.js', root)).toEqual({
      kind: 'file',
      path: path.join(root, 'index.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(resolveAppRequest('cc-app://app/renderer/screens/home.js.map', root)).toMatchObject({
      kind: 'file',
      path: path.join(root, 'screens', 'home.js.map'),
    });
  });

  it('serves nothing outside the renderer build', () => {
    for (const url of [
      'cc-app://app/renderer/../main/index.js',
      'cc-app://app/renderer/%2e%2e/main/index.js',
      'cc-app://app/renderer/..%2fmain/index.js',
      'cc-app://app/renderer/index.ts',
      'cc-app://app/main/index.js',
      'cc-app://app/renderer/',
      'cc-app://other/renderer/index.js',
      'https://app/renderer/index.js',
      'not a url',
    ]) {
      expect(resolveAppRequest(url, root), url).toEqual({ kind: 'not-found' });
    }
  });
});
