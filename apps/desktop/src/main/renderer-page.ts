/**
 * The page the app's UI runs in, served as `cc-app://app/` (see `app-protocol.ts`). The page
 * shell is main's, whichever UI runs (ADR 0008 decision 1): this HTML, the CSP header
 * (`hardening.ts`), no inline script, and the labels main owns in the page, the
 * developer-mode banner and the Rebuild now strip, which the page shell's own script draws
 * (`/shell/index.js`, from `src/page-shell`) with its own stylesheet (`/shell.css`).
 *
 * The UI is `/ui/index.js` and `/ui/app.css`: the engine's own UI when its build bundled one
 * (`cc-ui/` in the packaged app, from its `ui/app.ts`), else the default UI (`@cc/ui`, with
 * its `styles/app.css`). It draws into `#app`. `/theme.css` is the engine's compiled theme tokens
 * (`--cc-*` custom properties, from `theme/tokens.json` by `cc-build`), which every
 * stylesheet here reads with its own defaults.
 */
export const APP_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Command Center</title>
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/shell.css" />
    <link rel="stylesheet" href="/ui/app.css" />
    <script type="module" src="/shell/index.js"></script>
    <script type="module" src="/ui/index.js"></script>
  </head>
  <body>
    <div id="mode-banner" class="mode-banner" role="status" hidden></div>
    <div id="rebuild-offer" class="rebuild-offer" role="status" hidden>
      <span id="rebuild-text"></span>
      <button id="rebuild-now" type="button" hidden>Rebuild now</button>
      <button id="rebuild-later" type="button" hidden>Later</button>
    </div>
    <div id="app"><p class="muted">Starting…</p></div>
  </body>
</html>
`;

/** The page shell's stylesheet: the developer-mode banner and the Rebuild now strip. */
export const SHELL_CSS = `.mode-banner {
  padding: 8px 24px;
  background: var(--cc-color-warning, #8a5a00);
  color: #fff;
  font: 600 1rem var(--cc-font-body, system-ui, sans-serif);
}
.rebuild-offer {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 24px;
  border-bottom: 1px solid var(--cc-color-border, #8884);
  background: var(--cc-color-surface, Canvas);
  color: var(--cc-color-text, CanvasText);
  font-family: var(--cc-font-body, system-ui, sans-serif);
}
.mode-banner[hidden],
.rebuild-offer[hidden],
.rebuild-offer button[hidden] {
  display: none;
}
.rebuild-offer button {
  font: inherit;
  border-radius: var(--cc-radius-small, 4px);
  border: 1px solid var(--cc-color-border, #8888);
  padding: 4px 12px;
  background: var(--cc-color-surface, Canvas);
  color: inherit;
  cursor: pointer;
}
.rebuild-offer #rebuild-now {
  background: var(--cc-color-accent, #0b6e4f);
  color: var(--cc-color-accent-text, #fff);
  border-color: transparent;
}
`;
