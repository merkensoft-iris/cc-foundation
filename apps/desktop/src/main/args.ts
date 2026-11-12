/**
 * Command-line options of the desktop shell.
 *
 * `--profile-dir <dir>` puts `<userData>` in `<dir>` instead of Electron's default (04 §9),
 * so `pnpm dev` and app tests run against a throwaway profile (AGENTS.md, 08 §8 item 6).
 * Electron's single-instance lock lives in `<userData>`, so two profiles are two instances.
 *
 * `--smoke` starts the shell, waits until the core is ready, a UI call has reached it and the
 * window has loaded, writes `<userData>/smoke.json` and exits 0 (1 on failure or after
 * `SMOKE_TIMEOUT_MS`). It is how CI proves a packaged build starts on macOS, Windows and
 * Linux (09 P1-16, AC-08-11). It needs `--profile-dir`, so it never opens a real profile, and
 * it skips nothing: no check, hardening step or confirmation is bypassed.
 */
import path from 'node:path';

export interface ShellArgs {
  readonly profileDir?: string;
  readonly smoke?: true;
}

export function parseShellArgs(argv: readonly string[]): ShellArgs {
  let profileDir: string | undefined;
  let smoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--smoke') {
      smoke = true;
      continue;
    }
    let value: string | undefined;
    if (arg === '--profile-dir') value = argv[index + 1];
    else if (arg.startsWith('--profile-dir=')) value = arg.slice('--profile-dir='.length);
    else continue;
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error('--profile-dir needs a directory');
    }
    profileDir ??= path.resolve(value);
  }
  if (smoke && profileDir === undefined) {
    throw new Error('--smoke needs --profile-dir: a smoke run never opens the real profile');
  }
  return {
    ...(profileDir === undefined ? {} : { profileDir }),
    ...(smoke ? { smoke: true as const } : {}),
  };
}
