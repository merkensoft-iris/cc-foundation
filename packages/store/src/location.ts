/**
 * Where the store lives and where it refuses to live (04 §9).
 *
 * `workspace.db` and its WAL file sit in `<userData>`, next to the content-addressed blob
 * directory. 04 §9 rule 5: `<userData>` must not sit inside a synced folder, because
 * file-level sync corrupts a live SQLite database and its WAL, so opening the store there is
 * refused with help to move it. A sync root is recognised by its name (a path segment such as
 * `Dropbox`), by the environment variable a sync client sets, or by the marker a sync client
 * keeps in the root of the folder it syncs (`.dropbox`, Google Drive's `.tmp.drivedownload`).
 * Backups (P1-17) write only finished, encrypted archives to a synced folder; this module
 * refuses the live store there.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { StoreError } from './errors.js';

export const WORKSPACE_DB = 'workspace.db';
export const BLOBS_DIRNAME = 'blobs';

/** One known sync root, matched against a single path segment, case-insensitively. */
export interface SyncRoot {
  /** What the user calls it, used in the error. */
  readonly label: string;
  /** Matches one whole path segment. */
  readonly segment: RegExp;
}

/**
 * The sync roots CC checks for (04 §9 rule 5). Matching is per path segment, so a directory
 * merely called `my-dropbox-notes` is not a match.
 */
export const SYNC_ROOTS: readonly SyncRoot[] = [
  { label: 'Google Drive', segment: /^(?:Google ?Drive|GoogleDrive-.+|My Drive)$/i },
  { label: 'Dropbox', segment: /^Dropbox(?: \(.+\))?$/i },
  { label: 'OneDrive', segment: /^OneDrive(?: ?-.+)?$/i },
  { label: 'iCloud Drive', segment: /^(?:iCloud ?Drive|Mobile Documents)$/i },
  { label: 'Box', segment: /^Box(?: Sync)?$/i },
  { label: 'pCloud', segment: /^pCloud ?Drive$/i },
  { label: 'MEGA', segment: /^MEGA(?:sync)?$/i },
  { label: 'Nextcloud', segment: /^Nextcloud$/i },
  { label: 'ownCloud', segment: /^ownCloud$/i },
  { label: 'Proton Drive', segment: /^Proton ?Drive$/i },
  { label: 'Tresorit', segment: /^Tresorit$/i },
  { label: 'Yandex.Disk', segment: /^Yandex\.?Disk$/i },
  { label: 'Creative Cloud Files', segment: /^Creative Cloud Files(?: .+)?$/i },
  { label: 'Seafile', segment: /^Seafile$/i },
  { label: 'Jottacloud', segment: /^Jottacloud$/i },
  // macOS puts every File Provider client (Google Drive, OneDrive, Dropbox) under this root.
  { label: 'a cloud storage provider', segment: /^CloudStorage$/i },
];

/** The environment variables whose value, when set, is the root of a synced folder. */
export const SYNC_ROOT_ENV_VARS = [
  'OneDrive',
  'OneDriveConsumer',
  'OneDriveCommercial',
  'iCloudDrive',
] as const;

/**
 * Files or folders a sync client keeps in the root of the folder it syncs (04 §9 rule 5,
 * AC-04-12). A directory holding one of them is a sync root, whatever it is called.
 */
export const SYNC_MARKERS: readonly { readonly label: string; readonly name: string }[] = [
  { label: 'Dropbox', name: '.dropbox' },
  { label: 'Dropbox', name: '.dropbox.cache' },
  { label: 'Google Drive', name: '.tmp.drivedownload' },
  { label: 'Google Drive', name: '.tmp.driveupload' },
  { label: 'Google Drive', name: '.shortcut-targets-by-id' },
  { label: 'OneDrive', name: '.849C9593-D756-4E56-8D6E-42412F2A707B' },
];

export interface SyncedFolderMatch {
  readonly label: string;
  /** The path segment or environment root that matched. */
  readonly matched: string;
}

function segments(path: string): string[] {
  return resolve(path)
    .split(/[\\/]/)
    .filter((part) => part !== '');
}

/** True when `child` is `parent` or sits inside it. */
function isInside(child: string, parent: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`);
}

/** The sync-root marker in `path` or in one of its ancestors (AC-04-12). */
function markerMatch(path: string): SyncedFolderMatch | undefined {
  let dir = resolve(path);
  for (;;) {
    for (const marker of SYNC_MARKERS) {
      if (existsSync(join(dir, marker.name))) return { label: marker.label, matched: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The sync root `path` sits in, or `undefined` when it sits in none (04 §9 rule 5).
 * `env` is passed in so the check is testable without touching the process environment.
 */
export function syncedFolderMatch(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): SyncedFolderMatch | undefined {
  for (const part of segments(path)) {
    for (const root of SYNC_ROOTS) {
      if (root.segment.test(part)) return { label: root.label, matched: part };
    }
  }
  for (const name of SYNC_ROOT_ENV_VARS) {
    const root = env[name];
    if (root !== undefined && root !== '' && isInside(path, root)) {
      return { label: name, matched: root };
    }
  }
  return markerMatch(path);
}

/**
 * Refuses a data directory inside a synced folder (04 §9 rule 5, C-04-09). The help lines
 * say what to do, as 07 §4.4 requires.
 */
export function assertNotSyncedFolder(userDataDir: string, env?: NodeJS.ProcessEnv): void {
  const match = syncedFolderMatch(userDataDir, env);
  if (match === undefined) return;
  throw new StoreError(
    'E_GUARD_SYNCED_FOLDER',
    `the Command Center data directory ${userDataDir} is inside ${match.label} ("${match.matched}"); ` +
      'a live SQLite database and its WAL file are corrupted by file-level sync',
    [
      'move the data directory to a path that no sync client watches, then start CC again',
      'only finished, encrypted backup archives may be written to a synced folder (04 §9.1)',
    ],
  );
}

/** `<userData>/workspace.db` (04 §9). */
export function workspaceDbPath(userDataDir: string): string {
  return resolve(userDataDir, WORKSPACE_DB);
}

/** `<userData>/blobs` (03 §12 point 1). */
export function blobsDir(userDataDir: string): string {
  return resolve(userDataDir, BLOBS_DIRNAME);
}

/** `blobs/<sha256[0:2]>/<sha256>` (03 §12 point 1). */
export function blobPath(blobsRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new StoreError('E_USAGE', `not a lower-case hex SHA-256: ${sha256}`, [
      'blob references are the 64-character lower-case hex digest of the file (03 §3)',
    ]);
  }
  return resolve(blobsRoot, sha256.slice(0, 2), sha256);
}

/** Refuses a relative data directory: every store path is absolute (04 §9). */
export function assertAbsolute(userDataDir: string): void {
  if (!isAbsolute(userDataDir)) {
    throw new StoreError('E_USAGE', `the data directory must be an absolute path: ${userDataDir}`, [
      'pass <userData> from app.getPath("userData"), or --profile-dir with an absolute path',
    ]);
  }
}
