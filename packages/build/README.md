# @cc/build

The foundation's build tooling for an engine repository (04 §10, 08 §4.1, 08 §6): the
electron-builder configuration with the hardening and fuses every engine build gets, the
build and install stamps and the clean-tree start check (ADR 0004), Rebuild now and the
idle restart, and `cc:upgrade` with its codemod runner (ADR 0003 decision 6).

The engine holds no script code (08 §6): each of its scripts calls one bin this package
installs, `cc-build`, `cc-start`, `cc-install-stamp` or `cc-upgrade`, and passes the user's
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
    "cc:upgrade": "cc-upgrade"
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
foundation's own does.

The engine also needs `"type": "module"` in its `package.json` (the build imports
`cc.config.ts` with Node's type stripping), `dist/` in its `.gitignore` (the build output), a
`tsconfig.json` (the type-check), and `extensionApi: <N>` in `cc.config.ts`.

| Engine script     | Command                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                | Exit codes                      |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `postinstall`     | `cc-install-stamp`                                    | Writes `node_modules/.cc-install-stamp.json`: the sha256 of `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` (ADR 0004 decision 2). An install with `--ignore-scripts` leaves no stamp, and the app then starts in developer mode                                                                                                                                                                                                 | 0                               |
| `pnpm build`      | `cc-build [--out <dir>] [--no-package] [--installer]` | Checks `extensionApi` (warns when deprecated, fails when unsupported), loads `cc.config.ts` into `cc.config.json`, compiles `theme/tokens.json` into `cc-theme.css`, runs the engine's `tsc --noEmit`, inspects the tree, writes the build stamp, and packages git's view of the tree with electron-builder into `dist/` (default: the unpacked app; `--installer` for dmg and zip, NSIS or AppImage). `--no-package` stops after the stamp | 0 built, 1 failed, 2 usage      |
| `pnpm start`      | `cc-start [--out <dir>] [--] [app args]`              | Runs the packaged app from `dist/` in the foreground; everything else goes to the app (`--profile-dir <dir>`, `--smoke`)                                                                                                                                                                                                                                                                                                                    | 0, 1 no build or the app failed |
| `pnpm check`      | `cc-build check`                                      | The config and type-check steps of `build` only: for the engine's CI ("validate cc.config and the extension files", 08 §9)                                                                                                                                                                                                                                                                                                                  | 0, 1, 2                         |
| `pnpm cc:upgrade` | `cc-upgrade [--to <version>] [--check]`               | Runs the foundation's codemods from the engine's `extensionApi` to the installed foundation's API, then the engine's type-check. `--check` writes nothing and lists the planned edits, for the engine's CI on dependency PRs                                                                                                                                                                                                                | see below                       |
| (diagnostic)      | `cc-build start-check [--stamp <file>]`               | Prints the start mode the build in `dist/` would get, and whether Rebuild now is offered                                                                                                                                                                                                                                                                                                                                                    | 0                               |

### `cc-upgrade` exit codes (ADR 0003 decision 6, owner decision D-1)

- **0**: the engine is already on the foundation's extension API and no site is marked for a
  person; or the upgrade was written, the type-check passed and no site was left.
- **1**: `--check` found an upgrade due (the output lists the edits; the engine's CI comments
  them on the dependency PR, which still merges as it is); or a site needs a person (it is
  marked `/* cc:upgrade TODO(API n): ... */` and listed); or the type-check failed; or the
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
fixture engine at API 1 (`test/upgrade.test.ts`, AC-08-10).

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
(`cc-build-stamp.json`, `cc.config.json`) in the app. The runtime hardening (contextIsolation,
sandbox, CSP, navigation and permission handlers, the WebRTC policy and the no-network
renderer session) is in `@cc/desktop` main, which every build packages.

Electron's other fuses keep their defaults; `GrantFileProtocolExtraPrivileges` stays on
because the design does not list it. The app is served from `app://`, so turning it off is a
candidate addition to 04 §10 rule 5 once the shell (P1-10) confirms nothing needs `file://`.

The engine's theme tokens are compiled at build time to `cc-theme.css` (`--cc-*` custom
properties) under a closed grammar (`src/theme.ts`, ADR 0003 decision 4); the shell serves it
as `/theme.css`. Not yet here: building the engine's `ui/` widgets into the renderer, which
needs `@cc/ui-sdk/v1` (a stub today; the build lists any widget file it finds instead of
dropping it silently), and the full `cc.config` schema (P1-18; until then the build checks the
version and that the config is plain data).
