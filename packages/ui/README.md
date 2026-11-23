# @cc/ui

The default UI ([ADR 0008](../../docs/adr/0008-engine-owned-ui.md) decision 1): the screens of
09 P1-11, the app frame, the UI kit (`h` view trees, no UI library and no bundler) and the
stylesheet `styles/app.css`. It builds on the UI contract, `@cc/ui-sdk/v1`, and reaches the
app only through `window.cc` (rule D3).

The engine decides what runs. An engine without `ui/app.ts` runs this UI as it is: main serves
`dist/index.js` and the modules beside it, unbundled, as `/ui/index.js`, and `styles/app.css` as
`/ui/app.css` (`apps/desktop/src/main/app-protocol.ts`). An engine's `ui/app.ts`, which
`cc-build` bundles under the D3 allowlist, composes it through the versioned entry point
`@cc/ui/v1`:

```ts
// ui/app.ts: the default UI, restyled, with Home replaced
import '@cc/ui/v1/app.css';
import './styles/brand.css';
import { createApp } from '@cc/ui/v1';

import { home } from './screens/home.js';

void createApp({ screens: { home } }).start();
```

| Part            | Exports                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition     | `createApp(overrides)`, `AppOverrides` (`screens`, `container`), `DefaultApp`                                                                                         |
| App frame       | `App`, `AppOptions`, `AppScreen`, `SCREENS`, `NAV`, `routeOfLink`                                                                                                     |
| Default screens | `homeScreen`, `itemsScreen`, `decisionsScreen`, `issuesScreen`, `meetingsScreen`, `scorecardScreen`, `settingsScreen`, `onboardingScreen`                             |
| Screen helpers  | `Screen<S>`, `Ui`, `act`, `actInWindow`, `inWindow`, `waitingInWindow`, `IN_WINDOW`, `errorText`, `isCcError`                                                         |
| Result names    | the names of `app/api.ts` (`HomeResult`, `PrincipalRow`, ...), `SCOPES`, `GRANT_ONLY_SCOPES`; the route types `AppRoute`, `ItemsTab`, `ScreenName`, `SettingsSection` |
| UI kit          | `h`, `VNode`, `Child`, `Props`, `mount`, `copyText`, the parts of `ui/parts.ts`                                                                                       |
| Test queries    | `walk`, `textOf`, `byTest`, `queryByTest`, `allByTest`, `buttons`                                                                                                     |
| Stylesheet      | `@cc/ui/v1/app.css`                                                                                                                                                   |

A replaced screen is a `Screen` that renders `h` trees; a route not replaced shows the default
screen, which keeps updating with `@cc/ui`. To start a replacement from the default screen,
eject it: `pnpm cc:eject <screen>` (from `@cc/build`) copies its source from `src/screens/`,
which this package ships, into the engine's `ui/screens/`, with its imports of the default UI's
own modules on `@cc/ui/v1`, and records it in `ui/.cc-ui.json`. `@cc/ui/v1` therefore exports
everything a default screen imports from outside `screens/` (`Ui`, the result names of
`app/api.ts`, the route types). `pnpm cc:upgrade --check` lists upstream changes to an ejected
screen and `pnpm cc:ui-update` merges them (`packages/build/README.md`). Human-only operations of Tier H are confirmed in
the app shell's confirm window whatever the screen shows (04 §4.3 rule 4). A UI written from
scratch, in any UI library the engine names, needs only `@cc/ui-sdk/v1`.

Within extension API 1 a change to a default screen that keeps this API is not an API bump; a
change to the composition API is, with its codemod (ADR 0003 decision 6).

The screen tests in `test/` run the whole app headless against a fake `call` and read the view
trees (`test/harness.ts`). The Electron end-to-end flows stay in `apps/desktop/test/app` and run
this UI.
