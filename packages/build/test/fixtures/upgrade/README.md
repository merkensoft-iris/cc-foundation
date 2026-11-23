# cc:upgrade fixtures (AC-08-10)

Synthetic, for `test/upgrade.test.ts`. Extension API 1 is the first real version, so the
test stands up a fixture foundation at API 2 to prove the runner across one step:

- `ui-sdk/`: a fixture `@cc/ui-sdk` with the versioned entry points of ADR 0003 decision 2,
  `v1` (flat tokens through a `theme` prop, `dashboard.*` slots, `registerWidget`) and `v2`
  (`token()`, `home.*` slots, `defineWidget` with a required `title`). Types only.
- `ui/`: a fixture `@cc/ui` 2.0.0 with the composition API at `v1` (`createApp({ screens })`,
  screens draw with `view`) and `v2` (`createApp({ replace })`, screens draw with `render`), a
  small run-time half so a composition root bundles, and the source of its Home screen,
  `src/screens/home.ts`, as 2.0.0 has it (ADR 0008 decision 1).
- `engine-api1/`: a fixture engine written against API 1: `cc.config.ts`, flat theme
  tokens, and two widgets. `ui/header.ts` can be rewritten; `ui/legend.ts` reads the theme
  with a computed key, which the codemod must not guess (ADR 0003, "a site the codemod must
  not guess"). Its UI: the composition root `ui/app.ts` over `@cc/ui/v1`, and a Home screen it
  ejected from `@cc/ui` 1.4.0 and edited (`ui/screens/home.ts`), recorded in `ui/.cc-ui.json`
  with the 1.4.0 text as its base (`ui/.cc-ui/base/screens/home.ts.base`). 2.0.0 changed that
  screen upstream too, so `cc:upgrade --check` lists it and `cc:ui-update` merges it.

The codemod itself is `test/upgrade-codemod.ts`.
