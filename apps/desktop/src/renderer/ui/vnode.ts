/**
 * The screens' view trees (09 P1-11). A screen renders to plain `VNode` objects, which
 * `dom.ts` turns into elements in the window; tests read the same trees headless, with the
 * queries below. The renderer has no bundler, so the trees are built with `h`, not JSX, and no
 * UI library is loaded (04 §3: the renderer loads only its own compiled modules).
 */

/** What an element's event handlers receive: the input's value, or a checkbox's state. */
export interface Props {
  readonly class?: string;
  /** A stable name for tests and for the end-to-end run of P1-15. */
  readonly test?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly type?: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly placeholder?: string;
  readonly role?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-current'?: string;
  readonly 'aria-pressed'?: string;
  readonly for?: string;
  readonly id?: string;
  readonly name?: string;
  readonly min?: string;
  readonly step?: string;
  readonly rows?: string;
  readonly hidden?: boolean;
  readonly onClick?: () => void;
  readonly onInput?: (value: string) => void;
  readonly onCheck?: (checked: boolean) => void;
  readonly onSubmit?: () => void;
}

export interface VNode {
  readonly tag: string;
  readonly props: Props;
  readonly children: readonly (VNode | string)[];
}

export type Child = VNode | string | number | null | undefined | false | readonly Child[];

function flatten(children: readonly Child[], out: (VNode | string)[]): (VNode | string)[] {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) flatten(child as readonly Child[], out);
    else if (typeof child === 'number') out.push(String(child));
    else out.push(child as VNode | string);
  }
  return out;
}

/** An element: `h('button', { onClick }, 'Save')`. */
export function h(tag: string, props: Props | null = null, ...children: Child[]): VNode {
  return { tag, props: props ?? {}, children: flatten(children, []) };
}

/** Every node of a tree, depth first. */
export function walk(node: VNode): VNode[] {
  const out: VNode[] = [node];
  for (const child of node.children) if (typeof child !== 'string') out.push(...walk(child));
  return out;
}

/** The text a node shows, its children's joined. */
export function textOf(node: VNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/** The nodes with a `test` name. */
export function allByTest(node: VNode, test: string): VNode[] {
  return walk(node).filter((candidate) => candidate.props.test === test);
}

/** The one node with a `test` name; throws when there is none. */
export function byTest(node: VNode, test: string): VNode {
  const found = allByTest(node, test)[0];
  if (found === undefined) throw new Error(`no node with test name ${test}`);
  return found;
}

/** The node with a `test` name, or undefined. */
export function queryByTest(node: VNode, test: string): VNode | undefined {
  return allByTest(node, test)[0];
}

/** The buttons whose text is `label`. */
export function buttons(node: VNode, label: string): VNode[] {
  return walk(node).filter(
    (candidate) => candidate.tag === 'button' && textOf(candidate) === label,
  );
}
