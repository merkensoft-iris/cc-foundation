/**
 * The electron-builder configuration every engine build uses (04 §10 rules 1 and 5).
 *
 * The hardening that is a property of the packaged binary lives here: the asar, and the
 * fuses of `fuses.ts`, which electron-builder flips in the Electron binary after packing
 * (`electronFuses`). The rest of the hardening (contextIsolation, sandbox, CSP, navigation
 * and permission handlers, the WebRTC policy and the no-network renderer session of ADR 0003
 * decision 9) is in `@cc/desktop` main, which every build packages.
 *
 * Signing is optional for a personal build (OQ-08-03), so the config never asks for a
 * certificate; electron-builder signs when the environment provides one.
 */
import { APP_ID, EXECUTABLE_NAME, PRODUCT_NAME } from '@cc/build-runtime';
import type { Configuration } from 'electron-builder';

import { REQUIRED_FUSES } from './fuses.js';

export { APP_ID, EXECUTABLE_NAME, PRODUCT_NAME };

/** The Electron version every build packages; the same pin as `@cc/desktop` (P1-10). */
export const ELECTRON_VERSION = '45.2.3';

export const DEEP_LINK_SCHEME = 'commandcenter';

/**
 * The entry point inside the packaged app: `@cc/desktop`'s `main` (its package.json), which
 * the engine pins as a production dependency so electron-builder packs it with the core.
 */
export const DESKTOP_MAIN = 'node_modules/@cc/desktop/dist/main/index.js';

export interface BuilderConfigOptions {
  /** The engine checkout (electron-builder's project directory). */
  readonly projectDir: string;
  /** Where the packaged app goes. */
  readonly outDir: string;
  /** Generated files (build stamp, cc.config.json) added at the app root. */
  readonly stageDir: string;
  /** The engine files to pack, relative to projectDir: git's view of the tree. */
  readonly files: readonly string[];
  /** Installers (dmg and zip, NSIS, AppImage) instead of the unpacked app. */
  readonly installer?: boolean;
}

/** electron-builder's fuse options, from the design's list (04 §10 rule 5). */
export function electronFuses(): NonNullable<Configuration['electronFuses']> {
  return {
    runAsNode: REQUIRED_FUSES.RunAsNode,
    enableNodeOptionsEnvironmentVariable: REQUIRED_FUSES.EnableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: REQUIRED_FUSES.EnableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: REQUIRED_FUSES.EnableEmbeddedAsarIntegrityValidation,
    onlyLoadAppFromAsar: REQUIRED_FUSES.OnlyLoadAppFromAsar,
  };
}

/** Escapes glob syntax so each git-view path matches only itself. */
function literalGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, (char) => `\\${char}`);
}

export function builderConfig(options: BuilderConfigOptions): Configuration {
  const unpacked = options.installer !== true;
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    executableName: EXECUTABLE_NAME,
    electronVersion: ELECTRON_VERSION,
    extraMetadata: { main: DESKTOP_MAIN },
    directories: { output: options.outDir },
    // Only git's view of the tree, never an ignored file (ADR 0004 decision 4); production
    // dependencies from node_modules are added by electron-builder.
    files: [
      'package.json',
      ...options.files.filter((file) => file !== 'package.json').map(literalGlob),
      { from: options.stageDir, to: '.', filter: ['**/*'] },
    ],
    asar: true,
    electronFuses: electronFuses(),
    // better-sqlite3 is rebuilt for Electron's Node (08 §3).
    npmRebuild: true,
    protocols: [{ name: PRODUCT_NAME, schemes: [DEEP_LINK_SCHEME] }],
    publish: null,
    mac: {
      category: 'public.app-category.productivity',
      hardenedRuntime: true,
      target: unpacked ? ['dir'] : ['dmg', 'zip'],
    },
    win: { target: unpacked ? ['dir'] : ['nsis'] },
    linux: { target: unpacked ? ['dir'] : ['AppImage'], category: 'Office' },
  };
}
