---
name: cc-engine-ui
description: Use when a development agent changes this engine's app UI or theme: restyling it, composing screens in ui/app.ts, replacing a screen, ejecting a default screen, or updating an ejected screen after a foundation upgrade. Not for Command Center's own in-app AI, which never changes code.
---

# Change this engine's UI

The UI of this app is the engine's: `ui/app.ts` is the composition root that decides what runs.
It sits on `@cc/ui-sdk` (the typed `window.cc` client, routes, the screen contract, `token()`)
and `@cc/ui` (the default UI). Backend code is the foundation's and is not here.

## Who may do this

Development agents working for the user, through a pull request the user reviews. Command
Center's own AI never changes code (C-08-10): if you are that AI, stop. You may change `ui/`,
`theme/`, `cc.config.ts`, `frameworks/` and `packs/`. You never touch `connectors.lock`,
`.claude/`, `.codex/`, `.github/`, `AGENTS.md` or `CLAUDE.md`, and CI's path guard rejects a PR
that does.

## Pick the smallest change that does the job

Go down this list and stop at the first level that works. Each level costs more upkeep than the
last, because the more of the UI is the engine's own code, the more foundation changes it must
absorb itself.

1. **Tokens.** Edit `theme/tokens.json`: colours, fonts, radius, `density.scale`. Every screen
   follows, and the confirm window too. Read a token in code with `token('color.accent')`.
2. **A stylesheet.** `ui/styles/`, imported in `ui/app.ts` after `@cc/ui/v1/app.css`. Style the
   default screens' classes. Check the page after each foundation upgrade:
   the default markup may change without an API bump.
3. **Compose.** In `ui/app.ts`: `createApp({ screens: { home: myHome } }).start()` from
   `@cc/ui/v1`. A screen is a `Screen` that renders `h` trees and may wrap a default screen
   (`homeScreen` and the others are exported) or reuse the UI kit's parts.
4. **Replace a screen.** Write `ui/screens/<name>.ts` and name it in `overrides.screens`. Load
   state with the client (`ui.call('home.get', {})`, typed from the schemas), render with
   your library, call methods from handlers. Add the libraries you use to `cc.config.ts`
   `ui.libraries`; the build allowlist (D3) rejects any import not on it.
5. **Eject a default screen** to edit it instead of rewriting it: `pnpm cc:eject <screen>`
   copies it into `ui/screens/` and records its upstream version and hash in
   `ui/.cc-ui.json`. Commit the manifest with the screen; never delete or hand-edit it.
6. **Replace the whole UI.** Drop `createApp` and build from `@cc/ui-sdk/v1` alone. Only when
   the user asked for it: you now own navigation, errors, the meeting runner, and every flow.

## Keeping up with the foundation

- Screens you did not replace update through the normal dependency PR with no edits.
- For ejected screens run `pnpm cc:upgrade --check`: it lists upstream changes since the
  recorded version. Then `pnpm cc:ui-update <screen>` does a 3-way merge of upstream into
  your copy. Resolve conflicts by keeping the user's intent, and re-run the UI tests.
  Never rewrite the manifest to hide a difference.
- `pnpm cc:upgrade` applies codemods when the extension API moves (N−1 to N); it exits 1 and
  marks `/* cc:upgrade TODO(API n) */` where it cannot decide. Finish those by hand.
- Methods marked `ui` only gain optional fields within an API version, so a result you
  read today will not lose a field. Do not rely on anything not in the typed client.

## What a screen may and may not do

- A screen explains and asks. For a **Tier H** operation (granting scopes, restoring a backup,
  approving a write, installing or activating a connector, browser sessions, discovery, and the
  rest of 04 §4.3 rule 4), the call returns `needs_confirmation`; show the preview text as
  the core wrote it and tell the user to confirm in the confirmation window. The approving
  click happens there, drawn by the app shell. Never write code that approves for the user,
  retries to dodge the window, hides the pending state, or fakes a confirm look-alike.
- Do not collect a passphrase, key or secret in a screen, or a filesystem path by typing:
  the shell has its own prompt and folder picker.
- The page has no network. Do not add fetches, remote fonts, images or scripts, and do not try
  to widen the CSP: it is the shell's. Anything else is an unrelated bug to report.
- Keep text a rule requires (for example "Needs care"). A free
  layout is allowed; a missing safety label is a defect.
- Fictional data in tests and fixtures only.

## Steps

1. State which level (1-6) you are at and why a lower one would not do.
2. Make the change in `ui/`, `theme/` and config only.
3. Test it on the published headless harness (the UI tests in `ui/`): load the screen with a
   fake `window.cc`, assert the text and the calls. Name tests after what they prove.
4. Run `pnpm cc:upgrade --check`, then `pnpm test`, `pnpm typecheck` and `pnpm build`.
5. Open a PR. Say what changed on screen, which level, which screens are ejected, and what you
   did not try. The user reviews and merges.

## Done when

- The UI tests pass and `pnpm build` produces the app on the D3 allowlist.
- `ui/.cc-ui.json` matches the screens in `ui/screens/` and `cc:upgrade --check` has nothing
  unexplained.
- No screen completes, approves or bypasses a Tier H operation itself.
- Only `ui/`, `theme/`, `cc.config.ts`, `frameworks/` or `packs/` changed.
- The PR is open for the user's review; you never merge it.
