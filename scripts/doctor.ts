/**
 * pnpm cc:doctor [--profile-dir <dir>]: checks the toolchain and local limits (08 §6).
 *
 * - Node and pnpm against the pins in .node-version and package.json (fail).
 * - The Electron native rebuild: every native module apps/desktop depends on loads in
 *   Electron's runtime (fail). Warns while Electron is not installed yet (P1).
 * - Playwright's Chromium is downloaded (fail). Warns while Playwright is not installed yet (P4).
 * - `claude --version` and `codex --version` when present; a missing AI CLI is optional (warn).
 * - The UNIX socket path `<profile>/run/cc.sock` (04 §4.1) for the default profile, the test
 *   profiles (08 §8 item 6) and --profile-dir fits the limit: 104 bytes on macOS, 108 on
 *   Linux (warn). Windows uses a named pipe, which has no such limit.
 *
 * Exit codes follow 08 §6: 0 no check failed (warnings allowed), 1 a check fails, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `actual` has the same major version as `pinned` and is not older. */
export function satisfiesPin(actual: Version, pinned: Version): boolean {
  if (actual[0] !== pinned[0]) return false;
  if (actual[1] !== pinned[1]) return actual[1] > pinned[1];
  return actual[2] >= pinned[2];
}

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

/** Runs a command and returns its first line of output, or undefined when it cannot run. */
export type Runner = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => string | undefined;

const run: Runner = (command, args, env) => {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
      // npm-style shims on Windows are .cmd files, which only a shell can start.
      shell: process.platform === 'win32',
    });
    return output.trim().split(/\r?\n/)[0] ?? '';
  } catch {
    return undefined;
  }
};

function checkNode(root: string): Check {
  const pinnedText = readFileSync(join(root, '.node-version'), 'utf8').trim();
  const pinned = parseVersion(pinnedText);
  const actual = parseVersion(process.versions.node);
  const ok = pinned !== undefined && actual !== undefined && satisfiesPin(actual, pinned);
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: `${process.versions.node} (pinned ${pinnedText}, same major or newer)`,
  };
}

function checkPnpm(root: string): Check {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const pinnedText = (manifest.packageManager ?? '').replace(/^pnpm@/, '');
  const pinned = parseVersion(pinnedText);
  const agent = /\bpnpm\/(\S+)/.exec(process.env['npm_config_user_agent'] ?? '');
  if (agent?.[1] === undefined) {
    return {
      name: 'pnpm',
      status: 'fail',
      detail: `not run through pnpm (pinned ${pinnedText}); use pnpm cc:doctor`,
    };
  }
  const actual = parseVersion(agent[1]);
  const ok = pinned !== undefined && actual !== undefined && satisfiesPin(actual, pinned);
  return {
    name: 'pnpm',
    status: ok ? 'ok' : 'fail',
    detail: `${agent[1]} (pinned ${pinnedText}, same major or newer)`,
  };
}

/** Resolves `specifier` as the package at `from` (a package.json path) would. */
function resolveFrom(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * The downloaded Electron binary, or `undefined`. It reads the package's `path.txt`, never
 * `require('electron')`: since Electron 45 that downloads the binary when it is missing, and
 * the doctor must not reach the network.
 */
export function electronBinary(electronPackageJson: string): string | undefined {
  const dir = dirname(electronPackageJson);
  let relative: string;
  try {
    relative = readFileSync(join(dir, 'path.txt'), 'utf8').trim();
  } catch {
    return undefined;
  }
  const distDir = process.env['ELECTRON_OVERRIDE_DIST_PATH'] ?? join(dir, 'dist');
  const binary = join(distDir, relative);
  return relative !== '' && existsSync(binary) ? binary : undefined;
}

/** Native modules the Electron main process loads; each must be rebuilt for Electron's ABI. */
export const NATIVE_MODULES = ['better-sqlite3'];

export function checkElectron(root: string, runner: Runner = run): Check {
  const desktop = join(root, 'apps', 'desktop', 'package.json');
  const electronPackage = resolveFrom(desktop, 'electron/package.json');
  if (electronPackage === undefined) {
    return {
      name: 'electron native rebuild',
      status: 'warn',
      detail: 'Electron is not installed in apps/desktop yet (P1); nothing to check',
    };
  }
  const electron = electronBinary(electronPackage);
  const manifest = JSON.parse(readFileSync(desktop, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const natives = NATIVE_MODULES.filter((name) => manifest.dependencies?.[name] !== undefined);
  if (electron === undefined) {
    return {
      name: 'electron native rebuild',
      status: natives.length === 0 ? 'warn' : 'fail',
      detail:
        'Electron binary not downloaded; `pnpm --filter @cc/desktop exec install-electron` ' +
        'fetches it (pnpm dev does on first run)',
    };
  }
  const broken = natives.filter((name) => {
    const entry = resolveFrom(desktop, name);
    if (entry === undefined) return true;
    const loaded = runner(
      electron,
      ['-e', `require(${JSON.stringify(entry)}); console.log('ok')`],
      {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    );
    return loaded !== 'ok';
  });
  if (broken.length > 0) {
    return {
      name: 'electron native rebuild',
      status: 'fail',
      detail: `${broken.join(', ')} not built for Electron; run pnpm install to rebuild`,
    };
  }
  return {
    name: 'electron native rebuild',
    status: 'ok',
    detail:
      natives.length === 0 ? 'no native modules yet' : `${natives.join(', ')} load in Electron`,
  };
}

export async function checkPlaywright(root: string): Promise<Check> {
  const host = join(root, 'packages', 'browser-host', 'package.json');
  const entry = resolveFrom(host, 'playwright-core') ?? resolveFrom(host, 'playwright');
  if (entry === undefined) {
    return {
      name: 'playwright chromium',
      status: 'warn',
      detail: 'Playwright is not installed in packages/browser-host yet (P4); nothing to check',
    };
  }
  const playwright = (await import(pathToFileURL(entry).href)) as {
    chromium: { executablePath(): string };
  };
  const executable = playwright.chromium.executablePath();
  return existsSync(executable)
    ? { name: 'playwright chromium', status: 'ok', detail: executable }
    : {
        name: 'playwright chromium',
        status: 'fail',
        detail: 'Chromium not downloaded; run pnpm exec playwright install chromium',
      };
}

/** An optional AI CLI: its version when present, a warning when absent. */
export function checkOptionalCli(command: string, runner: Runner = run): Check {
  const version = runner(command, ['--version']);
  return version === undefined || version === ''
    ? {
        name: command,
        status: 'warn',
        detail: `not found (optional; needed only for the ${command} provider)`,
      }
    : { name: command, status: 'ok', detail: version };
}

/** UNIX socket path limit in bytes: 104 on macOS, 108 on Linux (08 §6). */
export function socketPathLimit(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? 104 : 108;
}

/** Electron's default userData directory for the app name "Command Center" (04 §9). */
export function defaultUserData(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Command Center');
  if (platform === 'win32') return join(env['APPDATA'] ?? homedir(), 'Command Center');
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'Command Center');
}

/** Warns for every profile directory whose `run/cc.sock` would exceed the limit. */
export function checkSocketPaths(
  profiles: readonly { label: string; dir: string }[],
  platform: NodeJS.Platform,
): Check {
  if (platform === 'win32') {
    return { name: 'socket path', status: 'ok', detail: 'named pipe on Windows, no length limit' };
  }
  const limit = socketPathLimit(platform);
  const sizes = profiles.map(({ label, dir }) => ({
    label,
    bytes: Buffer.byteLength(posix.join(dir, 'run', 'cc.sock')),
  }));
  const long = sizes.filter((size) => size.bytes > limit);
  const list = (items: typeof sizes) =>
    items.map((item) => `${item.label} ${item.bytes} bytes`).join(', ');
  return long.length === 0
    ? { name: 'socket path', status: 'ok', detail: `${list(sizes)} (limit ${limit})` }
    : {
        name: 'socket path',
        status: 'warn',
        detail: `over the ${limit}-byte UNIX limit: ${list(long)}; use a shorter --profile-dir`,
      };
}

export function summarize(checks: readonly Check[]): { exitCode: 0 | 1; lines: string[] } {
  const label: Record<Status, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = checks.map((check) => `${label[check.status]} ${check.name}: ${check.detail}`);
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  lines.push(
    failed === 0
      ? `cc:doctor: all checks passed${warned > 0 ? ` (${warned} warning(s))` : ''}.`
      : `cc:doctor: ${failed} check(s) failed.`,
  );
  return { exitCode: failed === 0 ? 0 : 1, lines };
}

export function parseArgs(args: readonly string[]): { profileDir?: string } | undefined {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--profile-dir' && args[1] !== undefined) {
    return { profileDir: args[1] };
  }
  return undefined;
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error('usage: pnpm cc:doctor [--profile-dir <dir>]');
    return 2;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const profiles = [
    { label: 'default profile', dir: defaultUserData(process.platform, process.env) },
    // createProfileDir() in @cc/test-kit: /tmp/cc-test-<6 random characters>.
    { label: 'test profiles', dir: '/tmp/cc-test-XXXXXX' },
  ];
  if (options.profileDir !== undefined) {
    profiles.push({ label: '--profile-dir', dir: options.profileDir });
  }
  const checks = [
    checkNode(root),
    checkPnpm(root),
    checkElectron(root),
    await checkPlaywright(root),
    checkOptionalCli('claude'),
    checkOptionalCli('codex'),
    checkSocketPaths(profiles, process.platform),
  ];
  const { exitCode, lines } = summarize(checks);
  for (const line of lines) console.log(line);
  return exitCode;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
