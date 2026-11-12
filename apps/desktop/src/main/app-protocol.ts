/**
 * The app's own origin, `cc-app://app`. The renderer is served from it, never from `file://`
 * and never from the network (04 §3 renderer row: "no remote content"; 04 §10 rule 5), so
 * the CSP header rides on every response and the page can reach no file outside the
 * renderer's build output.
 *
 * - `/` and `/index.html`: the page (`renderer-page.ts`)
 * - `/app.css`: its stylesheet
 * - `/theme.css`: the engine's compiled theme tokens, `cc-theme.css` at the packaged app's
 *   root (`cc-build` writes it); empty in an unpackaged run
 * - `/renderer/<name>.js` (and `.js.map`): the compiled renderer, from the renderer root
 *
 * Everything else is 404. The resolver is pure; `electron-platform.ts` turns its answer
 * into a `Response` inside `protocol.handle`.
 */
import path from 'node:path';

import { APP_CSS, APP_PAGE } from './renderer-page.js';

export const APP_SCHEME = 'cc-app';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

/** `protocol.registerSchemesAsPrivileged` entry: a standard, secure scheme, no fetch API. */
export const APP_SCHEME_PRIVILEGES = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
} as const;

export type AppResource =
  | { readonly kind: 'inline'; readonly body: string; readonly contentType: string }
  | { readonly kind: 'file'; readonly path: string; readonly contentType: string }
  | { readonly kind: 'not-found' };

const RENDERER_FILE = /^\/renderer\/((?:[a-z0-9-]+\/)*[a-z0-9-]+\.js(?:\.map)?)$/;

/**
 * Maps an app URL to what it serves. `rendererRoot` is the renderer's build directory;
 * `themeFile` the packaged app's compiled theme, when there is one.
 */
export function resolveAppRequest(
  url: string,
  rendererRoot: string,
  themeFile?: string,
): AppResource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'not-found' };
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST)
    return { kind: 'not-found' };
  const pathname = parsed.pathname;
  if (pathname === '/' || pathname === '/index.html') {
    return { kind: 'inline', body: APP_PAGE, contentType: 'text/html; charset=utf-8' };
  }
  if (pathname === '/app.css') {
    return { kind: 'inline', body: APP_CSS, contentType: 'text/css; charset=utf-8' };
  }
  if (pathname === '/theme.css') {
    return themeFile === undefined
      ? { kind: 'inline', body: '', contentType: 'text/css; charset=utf-8' }
      : { kind: 'file', path: themeFile, contentType: 'text/css; charset=utf-8' };
  }
  const match = RENDERER_FILE.exec(pathname);
  if (match?.[1] === undefined) return { kind: 'not-found' };
  const root = path.resolve(rendererRoot);
  const file = path.resolve(root, ...match[1].split('/'));
  if (!file.startsWith(root + path.sep)) return { kind: 'not-found' };
  const contentType = file.endsWith('.map')
    ? 'application/json; charset=utf-8'
    : 'text/javascript; charset=utf-8';
  return { kind: 'file', path: file, contentType };
}
