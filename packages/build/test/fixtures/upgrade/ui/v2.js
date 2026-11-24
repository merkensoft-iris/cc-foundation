// The fixture's run-time half, so an engine composing it bundles; types in the .d.ts beside it.
export const h = (tag, props, ...children) => ({ tag, children });
export const section = (title, ...children) => h('section', null, title, ...children);
export function createApp(overrides = {}) {
  return { overrides, start: () => Promise.resolve() };
}
