/**
 * Runs the renderer's app headless (09 P1-11): a fake local API answers each method from a
 * table, every call is recorded, and each render's view tree is kept for the test to read and
 * click through.
 */
import { App } from '../../src/renderer/app/app.js';
import type { AppRoute } from '../../src/renderer/app/routes.js';
import { textOf, type VNode } from '../../src/renderer/ui/vnode.js';

export type Answer = (params: Record<string, unknown>) => unknown;

export interface Harness {
  readonly app: App;
  readonly calls: { method: string; params: Record<string, unknown> }[];
  /** The latest view tree. */
  tree(): VNode;
  /** The latest view's text. */
  text(): string;
  /** Lets pending calls, reloads and renders finish. */
  settle(): Promise<void>;
  /** The params of every call of a method. */
  callsOf(method: string): Record<string, unknown>[];
  answers: Record<string, Answer>;
}

/** An API error, as `window.cc.invoke` rejects with it. */
export function apiError(code: string, message: string) {
  return { code, message, help: [] };
}

export async function startApp(
  answers: Record<string, Answer>,
  route: AppRoute = { screen: 'home' },
  now = Date.parse('2026-11-13T09:30:00Z'),
): Promise<Harness> {
  let last: VNode | undefined;
  const calls: Harness['calls'] = [];
  const harness: Partial<Harness> & { answers: Record<string, Answer> } = { answers };
  const app = new App({
    call: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: record });
      const answer = harness.answers[method];
      if (answer === undefined) throw apiError('E_USAGE', `no fake answer for ${method}`);
      return answer(record);
    },
    render: (node) => {
      last = node;
    },
    now: () => now,
  });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await app.go(route);
  await settle();
  return Object.assign(harness, {
    app,
    calls,
    tree: () => {
      if (last === undefined) throw new Error('nothing rendered');
      return last;
    },
    text: () => (last === undefined ? '' : textOf(last)),
    settle,
    callsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.params),
  }) as Harness;
}

/** Clicks a node and lets what it started finish. */
export async function click(harness: Harness, node: VNode): Promise<void> {
  const onClick = node.props.onClick;
  if (onClick === undefined) throw new Error(`<${node.tag}> has no click handler`);
  if (node.props.disabled === true) throw new Error(`<${node.tag}> is disabled`);
  onClick();
  await harness.settle();
}

/** Types into an input or textarea node. */
export function type(node: VNode, value: string): void {
  const onInput = node.props.onInput;
  if (onInput === undefined) throw new Error(`<${node.tag}> takes no input`);
  onInput(value);
}
