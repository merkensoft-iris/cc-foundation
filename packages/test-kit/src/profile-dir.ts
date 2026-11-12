import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * UNIX socket path limit in bytes: 104 on macOS, 108 on Linux (08 §6, `cc:doctor`).
 * Windows uses named pipes, which have no such limit; 108 is used there as a plain bound.
 */
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108;

/**
 * Base directory for test profile directories (08 §8 item 6): `/tmp` on macOS and Linux,
 * because macOS's default temp directory is long enough to push a socket path past 104
 * bytes, and `%TEMP%` on Windows.
 */
export function profileBaseDir(): string {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

export interface ProfileDir {
  /** Absolute path of a new, empty directory owned by one test. */
  readonly path: string;
  /** Removes the directory and everything in it. */
  cleanup(): void;
}

/**
 * Creates a fresh profile directory (`cc-test-<random>`) for one test. Tests never share a
 * profile directory or use a fixed path, so two worktrees can run the suite at once
 * (C-08-05, AC-08-04).
 */
export function createProfileDir(): ProfileDir {
  const path = mkdtempSync(join(profileBaseDir(), 'cc-test-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
