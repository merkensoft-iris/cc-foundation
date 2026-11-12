/**
 * The page the renderer runs in, served as `cc-app://app/` (see `app-protocol.ts`). It loads
 * only the compiled renderer module and its stylesheet from the app's own origin; the CSP
 * header (`hardening.ts`) forbids anything else. The screens of 09 P1-11 replace the
 * renderer's contents, not this page's shape.
 *
 * `/theme.css` is the engine's compiled theme tokens (`--cc-*` custom properties, from
 * `theme/tokens.json` by `cc-build`); `/app.css` uses them with the foundation's defaults.
 */
export const APP_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Command Center</title>
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/app.css" />
    <script type="module" src="/renderer/index.js"></script>
  </head>
  <body>
    <div id="mode-banner" class="mode-banner" role="status" hidden></div>
    <div id="rebuild-offer" class="rebuild-offer" role="status" hidden>
      <span id="rebuild-text"></span>
      <button id="rebuild-now" type="button" hidden>Rebuild now</button>
      <button id="rebuild-later" type="button" hidden>Later</button>
    </div>
    <main id="app">
      <h1>Command Center</h1>
      <p id="core-status">Starting…</p>
      <p id="route"></p>
    </main>
  </body>
</html>
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  font-family: var(--cc-font-body, system-ui, sans-serif);
}
body {
  margin: 0;
  background: var(--cc-color-background, Canvas);
  color: var(--cc-color-text, CanvasText);
}
main {
  padding: 24px;
}
h1 {
  font-family: var(--cc-font-heading, inherit);
}
.mode-banner {
  padding: 8px 24px;
  background: var(--cc-color-warning, #8a5a00);
  color: #fff;
  font-weight: 600;
}
.rebuild-offer {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 24px;
  border-bottom: 1px solid var(--cc-color-border, #8884);
  background: var(--cc-color-surface, Canvas);
}
.rebuild-offer[hidden] {
  display: none;
}
.rebuild-offer button {
  border-radius: var(--cc-radius-small, 4px);
  border: 1px solid var(--cc-color-border, #8888);
  padding: 4px 12px;
  font: inherit;
}
#rebuild-now {
  background: var(--cc-color-accent, #0b6e4f);
  color: var(--cc-color-accent-text, #fff);
}
`;
