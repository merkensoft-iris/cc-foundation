# cc:upgrade fixtures (AC-08-10)

Synthetic, for `test/upgrade.test.ts`. Extension API 1 is the first real version, so the
test stands up a fixture foundation at API 2 to prove the runner across one step:

- `ui-sdk/`: a fixture `@cc/ui-sdk` with the versioned entry points of ADR 0003 decision 2,
  `v1` (flat tokens through a `theme` prop, `dashboard.*` slots, `registerWidget`) and `v2`
  (`token()`, `home.*` slots, `defineWidget` with a required `title`). Types only.
- `engine-api1/`: a fixture engine written against API 1: `cc.config.ts`, flat theme
  tokens, and two widgets. `ui/header.ts` can be rewritten; `ui/legend.ts` reads the theme
  with a computed key, which the codemod must not guess (ADR 0003, "a site the codemod must
  not guess").

The codemod itself is `test/upgrade-codemod.ts`.
