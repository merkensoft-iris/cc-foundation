/**
 * pnpm dev [--keep-profile]: builds the desktop shell and runs it against a throwaway
 * profile (AGENTS.md; 08 §8 item 6): a new `cc-dev-<random>` directory under `/tmp` on macOS
 * and Linux (short, so the socket path fits) or `%TEMP%` on Windows, passed as
 * `--profile-dir`. The profile is removed when the app exits unless `--keep-profile` is given.
 *
 * The first run downloads the Electron binary (the `electron` package fetches it on first
 * use); `pnpm --filter @cc/desktop exec install-electron` does it ahead of time.
 *
 * Exit codes follow 08 §6: the app's exit code, 1 when the build fails, 2 usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--keep-profile');
if (unknown.length > 0) {
  console.error(`usage: pnpm dev [--keep-profile] (unknown: ${unknown.join(' ')})`);
  process.exit(2);
}
const keepProfile = args.includes('--keep-profile');
const windows = process.platform === 'win32';

const build = spawnSync('pnpm', ['--silent', '--filter', '@cc/desktop...', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: windows,
});
if (build.status !== 0) process.exit(1);

const desktop = join(root, 'apps', 'desktop');
// From Node, the electron package exports the binary's path (downloading it on first use).
const electron = createRequire(join(desktop, 'package.json'))('electron') as string;
const profileDir = mkdtempSync(join(windows ? tmpdir() : '/tmp', 'cc-dev-'));
console.log(`pnpm dev: profile ${profileDir}${keepProfile ? ' (kept)' : ''}`);

const app = spawn(
  electron,
  [join(desktop, 'dist', 'main', 'index.js'), '--profile-dir', profileDir],
  {
    cwd: desktop,
    stdio: 'inherit',
  },
);
const forward = (signal: NodeJS.Signals) => () => app.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
app.on('exit', (code) => {
  if (!keepProfile) rmSync(profileDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
