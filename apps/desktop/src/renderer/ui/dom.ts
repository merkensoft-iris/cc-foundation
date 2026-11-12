/// <reference lib="dom" />
/**
 * Puts a view tree into the window: each render replaces the container's children with new
 * elements. Text inputs keep their value in the screen's state (`onInput`), so a render after a
 * click shows what was typed; no render runs on a keystroke, so typing keeps its focus.
 */
import type { VNode } from './vnode.js';

const PROPERTY_PROPS = new Set(['value', 'checked', 'disabled', 'hidden']);

function create(node: VNode | string): Node {
  if (typeof node === 'string') return document.createTextNode(node);
  const element = document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.props)) {
    if (value === undefined || value === null) continue;
    switch (name) {
      case 'onClick':
        element.addEventListener('click', (event) => {
          event.preventDefault();
          (value as () => void)();
        });
        break;
      case 'onInput':
        element.addEventListener('input', (event) => {
          (value as (text: string) => void)(
            (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
          );
        });
        // A select reports its choice on change.
        element.addEventListener('change', (event) => {
          if (node.tag === 'select') {
            (value as (text: string) => void)((event.target as HTMLSelectElement).value);
          }
        });
        break;
      case 'onCheck':
        element.addEventListener('change', (event) => {
          (value as (checked: boolean) => void)((event.target as HTMLInputElement).checked);
        });
        break;
      case 'onSubmit':
        element.addEventListener('submit', (event) => {
          event.preventDefault();
          (value as () => void)();
        });
        break;
      case 'class':
        element.className = String(value);
        break;
      case 'test':
        element.dataset['test'] = String(value);
        break;
      default:
        if (PROPERTY_PROPS.has(name)) {
          (element as unknown as Record<string, unknown>)[name] = value;
        } else {
          element.setAttribute(name, String(value));
        }
    }
  }
  for (const child of node.children) element.appendChild(create(child));
  if (node.tag === 'select' && typeof node.props.value === 'string') {
    (element as HTMLSelectElement).value = node.props.value;
  }
  return element;
}

/** Replaces the container's contents with the tree. */
export function mount(container: Element, node: VNode): void {
  container.replaceChildren(create(node));
}
