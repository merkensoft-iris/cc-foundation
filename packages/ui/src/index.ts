/// <reference lib="dom" />
/**
 * `@cc/ui`, the default UI (04 §3; ADR 0008 decision 1): sandboxed, no Node, no network; it
 * reaches the app only through `window.cc` (rule D3). Main serves this entry as
 * `/ui/index.js`, unbundled, when the engine has no UI of its own. It shows the screens of
 * 09 P1-11 (`app/app.ts`), opening the screen a `commandcenter://` link names; the start mode
 * and the Rebuild now strip are the page shell's (`apps/desktop/src/page-shell`). It runs only
 * on a shell that speaks its `window.cc` API version (`app/api-version.ts`).
 *
 * An engine's `ui/app.ts` composes the same UI through `@cc/ui/v1` (`v1.ts`).
 */
import { createApp } from './app/create-app.js';

export const PROCESS = 'renderer';

void createApp().start();
