/**
 * The install stamp and the build stamp (ADR 0004 decisions 1 and 2).
 *
 * - The **install stamp** is written by the engine's root `postinstall` (`cc-build
 *   install-stamp`) after every `pnpm install`: the sha256 of the three lockfiles, in
 *   `node_modules/.cc-install-stamp.json`. At start, rehashing the three files and comparing
 *   tells whether the install matches the checkout (ADR 0004 method L1, about 0.6 ms).
 *   Installing with `--ignore-scripts` leaves no stamp, which safely starts developer mode.
 * - The **build stamp** is written by `cc-build build` into the app's resources, inside the
 *   asar so asar integrity covers it: the commit, the checkout and git paths, the lockfile
 *   hashes, the install, whether the tree was clean, and the build time.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The files whose hashes tie a build and an install to the checkout. */
export const LOCKFILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;

export const INSTALL_STAMP = 'node_modules/.cc-install-stamp.json';

/** The build stamp's name inside the packaged app. */
export const BUILD_STAMP = 'cc-build-stamp.json';

export type LockfileHashes = Readonly<Record<string, string | null>>;

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** sha256 of each lockfile in `root`; null for a file that does not exist. */
export function hashLockfiles(root: string): LockfileHashes {
  const hashes: Record<string, string | null> = {};
  for (const file of LOCKFILES) {
    const path = join(root, file);
    hashes[file] = existsSync(path) ? sha256(readFileSync(path)) : null;
  }
  return hashes;
}

/** One digest over the lockfile hashes, in a fixed order. */
export function lockfileDigest(hashes: LockfileHashes): string {
  return sha256(LOCKFILES.map((file) => `${file}\0${hashes[file] ?? '-'}\n`).join(''));
}

export interface InstallStamp {
  readonly stampVersion: 1;
  readonly lockfiles: LockfileHashes;
  readonly digest: string;
}

/** Writes the install stamp for the current lockfiles; returns it. */
export function writeInstallStamp(root: string): InstallStamp {
  const lockfiles = hashLockfiles(root);
  const stamp: InstallStamp = { stampVersion: 1, lockfiles, digest: lockfileDigest(lockfiles) };
  const path = join(root, INSTALL_STAMP);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

export function readInstallStamp(root: string): InstallStamp | null {
  try {
    const value = JSON.parse(readFileSync(join(root, INSTALL_STAMP), 'utf8')) as InstallStamp;
    return value.stampVersion === 1 && typeof value.digest === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Checks the install stamp against the checkout's lockfiles. Returns null when they match,
 * or the reason they do not.
 */
export function installDrift(root: string): string | null {
  const stamp = readInstallStamp(root);
  if (stamp === null) return 'install out of date: no install stamp (run pnpm install)';
  const current = hashLockfiles(root);
  if (lockfileDigest(current) === stamp.digest) return null;
  const changed = LOCKFILES.filter((file) => current[file] !== stamp.lockfiles[file]);
  return `install out of date: ${changed.join(', ')} changed since pnpm install`;
}

/** How the build's dependencies were installed. */
export type BuildInstall =
  /** `pnpm build` in the user's checkout: its install stamp at build time. */
  | { readonly kind: 'checkout'; readonly digest: string | null }
  /** Rebuild now: a frozen install from the committed lockfiles, in its own build directory. */
  | { readonly kind: 'rebuild' };

export interface BuildStamp {
  readonly stampVersion: 1;
  /** The engine commit the build was made from (HEAD at build time). */
  readonly commit: string | null;
  /** Absolute path of the engine checkout the start check inspects. */
  readonly checkout: string;
  /** Absolute path of git, found at build time; null when git was not found. */
  readonly git: string | null;
  readonly lockfiles: LockfileHashes;
  readonly install: BuildInstall;
  /** Whether the tree was clean and matched its install when the build was made. */
  readonly clean: boolean;
  /** Why it was not clean; empty when it was. */
  readonly dirtyReasons: readonly string[];
  readonly builtAt: string;
  /** The `@cc/build` version that made the build: the foundation version. */
  readonly foundation: string;
  readonly extensionApi: number;
  /**
   * The Node and pnpm that ran the build, so Rebuild now can run them from an app started
   * from the Dock or the Start menu, whose PATH has neither (and where pnpm is a `.cmd`
   * shim on Windows). Absent in stamps written before it was added.
   */
  readonly toolchain?: BuildToolchain;
}

export interface BuildToolchain {
  /** Absolute path of the Node binary that ran `cc-build build`. */
  readonly node: string;
  /** pnpm's entry point (`npm_execpath`: a .cjs/.js file run with `node`, or an executable). */
  readonly pnpm: string | null;
}

/** The toolchain of this process, as `cc-build build` records it. */
export function currentToolchain(env: NodeJS.ProcessEnv = process.env): BuildToolchain {
  const execPath = env['npm_execpath'];
  const pnpm =
    execPath !== undefined && /(?:^|[\\/])pnpm(?:\.[cm]?js|\.exe)?$/i.test(execPath)
      ? execPath
      : null;
  return { node: process.execPath, pnpm };
}

export function writeBuildStamp(dir: string, stamp: BuildStamp): string {
  const path = join(dir, BUILD_STAMP);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
  return path;
}

/** Reads a build stamp; null when it is missing or not a version-1 stamp. */
export function readBuildStamp(path: string): BuildStamp | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as BuildStamp;
    return value.stampVersion === 1 && typeof value.checkout === 'string' ? value : null;
  } catch {
    return null;
  }
}
