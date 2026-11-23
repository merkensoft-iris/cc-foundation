/**
 * `@cc/ui/v1`: the default UI's composition API for extension API 1 (ADR 0008 decision 1;
 * versioned entry points, ADR 0003 decision 2). An engine's `ui/app.ts`, which `cc-build`
 * bundles, uses the default UI through it:
 *
 * - as it is: `createApp().start()`, with `import '@cc/ui/v1/app.css'` for its stylesheet;
 * - restyled: the theme tokens (`theme/tokens.json`), and the engine's own stylesheet imported
 *   after `@cc/ui/v1/app.css`;
 * - with screens replaced one at a time: `createApp({ screens: { home: myHome } })`, where a
 *   screen is a `Screen` that renders `h` trees and may build on the default screens and the
 *   UI kit below.
 *
 * A UI written from scratch needs only `@cc/ui-sdk/v1`. A change to a default screen that
 * keeps this API is not an API bump; a change to this API is (ADR 0008 decision 1).
 */
export { createApp, type AppOverrides, type DefaultApp } from './app/create-app.js';
export { App, SCREENS, type AppOptions, type AppScreen } from './app/app.js';
export { NAV, routeOfLink } from './app/routes.js';
export {
  act,
  actInWindow,
  errorText,
  inWindow,
  IN_WINDOW,
  isCcError,
  waitingInWindow,
  type Screen,
} from './app/screen.js';

// The default screens, for composition: an override may wrap one or reuse its parts.
export { decisionsScreen } from './screens/decisions.js';
export { homeScreen } from './screens/home.js';
export { issuesScreen } from './screens/issues.js';
export { itemsScreen } from './screens/items.js';
export { meetingsScreen } from './screens/meetings.js';
export { onboardingScreen } from './screens/onboarding.js';
export { scorecardScreen } from './screens/scorecard.js';
export { settingsScreen } from './screens/settings.js';

// The UI kit: `h` view trees, drawing them into the page, the common parts, and the queries
// that UI tests read the trees with.
export { copyText, mount } from './ui/dom.js';
export * from './ui/parts.js';
export {
  allByTest,
  buttons,
  byTest,
  h,
  queryByTest,
  textOf,
  walk,
  type Child,
  type Props,
  type VNode,
} from './ui/vnode.js';
