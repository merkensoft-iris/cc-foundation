/**
 * The page the renderer runs in, served as `cc-app://app/` (see `app-protocol.ts`). It loads
 * only the compiled renderer module and its stylesheet from the app's own origin; the CSP
 * header (`hardening.ts`) forbids anything else. The renderer draws the screens of 09 P1-11
 * into `#app`; the layout is the foundation's, and an engine changes only the theme tokens
 * (owner decision Q9).
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
    <div id="app"><p class="muted">Starting…</p></div>
  </body>
</html>
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  font-family: var(--cc-font-body, system-ui, sans-serif);
  --cc-pad: 8px;
}
body {
  margin: 0;
  background: var(--cc-color-background, Canvas);
  color: var(--cc-color-text, CanvasText);
}
h1,
h2,
h3 {
  font-family: var(--cc-font-heading, inherit);
}
h1 {
  font-size: 1.5rem;
  margin: 0 0 calc(var(--cc-pad) * 2);
}
h2 {
  font-size: 1.1rem;
}
h3 {
  font-size: 1rem;
}
button,
input,
select,
textarea {
  font: inherit;
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
.rebuild-offer button,
button.primary,
button.secondary,
.tab {
  border-radius: var(--cc-radius-small, 4px);
  border: 1px solid var(--cc-color-border, #8888);
  padding: 4px 12px;
  background: var(--cc-color-surface, Canvas);
  color: inherit;
  cursor: pointer;
}
#rebuild-now,
button.primary {
  background: var(--cc-color-accent, #0b6e4f);
  color: var(--cc-color-accent-text, #fff);
  border-color: transparent;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--cc-color-accent, #0b6e4f);
  text-decoration: underline;
  cursor: pointer;
}
.app {
  display: grid;
  grid-template-columns: 200px 1fr;
  min-height: 100vh;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: calc(var(--cc-pad) * 2) var(--cc-pad);
  border-right: 1px solid var(--cc-color-border, #8884);
  background: var(--cc-color-surface, Canvas);
}
.nav-item {
  text-align: left;
  border: 0;
  border-radius: var(--cc-radius-small, 4px);
  padding: var(--cc-pad) calc(var(--cc-pad) * 1.5);
  background: none;
  color: inherit;
  cursor: pointer;
}
.nav-item.current {
  background: var(--cc-color-accent, #0b6e4f);
  color: var(--cc-color-accent-text, #fff);
}
.content {
  padding: calc(var(--cc-pad) * 3);
  min-width: 0;
}
.panel {
  margin: calc(var(--cc-pad) * 3) 0;
}
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: calc(var(--cc-pad) * 2);
}
.tab.current {
  border-color: var(--cc-color-accent, #0b6e4f);
  font-weight: 600;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  text-align: left;
  padding: var(--cc-pad);
  border-bottom: 1px solid var(--cc-color-border, #8884);
  vertical-align: top;
}
.chip {
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 0.85em;
  border: 1px solid var(--cc-color-border, #8888);
}
.chip.good {
  border-color: var(--cc-color-success, #2e7d32);
}
.chip.warn {
  border-color: var(--cc-color-warning, #8a5a00);
}
.chip.bad {
  border-color: var(--cc-color-danger, #b3261e);
  color: var(--cc-color-danger, #b3261e);
}
.muted,
.empty {
  color: var(--cc-color-text-muted, GrayText);
}
.flash {
  padding: var(--cc-pad) calc(var(--cc-pad) * 2);
  border-radius: var(--cc-radius-small, 4px);
  border: 1px solid var(--cc-color-border, #8888);
}
.flash.error,
.failure {
  border-color: var(--cc-color-danger, #b3261e);
}
.prompt {
  padding: calc(var(--cc-pad) * 2);
  border: 2px solid var(--cc-color-accent, #0b6e4f);
  border-radius: var(--cc-radius-medium, 8px);
  margin-bottom: calc(var(--cc-pad) * 2);
}
.card {
  border: 1px solid var(--cc-color-border, #8884);
  border-radius: var(--cc-radius-medium, 8px);
  padding: calc(var(--cc-pad) * 2);
  margin-bottom: calc(var(--cc-pad) * 2);
  background: var(--cc-color-surface, Canvas);
}
.actions,
.inline,
.form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cc-pad);
  align-items: flex-end;
  margin: var(--cc-pad) 0;
}
.form fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cc-pad);
  align-items: flex-end;
  border: 1px solid var(--cc-color-border, #8884);
  border-radius: var(--cc-radius-small, 4px);
}
.form fieldset .field input {
  min-width: 7rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.9em;
}
.field input,
.field select,
.field textarea {
  min-width: 12rem;
  padding: 4px 8px;
  border-radius: var(--cc-radius-small, 4px);
  border: 1px solid var(--cc-color-border, #8888);
  background: var(--cc-color-background, Canvas);
  color: inherit;
}
.check {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-right: var(--cc-pad);
  font-size: 0.85em;
}
.reason {
  color: var(--cc-color-warning, #8a5a00);
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px calc(var(--cc-pad) * 2);
}
.facts dt {
  font-weight: 600;
}
.facts dd {
  margin: 0;
}
.attention {
  list-style: none;
  padding: 0;
}
.attention li.clear {
  opacity: 0.6;
}
.week {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--cc-pad);
}
.day {
  border: 1px solid var(--cc-color-border, #8884);
  border-radius: var(--cc-radius-small, 4px);
  padding: var(--cc-pad);
}
.time {
  font-family: var(--cc-font-mono, ui-monospace, monospace);
  color: var(--cc-color-text-muted, GrayText);
}
.agenda-section {
  margin-bottom: var(--cc-pad);
}
.agenda-section.current {
  border-left: 3px solid var(--cc-color-accent, #0b6e4f);
  padding-left: calc(var(--cc-pad) * 1.5);
}
.timebox {
  font-weight: 400;
  opacity: 0.8;
}
.timer.over {
  color: var(--cc-color-danger, #b3261e);
}
`;
