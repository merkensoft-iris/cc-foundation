# @cc/build

The foundation's build tooling for an engine repository (04 §10, 08 §4.1, 08 §6): the
electron-builder configuration with the hardening and fuses every engine build gets, the
build and install stamps and the clean-tree start check (ADR 0004), Rebuild now and the
idle restart, `cc:upgrade` with its codemod runner (ADR 0003 decision 6), and the tooling for
screens an engine ejects from the default UI, `cc:eject` and `cc:ui-update` (ADR 0008 decision 1).

The engine holds no script code (08 §6): each of its scripts calls one bin this package
installs, `cc-build`, `cc-start`, `cc-install-stamp`, `cc-upgrade`, `cc-eject` or `cc-ui-update`, and passes the user's
arguments straight through.

The part the packaged app runs (the stamps, the start check, Rebuild now and the idle restart)
is `@cc/build-runtime`, which has no dependencies. `@cc/desktop` imports it, so the app never
carries electron-builder or ts-morph; this package re-exports it for the build and the tests.

## The engine's scripts

An engine's `package.json` (the `cc-engine` template) pins every `@cc/*` package exactly and
wires its scripts to these commands. `@cc/desktop` is a **dependency**: electron-builder packs
the engine's production dependencies into the app, and `@cc/desktop` is the app (its `main` is
the entry point, `DESKTOP_MAIN`). `@cc/build` is a **development dependency**.

```json
{
  "scripts": {
    "postinstall": "cc-install-stamp",
    "build": "cc-build",
    "start": "cc-start",
    "check": "cc-build check",
    "cc:upgrade": "cc-upgrade",
    "cc:eject": "cc-eject",
    "cc:ui-update": "cc-ui-update"
  },
  "dependencies": {
    "@cc/desktop": "<foundation version>"
  },
  "devDependencies": {
    "@cc/build": "<foundation version>",
    "typescript": "<pin>"
  }
}
```

The template's interim `tools/cc.ts` runs the same bins (`node <bin> <args>`), so its
`COMMANDS` table needs no change. With pnpm 12 the engine's `pnpm-workspace.yaml` also needs
`allowBuilds: { electron-winstaller: false }` (electron-builder brings it for Squirrel.Windows,
which CC does not use; pnpm 12 fails an install with an unlisted install script), as the
foundation's own does, and an entry for `esbuild` (which bundles the engine's UI; its install
script only checks its binary, so either value works).

The engine also needs `"type": "module"` in its `package.json` (the build imports
`cc.config.ts` with Node's type stripping), `dist/` in its `.gitignore` (the build output), a
`tsconfig.json` (the type-check), and `extensionApi: <N>` in `cc.config.ts`.

| Engine script       | Command                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Exit codes                      |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `postinstall`       | `cc-install-stamp`                                    | Writes `node_modules/.cc-install-stamp.json`: the sha256 of `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` (ADR 0004 decision 2). An install with `--ignore-scripts` leaves no stamp, and the app then starts in developer mode                                                                                                                                                                                                                                                 | 0                               |
| `pnpm build`        | `cc-build [--out <dir>] [--no-package] [--installer]` | Checks `extensionApi` (warns when deprecated, fails when unsupported), loads `cc.config.ts` into `cc.config.json`, compiles `theme/tokens.json` into `cc-theme.css`, runs the engine's `tsc --noEmit`, bundles `ui/app.ts` under the D3 check (below), inspects the tree, writes the build stamp, and packages git's view of the tree with electron-builder into `dist/` (default: the unpacked app; `--installer` for dmg and zip, NSIS or AppImage). `--no-package` stops after the stamp | 0 built, 1 failed, 2 usage      |
| `pnpm start`        | `cc-start [--out <dir>] [--] [app args]`              | Runs the packaged app from `dist/` in the foreground; everything else goes to the app (`--profile-dir <dir>`, `--smoke`)                                                                                                                                                                                                                                                                                                                                                                    | 0, 1 no build or the app failed |
| `pnpm check`        | `cc-build check`                                      | The config, type-check and UI check steps of `build` only: for the engine's CI ("validate cc.config and the extension files", 08 §9)                                                                                                                                                                                                                                                                                                                                                        | 0, 1, 2                         |
| `pnpm cc:upgrade`   | `cc-upgrade [--to <version>] [--check]`               | Runs the foundation's codemods from the engine's `extensionApi` to the installed foundation's API, then the engine's type-check. `--check` writes nothing and lists the planned edits and the upstream changes to ejected screens, for the engine's CI on dependency PRs                                                                                                                                                                                                                    | see below                       |
| `pnpm cc:eject`     | `cc-eject <screen>`                                   | Copies one default screen of the installed `@cc/ui` into `ui/screens/` and records it in `ui/.cc-ui.json` (below)                                                                                                                                                                                                                                                                                                                                                                           | 0, 1 failed, 2 not a screen     |
| `pnpm cc:ui-update` | `cc-ui-update [<screen>...]`                          | Merges upstream changes into the ejected screens (all of them when none is named), 3-way (below)                                                                                                                                                                                                                                                                                                                                                                                            | 0, 1 conflicts left, 2 usage    |
| (diagnostic)        | `cc-build start-check [--stamp <file>]`               | Prints the start mode the build in `dist/` would get, and whether Rebuild now is offered                                                                                                                                                                                                                                                                                                                                                                                                    | 0                               |

### `cc-upgrade` exit codes (ADR 0003 decision 6, owner decision D-1)

- **0**: the engine is already on the foundation's extension API and no site is marked for a
  person; or the upgrade was written, the type-check passed and no site was left.
- **1**: `--check` found an upgrade due (the output lists the edits, and the upstream changes
  to ejected screens; the engine's CI comments them on the dependency PR, which still merges as
  it is); or a site needs a person (it is marked `/* cc:upgrade TODO(API n): ... */` and listed,
  or an ejected screen holds an unresolved merge of `cc-ui-update`); or the type-check failed; or the
  engine's API is outside what this foundation can upgrade; or `--to` names a version other
  than the installed one.
- **2**: usage error.

```text
$ pnpm cc:upgrade --check
cc-upgrade --check: engine on API 1, foundation 2.0.0 is on API 2: 6 edits in 3 files would be made, 0 need a person
  API 1 -> 2: dashboard slots become home slots; widgets call token()
  cc.config.ts: 2 edits
  theme/tokens.json: 1 edit
  ui/header.ts: 3 edits
  run pnpm cc:upgrade locally to apply them (owner decision D-1)
$ pnpm cc:upgrade
cc-upgrade: API 1 -> 2: 6 edits in 3 files (41 ms)
  ...
cc-upgrade: type-check passed (180 ms)
$ pnpm cc:upgrade
cc-upgrade: ok  engine already on extension API 2 (foundation 2.0.0); nothing to do
```

Extension API 1 is the first version, so this foundation ships no codemods yet
(`src/codemods/index.ts`). The runner is proven against a fixture foundation at API 2 and a
fixture engine at API 1 whose `ui/` (a composition root and an ejected screen) the fixture
codemod moves too (`test/upgrade.test.ts`, AC-08-10).

## Ejected screens (`cc-eject`, `cc-ui-update`; ADR 0008 decision 1)

An engine that wants to change a default screen beyond `createApp(overrides)` and its own
stylesheet takes a copy of it, and the copy is tracked against its upstream (`src/eject.ts`):

- `cc-eject <screen>` copies the screen's source from the installed `@cc/ui` (which ships
  `src/`) to the same path under `ui/` (`screens/home.ts` becomes `ui/screens/home.ts`), with the
  modules under `screens/` only it uses (Settings brings `settings-agents.ts`,
  `settings-backups.ts` and `settings-parts.ts`). Its imports of the default UI's own modules
  (`../app/screen.js`, `../ui/parts.js`) become `@cc/ui/v<N>`, which exports everything a default
  screen imports, so the copy type-checks and passes the D3 check as it is. It refuses to
  overwrite a file the engine has. Using the copy is the engine's choice: pass it to
  `createApp({ screens: { home: homeScreen } })` in `ui/app.ts`.
- `ui/.cc-ui.json` records each ejected screen: the `@cc/ui` version and extension API it was
  taken (or last merged) from, and the sha256 of each upstream file. The upstream text itself
  is kept as `ui/.cc-ui/base/<path>.base` (an extension no tool compiles or lints), the base of
  the next merge. Both are written by the commands and committed with the engine; neither is
  edited by hand.
- `cc-upgrade` (both modes) compares each ejected screen with the installed `@cc/ui` and lists
  the files that changed upstream, with their added and removed lines and whether the engine
  changed its copy too; it predicts the merge, so the CI comment on a dependency PR says whether
  `cc-ui-update` will need a person. `--check` exits 1 when a screen changed upstream.
- `cc-ui-update [<screen>...]` merges each changed file, 3-way and line by line (`src/merge3.ts`,
  no git needed): base the recorded upstream, ours the engine's copy, theirs the new upstream. A
  copy the engine never changed takes the new upstream as it is; a module the screen starts to
  use is added; one it stops using stays in the engine, no longer tracked; a region both sides
  changed differently is written with git's markers (diff3 style, with the base between), and
  the command exits 1. The manifest and the base move to the new upstream either way, and
  `cc-upgrade` lists any marker left in an ejected file and exits 1 until a person resolves it.

```text
$ pnpm cc:eject home
cc-eject: home ejected from @cc/ui 1.0.0 (1 file); recorded in ui/.cc-ui.json
  ui/screens/home.ts
  use it in ui/app.ts: import { homeScreen } from './screens/home.js'; createApp({ screens: { home: homeScreen } })
  pnpm cc:upgrade --check lists upstream changes to it; pnpm cc:ui-update merges them
$ pnpm cc:upgrade --check   # on the dependency PR that brings @cc/ui 1.1.0
cc-upgrade --check: engine on extension API 1 (foundation 1.1.0); 1 ejected screen changed upstream
  ejected screen home changed upstream (@cc/ui 1.0.0 -> 1.1.0):
    ui/screens/home.ts: changed upstream (+1 -1 lines); changed here too, merges cleanly
  run pnpm cc:ui-update locally to merge them
$ pnpm cc:ui-update
cc-ui-update: 1 file merged, 0 with conflicts
  home: @cc/ui 1.0.0 -> 1.1.0
    ui/screens/home.ts: merged
  run pnpm check
```

They are proven against the real `@cc/ui` installed in a fixture engine, with the engine's real
type-check and D3 check (`test/eject.test.ts`), and against a fixture foundation at API 2 with
a fixture engine whose ejected screen a codemod moves from API 1 (`test/upgrade.test.ts`,
AC-08-10).

## What the desktop shell runs (`@cc/build-runtime`)

`@cc/desktop` main calls these (`apps/desktop/src/main/start-mode.ts`, `rebuild-offer.ts`):

- `checkStart(readBuildStamp(<app.asar>/cc-build-stamp.json))` at every start, in parallel
  with creating the window, and again every 10 minutes when idle (for the offer only; the
  mode is decided once). It resolves to `{ mode, offerRebuild, head }`.
- `rebuildNow({ stamp, buildsDir: <userData>/builds, backup })` when the user chooses
  Rebuild now in the window or the tray. The backup is P1-17's; until then the shell logs that
  it was skipped. It runs pnpm with the Node and pnpm the build recorded (`stamp.toolchain`),
  since an app started from the Dock or the Start menu has neither on its PATH. It refuses a dirty checkout, takes the backup, writes the committed tree at
  HEAD into a new directory under `buildsDir` through a temporary index (never writing the
  checkout), runs `pnpm install --frozen-lockfile` and `cc-build build --rebuild-of
<checkout>@<commit>` there, and returns the packaged app or the log of the failure.
- `restartWhenIdle({ isIdle, restart })` restarts on the new build at the first idle moment:
  no meeting `in_progress` and no run in flight (the core's `busy()`, asked through the core
  host), with `app.relaunch` on the new build's executable.

## What the start check decides (ADR 0004)

Normal only when all of these hold; anything else is developer mode with the reasons:

- the build stamp exists and says the tree was clean and matched its install;
- HEAD, read from `.git` without spawning git, is the build commit, or moved only by
  runtime-read files (`connectors.lock`);
- hardened `git status --porcelain=v2 -z --untracked-files=all` reports nothing;
- `git ls-files -v` shows no assume-unchanged or skip-worktree entry;
- `.git/info/exclude` has no active pattern, and no merge, rebase, cherry-pick, revert or
  bisect is in progress;
- the install stamp matches the lockfiles (for a build made in the checkout).

"build out of date" (HEAD moved, the install drifted, or the build was made from a tree that
was not clean) on an otherwise clean checkout sets `offerRebuild`. A dirty checkout never gets
the offer.

## Packaging and hardening

`builderConfig()` gives every build: the asar; the fuses of 04 §10 rule 5 through
electron-builder's `electronFuses` (RunAsNode off, EnableNodeOptionsEnvironmentVariable off,
EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on,
OnlyLoadAppFromAsar on); Electron `ELECTRON_VERSION`; the `commandcenter://` scheme; the
native rebuild of `better-sqlite3`; and only git's view of the tree plus the generated files
(`cc-build-stamp.json`, `cc.config.json`, `cc-theme.css` and the engine's UI in `cc-ui/`) in the app. The runtime hardening (contextIsolation,
sandbox, CSP, navigation and permission handlers, the WebRTC policy and the no-network
renderer session) is in `@cc/desktop` main, which every build packages.

Electron's other fuses keep their defaults; `GrantFileProtocolExtraPrivileges` stays on
because the design does not list it. The app is served from `app://`, so turning it off is a
candidate addition to 04 §10 rule 5 once the shell (P1-10) confirms nothing needs `file://`.

The engine's theme tokens are compiled at build time to `cc-theme.css` (`--cc-*` custom
properties) under a closed grammar (`src/theme.ts`, ADR 0003 decision 4); the shell serves it
as `/theme.css`; the token paths are `@cc/ui-sdk/v1`'s, the ones its `token()` reads. Not yet
here: the full `cc.config` schema (P1-18; until then the build checks the version, that the
config is plain data, and the `ui` setting below).

## The engine's UI (ADR 0008 decision 1, rule D3)

After the type-check, `cc-build` bundles the engine's composition root, `ui/app.ts` (or
`ui/app.tsx`), with esbuild into one ES module and one stylesheet (the CSS its modules import),
and packs them as `cc-ui/index.js` and `cc-ui/app.css` at the app's root (`src/ui.ts`). Main
serves them as `/ui/index.js` and `/ui/app.css` in a page shell it keeps (the HTML, the CSP, no
inline script, the developer-mode banner and the Rebuild now strip). An engine with no
`ui/app.ts`, such as the template's empty `ui/`, packs no `cc-ui/`, and the app runs the
default UI; the build says which.

The bundle passes the D3 check over esbuild's metafile (ADR 0003 decision 8 as ADR 0008
extends it), or the build fails before anything is packaged:

- a file of `ui/` imports only other files of `ui/`, `@cc/ui-sdk/v<N>`, `@cc/ui/v<N>` and the
  default UI's stylesheet `@cc/ui/v<N>/app.css` for an extension API `N` the foundation builds
  (see `packages/ui/README.md` for composing the default UI), and the UI libraries the engine names in
  `cc.config.ts` (any subpath of them); `@cc/schemas` is types only (`import type`);
- a package file imports its own files and other packages (a UI library's own dependencies),
  but no foundation runtime package other than `@cc/ui-sdk` and `@cc/ui`;
- nothing imports a Node built-in (`node:*`) or leaves an import outside the bundle, and no
  file of `ui/` that git ignores is bundled (ADR 0004 decision 4);
- it fails closed: every file esbuild bundled must be one the check reached from the entry.

```ts
// cc.config.ts
export default {
  extensionApi: 1,
  ui: { libraries: ['preact'] }, // the UI libraries ui/ may import; none by default
};
```

```text
$ pnpm build
cc-build: type-check passed (180 ms)
cc-build: ui/app.ts bundled (6 ui/ file(s), 14 package file(s); index.js 48.2 kB, app.css 3.1 kB); the app runs the engine's UI
...
$ pnpm build   # ui/screens/home.ts imports node-fetch
cc-build: ui: ui/screens/home.ts: node-fetch is not on the UI import allowlist; name it in cc.config.ts ui.libraries if it is a UI library (D3)
```

`cc-build check` runs the same bundle and check and writes nothing. The run-time boundary is
main's whatever the bundle holds: the CSP, no network, no WebRTC and the `window.cc` method
allowlist (04 §10 rule 5).
