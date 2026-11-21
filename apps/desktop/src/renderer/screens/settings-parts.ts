/**
 * The parts every Settings page is built from (09 P1-11): a card of rows on one fixed grid
 * (label and help | value or control | action), an Advanced panel at the bottom of a card, the
 * inline confirmation that hard-to-undo and high-risk actions take, status pills, labelled
 * inputs that sit on the row grid, and a command box with a Copy button.
 *
 * The layout is the foundation's; an engine changes only the theme tokens (owner decision Q9).
 */
import type { Ui } from '../app/screen.js';
import { button } from '../ui/parts.js';
import { h, type Child, type VNode } from '../ui/vnode.js';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** A status in words with a coloured dot; always in a row's value column. */
export function pill(text: string, tone: Tone, test?: string): VNode {
  return h('span', { class: `pill ${tone}`, ...(test === undefined ? {} : { test }) }, text);
}

/** A small label beside a value, such as a permission set's name. */
export function tag(text: string, tone: 'neutral' | 'warn' = 'neutral', test?: string): VNode {
  return h('span', { class: `tag ${tone}`, ...(test === undefined ? {} : { test }) }, text);
}

/** The page heading and its one-line description. */
export function pageHead(title: string, description: string): VNode {
  return h(
    'div',
    { class: 'settings-head' },
    h('h2', null, title),
    h('p', { class: 'muted' }, description),
  );
}

/** A group of rows (and optionally an Advanced panel) on one surface. */
export function card(test: string | null, ...children: Child[]): VNode {
  return h('div', { class: 'set-card', ...(test === null ? {} : { test }) }, ...children);
}

/**
 * One settings row on the fixed grid. `below` spans all three columns under the row, for an
 * inline confirmation or a form that opened from the row's action.
 */
export function row(options: {
  readonly label: Child;
  readonly help?: Child;
  readonly value?: Child;
  readonly action?: Child;
  readonly below?: Child;
  readonly test?: string;
}): VNode {
  return h(
    'div',
    { class: 'set-row', ...(options.test === undefined ? {} : { test: options.test }) },
    h(
      'div',
      { class: 'set-label' },
      h('strong', null, options.label),
      options.help === undefined ? null : h('span', null, options.help),
    ),
    h('div', { class: 'set-value' }, options.value ?? null),
    h('div', { class: 'set-action' }, options.action ?? null),
    options.below === undefined || options.below === null || options.below === false
      ? null
      : h('div', { class: 'set-below' }, options.below),
  );
}

/**
 * The Advanced panel at the bottom of a section's card (progressive disclosure): closed by
 * default, one click away, never removed. Its open state is kept for the window, so a reload
 * after an action keeps it open.
 */
export function advanced(
  options: {
    readonly test: string;
    readonly title: string;
    readonly summary: string;
    readonly open: boolean;
    readonly toggle: () => void;
  },
  body: () => Child[],
): VNode {
  return h(
    'div',
    { class: options.open ? 'advanced open' : 'advanced' },
    h(
      'button',
      {
        type: 'button',
        class: 'advanced-toggle',
        test: `${options.test}-toggle`,
        'aria-expanded': options.open ? 'true' : 'false',
        onClick: options.toggle,
      },
      h(
        'span',
        { class: 'advanced-title' },
        h('strong', null, options.title),
        h('span', null, options.summary),
      ),
      h('span', { class: 'advanced-state' }, options.open ? 'Hide' : 'Show'),
    ),
    options.open ? h('div', { class: 'advanced-body', test: options.test }, ...body()) : null,
  );
}

/**
 * The inline explanation of a hard-to-undo or high-risk action (Remove access, Restore, a
 * high-risk permission). Nothing is called until the second click; Cancel closes it. It is not
 * the confirmation: those actions are Tier H, and the app shell's confirm window confirms them
 * after it (C-04-12).
 */
export function confirmPanel(options: {
  readonly test: string;
  readonly question: string;
  readonly detail: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly confirmTest: string;
  readonly cancelTest: string;
  readonly danger?: boolean;
}): VNode {
  return h(
    'div',
    { class: 'confirm', role: 'alertdialog', 'aria-label': options.question, test: options.test },
    h('p', null, h('strong', null, options.question), ' ', options.detail),
    h(
      'div',
      { class: 'confirm-buttons' },
      h(
        'button',
        {
          type: 'button',
          class: options.danger === true ? 'danger' : 'primary',
          test: options.confirmTest,
          onClick: options.onConfirm,
        },
        options.confirm,
      ),
      button('Cancel', options.onCancel, { test: options.cancelTest }),
    ),
  );
}

/** A labelled text or password input that sits on the row grid: the label beside the box. */
export function input(
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { test?: string; type?: string; placeholder?: string } = {},
): VNode {
  return h(
    'label',
    { class: 'set-field' },
    h('span', null, label),
    h('input', {
      value,
      onInput,
      type: options.type ?? 'text',
      'aria-label': label,
      ...(options.test === undefined ? {} : { test: options.test }),
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    }),
  );
}

/** A labelled select that sits on the row grid, the same height as an input. */
export function choice<V extends string>(
  label: string,
  value: V,
  options: readonly { readonly value: V; readonly label: string }[],
  onInput: (value: V) => void,
  test?: string,
): VNode {
  return h(
    'label',
    { class: 'set-field' },
    h('span', null, label),
    h(
      'select',
      {
        value,
        // The select yields only its options' values.
        onInput: (chosen: string) => onInput(chosen as V),
        'aria-label': label,
        ...(test === undefined ? {} : { test }),
      },
      options.map((option) => h('option', { value: option.value }, option.label)),
    ),
  );
}

/** Inputs stacked in a row's value column, their labels and boxes aligned. */
export function fields(...children: Child[]): VNode {
  return h('div', { class: 'set-fields' }, ...children);
}

/**
 * A command to paste elsewhere: one line that scrolls sideways and never breaks mid-word, and
 * a Copy button.
 */
export function copyBox(text: string, ui: Ui, test: string, copyTest: string): VNode {
  return h(
    'div',
    { class: 'copybox' },
    h('code', { class: 'command', test }, text),
    button(
      'Copy',
      () =>
        void ui
          .copy(text)
          .then((ok) =>
            ok
              ? ui.flash('Copied. Paste it where the assistant runs.', 'ok')
              : ui.flash('Could not copy: select the line and copy it.', 'error'),
          ),
      { test: copyTest },
    ),
  );
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function ago(instant: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(instant)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${String(minutes)} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/** "a", "a and b", "a, b and c". */
export function listing(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}
