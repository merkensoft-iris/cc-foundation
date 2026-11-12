/**
 * The building blocks the screens share: headings, tabs, tables, fields and status chips. The
 * classes are styled by `/app.css` with the engine's theme tokens (owner decision Q9: tokens
 * only, the layout is fixed).
 */
import { h, type Child, type VNode } from './vnode.js';

export function page(title: string, ...children: Child[]): VNode {
  return h('section', { class: 'screen' }, h('h1', null, title), ...children);
}

export function section(title: string, ...children: Child[]): VNode {
  return h('section', { class: 'panel' }, h('h2', null, title), ...children);
}

export function tabs<T extends string>(
  current: T,
  entries: readonly { readonly id: T; readonly label: string }[],
  choose: (id: T) => void,
): VNode {
  return h(
    'div',
    { class: 'tabs', role: 'tablist' },
    entries.map((entry) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          test: `tab-${entry.id}`,
          'aria-pressed': entry.id === current ? 'true' : 'false',
          class: entry.id === current ? 'tab current' : 'tab',
          onClick: () => choose(entry.id),
        },
        entry.label,
      ),
    ),
  );
}

export function table(headers: readonly string[], rows: readonly VNode[], empty: string): VNode {
  if (rows.length === 0) return h('p', { class: 'empty' }, empty);
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        headers.map((header) => h('th', null, header)),
      ),
    ),
    h('tbody', null, rows),
  );
}

export function chip(text: string, tone: 'neutral' | 'good' | 'warn' | 'bad' = 'neutral'): VNode {
  return h('span', { class: `chip ${tone}` }, text);
}

export function healthChip(health: string | undefined): VNode | null {
  if (health === undefined) return null;
  const tone = health === 'on_track' ? 'good' : health === 'at_risk' ? 'warn' : 'bad';
  return chip(health.replace('_', ' '), tone);
}

export function stateChip(state: string): VNode {
  const tone =
    state === 'overdue' || state === 'off_track'
      ? 'bad'
      : state === 'claimed_done' || state === 'draft'
        ? 'warn'
        : state === 'verified_done' || state === 'completed'
          ? 'good'
          : 'neutral';
  return chip(state.replace(/_/g, ' '), tone);
}

export function link(label: string, open: () => void, test?: string): VNode {
  return h(
    'button',
    { type: 'button', class: 'link', onClick: open, ...(test === undefined ? {} : { test }) },
    label,
  );
}

export function button(
  label: string,
  onClick: () => void,
  options: { test?: string; disabled?: boolean; title?: string; primary?: boolean } = {},
): VNode {
  return h(
    'button',
    {
      type: 'button',
      class: options.primary === true ? 'primary' : 'secondary',
      onClick,
      ...(options.test === undefined ? {} : { test: options.test }),
      ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
      ...(options.title === undefined ? {} : { title: options.title }),
    },
    label,
  );
}

/** A labelled text input whose value lives in the screen's state. */
export function field(
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { test?: string; type?: string; placeholder?: string; multiline?: boolean } = {},
): VNode {
  const input = h(options.multiline === true ? 'textarea' : 'input', {
    value,
    onInput,
    'aria-label': label,
    ...(options.multiline === true ? { rows: '2' } : { type: options.type ?? 'text' }),
    ...(options.test === undefined ? {} : { test: options.test }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  });
  return h('label', { class: 'field' }, h('span', null, label), input);
}

export function select(
  label: string,
  value: string,
  options: readonly { readonly value: string; readonly label: string }[],
  onInput: (value: string) => void,
  test?: string,
): VNode {
  return h(
    'label',
    { class: 'field' },
    h('span', null, label),
    h(
      'select',
      { value, onInput, 'aria-label': label, ...(test === undefined ? {} : { test }) },
      options.map((option) => h('option', { value: option.value }, option.label)),
    ),
  );
}

export function checkbox(
  label: string,
  checked: boolean,
  onCheck: (checked: boolean) => void,
  test?: string,
): VNode {
  return h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', checked, onCheck, ...(test === undefined ? {} : { test }) }),
    label,
  );
}

/** A local date and time from an RFC 3339 instant, in a time zone: "Fri 13 Nov, 15:00". */
export function localTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** The local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** A local date `days` later. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
