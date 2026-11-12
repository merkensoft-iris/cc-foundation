/**
 * @cc/build-runtime: the part of `@cc/build` (08 §4.1) that the packaged app runs: the build
 * and install stamps and the clean-tree start check (ADR 0004), Rebuild now and the idle
 * restart (04 §10 rule 2).
 *
 * It has no dependencies. `@cc/desktop` imports it, and electron-builder packs the engine's
 * production dependencies into the app, so the build tooling (electron-builder, ts-morph)
 * stays in `@cc/build`, which the engine installs as a development dependency only.
 */
export const PACKAGE_NAME = '@cc/build-runtime';

export {
  findOnPath,
  gitLayout,
  gitViewFiles,
  hardenedArgs,
  NULL_FILE,
  readHead,
  runGit,
  type GitLayout,
  type GitResult,
} from './git.js';
export { restartWhenIdle, IDLE_POLL_MS, type IdleRestartOptions } from './idle-restart.js';
export {
  APP_ID,
  EXECUTABLE_NAME,
  findPackagedApp,
  PRODUCT_NAME,
  THEME_CSS,
} from './packaged-app.js';
export {
  defaultBuild,
  DEFAULT_INSTALL,
  pnpmCommand,
  rebuildNow,
  type RebuildCommand,
  type RebuildOptions,
  type RebuildResult,
} from './rebuild.js';
export {
  BUILD_STAMP,
  currentToolchain,
  hashLockfiles,
  INSTALL_STAMP,
  installDrift,
  LOCKFILES,
  lockfileDigest,
  readBuildStamp,
  readInstallStamp,
  sha256,
  writeBuildStamp,
  writeInstallStamp,
  type BuildInstall,
  type BuildStamp,
  type BuildToolchain,
  type InstallStamp,
  type LockfileHashes,
} from './stamps.js';
export {
  checkStart,
  inspectTree,
  REASON_STALE,
  RUNTIME_READ_FILES,
  type StartCheckResult,
  type StartMode,
  type TreeInspection,
} from './start-check.js';
