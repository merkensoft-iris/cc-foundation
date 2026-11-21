/**
 * Main's own windows for what the app page must never do itself (04 §4.3 rule 4, C-04-12;
 * 04 §9.1 rule 3): the **confirm window**, where the user confirms a Tier H operation, and the
 * **secret prompt**, where the user types the backup passphrase (and, later, other secrets).
 *
 * Whatever code runs in the app page acts as the user, so neither may be drawn by that page:
 *
 * - Each prompt is a separate `BrowserWindow` on its own origin, `cc-confirm://shell`, in its own
 *   in-memory session (`PROMPT_PARTITION`). The app window cannot load, frame, fetch or open
 *   that origin: its session does not even know the scheme.
 * - The page is the foundation's (`promptPage`), with the app's CSP, no inline script, the
 *   foundation's script `/prompt.js` (`src/prompt-page/index.ts`) and a stylesheet that reads
 *   only the theme tokens (owner decision Q9 still holds here).
 * - Its preload exposes two functions and nothing else: `approve(id)` and `deny(id)` for the
 *   confirm window (`src/preload/confirm.cts`), `submit(id, value)` and `cancel(id)` for the
 *   secret prompt (`src/preload/secret.cts`). `id` is the prompt's token, 128 random bits main
 *   writes into that page only.
 * - Main accepts an answer only from the web contents of the window it opened for that token,
 *   from its top frame on the prompt origin. A page that looks like a prompt anywhere else,
 *   the app page included, cannot answer anything.
 *
 * The confirm window shows the preview the core wrote from the canonical payload, never text
 * the app page sent. It closes unconfirmed when the intent expires, when it is closed, and on
 * Cancel. One confirm window is open at a time; a `commandcenter://confirmations/<id>` link
 * for its intent brings it to the front (`show`).
 *
 * Playwright drives these windows like any window, so the app's end-to-end flows click
 * Confirm here: there is no test hook (AGENTS rule 4).
 */
import { randomBytes } from 'node:crypto';

import type { ConfirmationIntent } from '../shared/protocol.js';
import type { Clock, TimerHandle } from './clock.js';
import type { InvokeEvent } from './ipc.js';

export const PROMPT_SCHEME = 'cc-confirm';
export const PROMPT_HOST = 'shell';
export const PROMPT_ORIGIN = `${PROMPT_SCHEME}://${PROMPT_HOST}`;
/** The prompts' own in-memory session: nothing in it is shared with the app window's. */
export const PROMPT_PARTITION = 'cc-confirm';

/** `protocol.registerSchemesAsPrivileged` entry: a standard, secure scheme, no fetch API. */
export const PROMPT_SCHEME_PRIVILEGES = {
  scheme: PROMPT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
} as const;

/** prompt preload → main. The same strings as `src/preload/confirm.cts` and `secret.cts`. */
export const CONFIRM_ANSWER_CHANNEL = 'cc-confirm:answer';
export const SECRET_ANSWER_CHANNEL = 'cc-secret:answer';

export const PROMPT_PAGE_PATH = '/p/';
export const PROMPT_SCRIPT_PATH = '/prompt.js';
export const PROMPT_CSS_PATH = '/prompt.css';
/** 128 random bits, hex. */
export const PROMPT_TOKEN = /^[0-9a-f]{32}$/;

export type PromptKind = 'confirm' | 'secret';

/** What the platform needs to open one prompt window. */
export interface PromptWindowSpec {
  readonly kind: PromptKind;
  readonly token: string;
  readonly title: string;
  /** The page, served at `promptUrl(token)` while the window is open. */
  readonly page: string;
  readonly width: number;
  readonly height: number;
}

/** One open prompt window. */
export interface PromptWindow {
  /** The id of its web contents: answers are accepted only from it. */
  readonly senderId: number;
  isDestroyed(): boolean;
  /** Brings it to the front. */
  focus(): void;
  close(): void;
  onClosed(listener: () => void): void;
}

/** What the confirm window shows. */
export interface ConfirmPrompt {
  readonly title: string;
  /** The core's preview, shown exactly. */
  readonly preview: string;
  /** The window closes, unconfirmed, at this instant. */
  readonly expiresAt: string;
}

/** What the secret prompt asks for. */
export interface SecretPrompt {
  readonly title: string;
  /** Why it is asked and what happens to it. */
  readonly lead: string;
  readonly label: string;
  readonly submit: string;
  readonly minLength: number;
}

/** The backup passphrase (01 §3.1 row 9, 04 §9.1 rule 3). */
export const BACKUP_PASSPHRASE_PROMPT: SecretPrompt = {
  title: 'Backup password',
  lead: 'This password locks every backup. Command Center cannot recover a lost one, so keep it somewhere safe. It goes to the system keychain from this window; the app’s screens never see it.',
  label: 'Password',
  submit: 'Set password',
  minLength: 12,
};

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

export function promptUrl(token: string): string {
  return `${PROMPT_ORIGIN}${PROMPT_PAGE_PATH}${token}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** "05:35 UTC". */
function clockTime(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? instant : `${parsed.toISOString().slice(11, 16)} UTC`;
}

function head(title: string): string {
  return `<head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="${PROMPT_CSS_PATH}" />
    <script type="module" src="${PROMPT_SCRIPT_PATH}"></script>
  </head>`;
}

/** The confirm window's page: the core's preview, Cancel and Confirm. */
export function confirmPage(prompt: ConfirmPrompt, token: string): string {
  return `<!doctype html>
<html lang="en">
  ${head(prompt.title)}
  <body data-kind="confirm" data-prompt="${token}">
    <main>
      <h1 data-test="confirm-title">${escapeHtml(prompt.title)}</h1>
      <p class="lead">Command Center needs you to confirm this. Only this window can confirm it; the app’s screens cannot.</p>
      <pre data-test="confirm-preview">${escapeHtml(prompt.preview)}</pre>
      <p class="muted" data-test="confirm-expires">If you do nothing, it closes unconfirmed at ${escapeHtml(clockTime(prompt.expiresAt))}.</p>
      <div class="buttons">
        <button type="button" id="deny" data-test="confirm-cancel">Cancel</button>
        <button type="button" id="approve" class="primary" data-test="confirm-approve">Confirm</button>
      </div>
    </main>
  </body>
</html>
`;
}

/** The secret prompt's page: the secret typed twice, Cancel and the submit button. */
export function secretPage(prompt: SecretPrompt, token: string): string {
  return `<!doctype html>
<html lang="en">
  ${head(prompt.title)}
  <body data-kind="secret" data-prompt="${token}" data-min="${String(prompt.minLength)}">
    <main>
      <h1 data-test="secret-title">${escapeHtml(prompt.title)}</h1>
      <p class="lead">${escapeHtml(prompt.lead)}</p>
      <form id="secret-form" novalidate>
        <label>${escapeHtml(prompt.label)}
          <input id="secret" type="password" autocomplete="new-password" data-test="secret-value" />
        </label>
        <label>Type it again
          <input id="secret-again" type="password" autocomplete="new-password" data-test="secret-again" />
        </label>
        <p class="muted">At least ${String(prompt.minLength)} characters.</p>
        <p id="secret-error" class="error" role="alert" data-test="secret-error" hidden></p>
        <div class="buttons">
          <button type="button" id="cancel" data-test="secret-cancel">Cancel</button>
          <button type="submit" class="primary" data-test="secret-submit">${escapeHtml(prompt.submit)}</button>
        </div>
      </form>
    </main>
  </body>
</html>
`;
}

/** The prompts' stylesheet: the theme tokens of `/theme.css`, with system fallbacks, only. */
export const PROMPT_CSS = `:root {
  color-scheme: light dark;
}
body {
  margin: 0;
  font-family: var(--cc-font-body, system-ui, sans-serif);
  background: var(--cc-color-background, Canvas);
  color: var(--cc-color-text, CanvasText);
}
main {
  padding: 24px;
}
h1 {
  font-family: var(--cc-font-heading, inherit);
  font-size: 1.25rem;
  margin: 0 0 8px;
}
.lead {
  margin: 0 0 16px;
}
.muted {
  color: var(--cc-color-text-muted, GrayText);
  font-size: 0.9rem;
}
pre {
  white-space: pre-wrap;
  font: inherit;
  margin: 0;
  padding: 12px;
  background: var(--cc-color-surface, Canvas);
  border: 1px solid var(--cc-color-border, GrayText);
  border-radius: var(--cc-radius-small, 6px);
}
label {
  display: grid;
  gap: 4px;
  margin: 0 0 12px;
}
input {
  font: inherit;
  padding: 6px 8px;
  color: inherit;
  background: var(--cc-color-surface, Field);
  border: 1px solid var(--cc-color-border, GrayText);
  border-radius: var(--cc-radius-small, 6px);
}
.error {
  color: var(--cc-color-danger, #b3261e);
}
.buttons {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 16px;
}
button {
  font: inherit;
  padding: 8px 16px;
  color: inherit;
  background: var(--cc-color-surface, ButtonFace);
  border: 1px solid var(--cc-color-border, GrayText);
  border-radius: var(--cc-radius-small, 6px);
  cursor: pointer;
}
button.primary {
  background: var(--cc-color-accent, #2f5bd3);
  border-color: var(--cc-color-accent, #2f5bd3);
  color: var(--cc-color-accent-text, #ffffff);
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
`;

export type PromptResource =
  | { readonly kind: 'inline'; readonly body: string; readonly contentType: string }
  | { readonly kind: 'file'; readonly path: string; readonly contentType: string }
  | { readonly kind: 'not-found' };

/**
 * Maps a prompt URL to what it serves: `/p/<token>` (the page of an open prompt), `/prompt.js`
 * (the foundation's page script, `scriptFile`), `/prompt.css` and `/theme.css` (the engine's
 * compiled tokens, empty in an unpackaged run). Everything else is 404.
 */
export function resolvePromptRequest(
  url: string,
  options: {
    readonly page: (token: string) => string | undefined;
    readonly scriptFile: string;
    readonly themeFile?: string | undefined;
  },
): PromptResource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'not-found' };
  }
  if (parsed.protocol !== `${PROMPT_SCHEME}:` || parsed.host !== PROMPT_HOST) {
    return { kind: 'not-found' };
  }
  const pathname = parsed.pathname;
  if (pathname === PROMPT_SCRIPT_PATH) {
    return {
      kind: 'file',
      path: options.scriptFile,
      contentType: 'text/javascript; charset=utf-8',
    };
  }
  if (pathname === PROMPT_CSS_PATH) {
    return { kind: 'inline', body: PROMPT_CSS, contentType: 'text/css; charset=utf-8' };
  }
  if (pathname === '/theme.css') {
    return options.themeFile === undefined
      ? { kind: 'inline', body: '', contentType: 'text/css; charset=utf-8' }
      : { kind: 'file', path: options.themeFile, contentType: 'text/css; charset=utf-8' };
  }
  if (pathname.startsWith(PROMPT_PAGE_PATH)) {
    const token = pathname.slice(PROMPT_PAGE_PATH.length);
    const page = PROMPT_TOKEN.test(token) ? options.page(token) : undefined;
    return page === undefined
      ? { kind: 'not-found' }
      : { kind: 'inline', body: page, contentType: 'text/html; charset=utf-8' };
  }
  return { kind: 'not-found' };
}

export interface ShellPromptsOptions {
  /** Opens a prompt window (`ShellPlatform.openPrompt`). */
  readonly open: (spec: PromptWindowSpec) => PromptWindow;
  readonly clock: Clock;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface OpenPrompt {
  readonly kind: PromptKind;
  readonly window: PromptWindow;
  /** The intent a confirm window is for. */
  readonly intentId?: string;
  readonly settle: (answer: Answer) => void;
}

type Answer =
  | { readonly kind: 'approve' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'secret'; readonly value: string };

/** The prompt windows main has open, and the answers it accepts from them. */
export class ShellPrompts {
  readonly #options: ShellPromptsOptions;
  readonly #open = new Map<string, OpenPrompt>();

  constructor(options: ShellPromptsOptions) {
    this.#options = options;
  }

  /**
   * Asks the user to confirm a Tier H intent in the confirm window; true when they chose
   * Confirm before it expired. While one confirm window is open, another is not opened and the
   * call is not confirmed.
   */
  confirm(intent: ConfirmationIntent): Promise<boolean> {
    if (this.#busy('confirm')) {
      this.#options.log?.('prompt.busy', { kind: 'confirm' });
      return Promise.resolve(false);
    }
    const prompt = confirmPromptOf(intent);
    const delay = Math.max(0, Date.parse(prompt.expiresAt) - this.#options.clock.now().getTime());
    return this.#ask('confirm', prompt.title, (token) => confirmPage(prompt, token), {
      intentId: intent.id,
      expiresInMs: Number.isNaN(delay) ? 0 : delay,
      size: { width: 560, height: 440 },
    }).then((answer) => answer?.kind === 'approve');
  }

  /**
   * Asks for a secret in the secret prompt; the value, or `undefined` when the user cancelled.
   * One at a time.
   */
  secret(prompt: SecretPrompt): Promise<string | undefined> {
    if (this.#busy('secret')) {
      this.#options.log?.('prompt.busy', { kind: 'secret' });
      this.#focus('secret');
      return Promise.resolve(undefined);
    }
    return this.#ask('secret', prompt.title, (token) => secretPage(prompt, token), {
      size: { width: 520, height: 480 },
    }).then((answer) => (answer?.kind === 'secret' ? answer.value : undefined));
  }

  /** Brings the confirm window of `intentId` to the front; false when none is open for it. */
  show(intentId: string): boolean {
    for (const prompt of this.#open.values()) {
      if (prompt.kind === 'confirm' && prompt.intentId === intentId) {
        prompt.window.focus();
        return true;
      }
    }
    return false;
  }

  /** `approve(id)` / `deny(id)` from the confirm window's preload. */
  answerConfirm(event: InvokeEvent, token: unknown, choice: unknown): boolean {
    if (choice !== 'approve' && choice !== 'deny') return false;
    const prompt = this.#from(event, 'confirm', token);
    if (prompt === undefined) return false;
    prompt.settle({ kind: choice });
    return true;
  }

  /** `submit(id, value)` / `cancel(id)` from the secret prompt's preload. */
  answerSecret(event: InvokeEvent, token: unknown, value: unknown): boolean {
    if (value !== null && typeof value !== 'string') return false;
    const prompt = this.#from(event, 'secret', token);
    if (prompt === undefined) return false;
    prompt.settle(value === null ? { kind: 'deny' } : { kind: 'secret', value });
    return true;
  }

  /** Closes every prompt unanswered (quit). */
  closeAll(): void {
    for (const prompt of [...this.#open.values()]) prompt.settle({ kind: 'deny' });
  }

  #busy(kind: PromptKind): boolean {
    return [...this.#open.values()].some((prompt) => prompt.kind === kind);
  }

  #focus(kind: PromptKind): void {
    for (const prompt of this.#open.values()) if (prompt.kind === kind) prompt.window.focus();
  }

  /** The open prompt this answer may settle: its own window, top frame, prompt origin. */
  #from(event: InvokeEvent, kind: PromptKind, token: unknown): OpenPrompt | undefined {
    if (typeof token !== 'string') return undefined;
    const prompt = this.#open.get(token);
    const frame = event.senderFrame;
    const ok =
      prompt !== undefined &&
      prompt.kind === kind &&
      event.sender?.id === prompt.window.senderId &&
      frame !== null &&
      frame.parent === null &&
      frame.url === promptUrl(token);
    if (!ok) {
      this.#options.log?.('prompt.answer_refused', { kind, url: frame?.url.slice(0, 200) ?? null });
      return undefined;
    }
    return prompt;
  }

  #ask(
    kind: PromptKind,
    title: string,
    page: (token: string) => string,
    options: {
      readonly intentId?: string;
      readonly expiresInMs?: number;
      readonly size: { readonly width: number; readonly height: number };
    },
  ): Promise<Answer | undefined> {
    const token = randomBytes(16).toString('hex');
    const html = page(token);
    return new Promise((resolve) => {
      let settled = false;
      let timer: TimerHandle | undefined;
      const window = this.#options.open({ kind, token, title, page: html, ...options.size });
      const settle = (answer: Answer | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#options.clock.clearTimeout(timer);
        this.#open.delete(token);
        this.#options.log?.('prompt.answered', {
          kind,
          answer: answer === undefined ? 'closed' : answer.kind === 'secret' ? 'set' : answer.kind,
        });
        resolve(answer);
        if (!window.isDestroyed()) window.close();
      };
      this.#open.set(token, {
        kind,
        window,
        ...(options.intentId === undefined ? {} : { intentId: options.intentId }),
        settle,
      });
      if (options.expiresInMs !== undefined) {
        timer = this.#options.clock.setTimeout(() => settle(undefined), options.expiresInMs);
      }
      window.onClosed(() => settle(undefined));
    });
  }
}
