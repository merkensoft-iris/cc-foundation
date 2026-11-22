/**
 * The app's own origin, `cc-app://app`. The page and its UI are served from it, never from
 * `file://` and never from the network (04 §3 renderer row: "no remote content"; 04 §10 rule
 * 5), so the CSP header rides on every response and the page can reach no file outside the
 * directories below.
 *
 * - `/` and `/index.html`: the page shell (`renderer-page.ts`), main's whichever UI runs
 * - `/shell.css` and `/shell/<name>.js`: the page shell's stylesheet and script, which draw
 *   the developer-mode banner and the Rebuild now strip (`src/page-shell`)
 * - `/theme.css`: the engine's compiled theme tokens, `cc-theme.css` at the packaged app's
 *   root (`cc-build` writes it); empty in an unpackaged run
 * - `/ui/index.js` and `/ui/app.css`: the UI (ADR 0008 decision 1). When the packaged app
 *   holds the engine's own UI (`cc-ui/`, which `cc-build` bundled from its `ui/app.ts`), they
 *   are that bundle's two files and nothing else under `/ui/` exists. Otherwise they are the
 *   default UI: the compiled renderer (`/ui/<name>.js` and `.js.map`, from the renderer root)
 *   and `APP_CSS`.
 *
 * Everything else is 404. Main's own prompt windows (the confirm window and the secret prompt)
 * are on another origin, in another session (`shell-prompts.ts`). The resolver is pure;
 * `electron-platform.ts` turns its answer into a `Response` inside `protocol.handle`.
 */
import path from 'node:path';

import { ENGINE_UI_SCRIPT, ENGINE_UI_STYLES } from '@cc/build-runtime';

import { APP_CSS, APP_PAGE, SHELL_CSS } from './renderer-page.js';

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

/** A compiled module path under a root: `name.js`, `dir/name.js` or its `.map`. */
const MODULE_FILE = /^((?:[a-z0-9-]+\/)*[a-z0-9-]+\.js(?:\.map)?)$/;

/** Where the page's files come from. */
export interface AppRoots {
  /** The page shell's compiled script (`dist/page-shell`). */
  readonly shell: string;
  /** The default UI: the compiled renderer (`dist/renderer`). */
  readonly defaultUi: string;
  /** The engine's own UI in the packaged app (`<app>/cc-ui`), when its build bundled one. */
  readonly engineUi?: string;
  /** The packaged app's compiled theme, when there is one. */
  readonly themeFile?: string;
}

const CSS = 'text/css; charset=utf-8';

/** A module under `root`, never outside it, or not found. */
function moduleUnder(root: string, relative: string): AppResource {
  if (!MODULE_FILE.test(relative)) return { kind: 'not-found' };
  const base = path.resolve(root);
  const file = path.resolve(base, ...relative.split('/'));
  if (!file.startsWith(base + path.sep)) return { kind: 'not-found' };
  const contentType = file.endsWith('.map')
    ? 'application/json; charset=utf-8'
    : 'text/javascript; charset=utf-8';
  return { kind: 'file', path: file, contentType };
}

/** Maps an app URL to what it serves. */
export function resolveAppRequest(url: string, roots: AppRoots): AppResource {
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
  if (pathname === '/shell.css') return { kind: 'inline', body: SHELL_CSS, contentType: CSS };
  if (pathname === '/theme.css') {
    return roots.themeFile === undefined
      ? { kind: 'inline', body: '', contentType: CSS }
      : { kind: 'file', path: roots.themeFile, contentType: CSS };
  }
  if (pathname.startsWith('/shell/')) return moduleUnder(roots.shell, pathname.slice(7));
  if (!pathname.startsWith('/ui/')) return { kind: 'not-found' };
  const name = pathname.slice(4);
  if (roots.engineUi !== undefined) {
    if (name === ENGINE_UI_STYLES) {
      return { kind: 'file', path: path.join(roots.engineUi, ENGINE_UI_STYLES), contentType: CSS };
    }
    return name === ENGINE_UI_SCRIPT ? moduleUnder(roots.engineUi, name) : { kind: 'not-found' };
  }
  if (name === 'app.css') return { kind: 'inline', body: APP_CSS, contentType: CSS };
  return moduleUnder(roots.defaultUi, name);
}
