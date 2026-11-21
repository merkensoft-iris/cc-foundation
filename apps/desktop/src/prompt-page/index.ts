/// <reference lib="dom" />
/**
 * The script of main's prompt windows (`src/main/shell-prompts.ts`), served as
 * `cc-confirm://shell/prompt.js`. It wires the page's buttons to the window's preload: Confirm
 * and Cancel to `window.ccConfirm`, the secret form to `window.ccSecret`. It loads nothing,
 * imports nothing at run time and has no network (the CSP of every app page).
 */
import type { CcConfirmBridge, CcSecretBridge } from './bridge.js';

declare global {
  interface Window {
    readonly ccConfirm?: CcConfirmBridge;
    readonly ccSecret?: CcSecretBridge;
  }
}

/** Why a typed secret cannot be used, or `undefined` when it can. */
export function secretProblem(value: string, again: string, minLength: number): string | undefined {
  if (value.length < minLength) return `It needs at least ${String(minLength)} characters.`;
  if (value !== again) return 'The two entries differ.';
  return undefined;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function disableButtons(): void {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
}

function wireConfirm(id: string, bridge: CcConfirmBridge): void {
  const answer = (choice: 'approve' | 'deny') => {
    disableButtons();
    void (choice === 'approve' ? bridge.approve(id) : bridge.deny(id));
  };
  byId('approve')?.addEventListener('click', () => answer('approve'));
  byId('deny')?.addEventListener('click', () => answer('deny'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') answer('deny');
  });
  byId('deny')?.focus();
}

function wireSecret(id: string, bridge: CcSecretBridge, minLength: number): void {
  const form = byId<HTMLFormElement>('secret-form');
  const value = byId<HTMLInputElement>('secret');
  const again = byId<HTMLInputElement>('secret-again');
  const error = byId('secret-error');
  if (form === null || value === null || again === null || error === null) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const problem = secretProblem(value.value, again.value, minLength);
    if (problem !== undefined) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    disableButtons();
    const secret = value.value;
    value.value = '';
    again.value = '';
    void bridge.submit(id, secret);
  });
  const cancel = () => {
    disableButtons();
    void bridge.cancel(id);
  };
  byId('cancel')?.addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
  });
  value.focus();
}

function start(): void {
  const { kind, prompt, min } = document.body.dataset;
  if (prompt === undefined) return;
  if (kind === 'confirm' && window.ccConfirm !== undefined) wireConfirm(prompt, window.ccConfirm);
  if (kind === 'secret' && window.ccSecret !== undefined) {
    wireSecret(prompt, window.ccSecret, Number(min ?? '0'));
  }
}

// A module script runs after the document is parsed. Tests import `secretProblem` under Node,
// where there is no document.
if (typeof document !== 'undefined') start();
