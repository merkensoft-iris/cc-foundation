/**
 * @cc/build: electron-builder config, fuses, hardening, clean-tree check (08 §4.1), and the
 * engine-facing commands `cc-build`, `cc-start`, `cc-install-stamp`, `cc-upgrade`, `cc-eject` and `cc-ui-update` (08 §6).
 * See README.md.
 *
 * The fuse list of 04 §10 rule 5 is from P1-10. P1-16 adds packaging, the build and install
 * stamps and the clean-tree start check (ADR 0004), Rebuild now and the idle restart
 * (04 §10 rule 2), and `cc:upgrade` with its codemod runner (ADR 0003 decision 6). P1-25 adds
 * the engine UI bundle under the D3 allowlist (ADR 0008 decision 1). P1-27 adds ejected screens:
 * `cc-eject`, the `ui/.cc-ui.json` manifest, their upstream changes in `cc-upgrade --check` and
 * the 3-way merge of `cc-ui-update`.
 */
export const PACKAGE_NAME = '@cc/build';

export { REQUIRED_FUSES, type RequiredFuse } from './fuses.js';
export {
  APP_ID,
  builderConfig,
  DEEP_LINK_SCHEME,
  DESKTOP_MAIN,
  ELECTRON_VERSION,
  electronFuses,
  EXECUTABLE_NAME,
  PRODUCT_NAME,
  type BuilderConfigOptions,
} from './builder-config.js';
export {
  runBuild,
  STAGE_DIR,
  type BuildOptions,
  type CommandResult,
  type Packager,
} from './build.js';
export { TODO_MARKER, type Codemod, type CodemodContext } from './codemod.js';
export { CODEMODS } from './codemods/index.js';
export { CONFIG_FILE, readExtensionApi, validateEngineConfig } from './engine-config.js';
export {
  currentFoundation,
  judgeExtensionApi,
  type ApiVerdict,
  type Foundation,
} from './foundation.js';
export { CC_START_USAGE, parseStartArgs, runStart, type StartArgs } from './start.js';
export { ccBuild, ccEject, ccInstallStamp, ccStart, ccUiUpdate, ccUpgrade } from './cli.js';
export {
  DEFAULT_UI_PACKAGE,
  defaultScreens,
  ejectedText,
  findDefaultUi,
  readUiManifest,
  runEject,
  runUiUpdate,
  screenSources,
  UI_BASE_DIR,
  UI_MANIFEST,
  uiDrift,
  type DefaultUi,
  type EjectedScreen,
  type EjectOptions,
  type UiDrift,
  type UiManifest,
  type UiUpdateOptions,
} from './eject.js';
export {
  diffLines,
  lineChanges,
  merge3,
  type Hunk,
  type MergeLabels,
  type MergeResult,
} from './merge3.js';
// The runtime half (stamps, the start check, Rebuild now, the idle restart) lives in
// @cc/build-runtime so the packaged app never carries the build tooling; re-exported here.
export {
  BUILD_STAMP,
  checkStart,
  findPackagedApp,
  IDLE_POLL_MS,
  inspectTree,
  INSTALL_STAMP,
  installDrift,
  LOCKFILES,
  readBuildStamp,
  REASON_STALE,
  rebuildNow,
  restartWhenIdle,
  RUNTIME_READ_FILES,
  writeInstallStamp,
  type BuildStamp,
  type IdleRestartOptions,
  type InstallStamp,
  type RebuildCommand,
  type RebuildOptions,
  type RebuildResult,
  type StartCheckResult,
  type StartMode,
} from '@cc/build-runtime';
export {
  compileEngineTheme,
  compileTokens,
  cssVariableName,
  THEME_CSS,
  TOKEN_PATHS,
  TOKEN_VALUE_PATTERNS,
  TOKENS_FILE,
  type CompiledTheme,
  type TokenPath,
} from './theme.js';
export {
  bundleEngineUi,
  checkUiMetafile,
  ENGINE_UI_DIR,
  ENGINE_UI_SCRIPT,
  ENGINE_UI_STYLES,
  engineImportProblem,
  UI_CONTRACT_PACKAGES,
  UI_ENTRIES,
  uiConfigProblems,
  uiLibraries,
  type BundleUiOptions,
  type UiAllowlist,
  type UiBundle,
  type UiCheck,
} from './ui.js';
export { runUpgrade, type UpgradeOptions } from './upgrade.js';
