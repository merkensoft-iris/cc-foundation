/**
 * TEMPORARY: the minimal prompt in which the user confirms a Tier H operation (04 §4.3 rule 4,
 * C-04-12) until the foundation-owned confirm window replaces it (the next step of the
 * UI-to-engine plan, F2: its own origin, a two-function preload, token styling, the secure
 * passphrase prompt and the folder picker).
 *
 * Main opens it in a window of its own, with no preload, served by the app protocol at
 * `cc-app://app/confirm/<token>` while the prompt is open (`<token>` is 128 random bits main
 * never gives the renderer). It shows the preview the core wrote and two links. The page has
 * no script: choosing a link is a navigation, which the hardening blocks for every window, and
 * main reads the choice from that blocked navigation in the prompt window only. So the app
 * window cannot answer it: it never learns the token, cannot navigate, frame or open windows,
 * and a navigation in any other window is not read as a choice.
 *
 * Playwright drives this window as a user would, so the app's end-to-end flows click Confirm
 * here: there is no test hook (AGENTS rule 4).
 */
import type { ConfirmationIntent } from '../shared/protocol.js';

export const CONFIRM_PATH = '/confirm/';
export const CONFIRM_CSS_PATH = '/confirm.css';
/** 128 random bits, hex. */
export const CONFIRM_TOKEN = /^[0-9a-f]{32}$/;

/** What the prompt shows. */
export interface ConfirmPrompt {
  readonly title: string;
  /** The core's preview, shown exactly. */
  readonly preview: string;
  /** The prompt closes, unconfirmed, when the intent expires. */
  readonly expiresAt: string;
}

const TITLES: Readonly<Record<string, string>> = {
  'principals.create': 'Add agent access',
  'principals.update': 'Change agent access',
  'principals.revoke': 'Remove access',
  'backups.restore': 'Restore from a backup',
};

export function confirmPromptOf(intent: ConfirmationIntent): ConfirmPrompt {
  return {
    title: TITLES[intent.method] ?? 'Confirm this change',
    preview: intent.preview,
    expiresAt: intent.expiresAt,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The prompt page: no script, the app's CSP, the theme tokens and a small stylesheet. */
export function confirmPage(prompt: ConfirmPrompt, token: string): string {
  const base = `${CONFIRM_PATH}${token}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(prompt.title)}</title>
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="${CONFIRM_CSS_PATH}" />
  </head>
  <body>
    <main>
      <h1 data-test="confirm-title">${escapeHtml(prompt.title)}</h1>
      <p class="lead">Command Center needs you to confirm this. Only this window can confirm it.</p>
      <pre data-test="confirm-preview">${escapeHtml(prompt.preview)}</pre>
      <nav>
        <a data-test="confirm-cancel" href="${base}/cancel">Cancel</a>
        <a data-test="confirm-approve" class="primary" href="${base}/confirm">Confirm</a>
      </nav>
    </main>
  </body>
</html>
`;
}

export const CONFIRM_CSS = `body {
  margin: 0;
  font-family: var(--cc-font-body, system-ui, sans-serif);
  background: var(--cc-color-background, #ffffff);
  color: var(--cc-color-text, #1b1b1f);
}
main { padding: 24px; }
h1 { font-size: 1.25rem; margin: 0 0 8px; }
.lead { margin: 0 0 16px; }
pre {
  white-space: pre-wrap;
  font: inherit;
  padding: 12px;
  border: 1px solid var(--cc-color-border, #c9c9d1);
  border-radius: var(--cc-radius-small, 6px);
}
nav { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
nav a {
  padding: 8px 16px;
  border: 1px solid var(--cc-color-border, #c9c9d1);
  border-radius: var(--cc-radius-small, 6px);
  color: inherit;
  text-decoration: none;
}
nav a.primary {
  background: var(--cc-color-accent, #2f5bd3);
  border-color: var(--cc-color-accent, #2f5bd3);
  color: var(--cc-color-accent-text, #ffffff);
}
`;

/**
 * The choice a blocked navigation in the prompt window carries, if it is one. The caller checks
 * that the URL is on the app's origin.
 */
export function confirmChoice(url: string, token: string): 'confirm' | 'cancel' | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.search !== '' || parsed.hash !== '') return undefined;
  if (parsed.pathname === `${CONFIRM_PATH}${token}/confirm`) return 'confirm';
  if (parsed.pathname === `${CONFIRM_PATH}${token}/cancel`) return 'cancel';
  return undefined;
}

/** The token of a prompt page URL path (`/confirm/<token>`), if it is one. */
export function confirmTokenOf(pathname: string): string | undefined {
  if (!pathname.startsWith(CONFIRM_PATH)) return undefined;
  const token = pathname.slice(CONFIRM_PATH.length);
  return CONFIRM_TOKEN.test(token) ? token : undefined;
}
