/**
 * The local API endpoint (04 §4.1 rule 1 as amended by ADR 0002): where the core listens,
 * how it records that place, and how a client finds and verifies it before sending anything
 * derived from a token.
 *
 * - Preferred: a UNIX socket at `<userData>/run/cc.sock` (socket 0600, directory 0700).
 * - Fallback (ADR 0002 decision 4): when that path is longer than `sizeof(sun_path) - 1`
 *   bytes, `mkdtemp('/tmp/command-center-<uid>-')` makes a private directory and the socket
 *   is `<dir>/cc.sock`, found only through the record.
 * - Windows: a named pipe `\\.\pipe\command-center-<username>-<random>` (decision 6).
 * - The record `<userData>/run/endpoint` is always written (decision 2): mode 0600, one JSON
 *   line, written to a temporary file and renamed.
 *
 * Server and client both check the byte length before any bind or connect, because Node 22
 * silently truncates a long path (decision 3).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { APP_NOT_RUNNING_HELP, CoreError } from './errors.js';

/** `sizeof(struct sockaddr_un.sun_path)` per platform; the usable length is one less. */
const SUN_PATH_SIZE: Readonly<Record<string, number>> = {
  linux: 108,
  darwin: 104,
  freebsd: 104,
  openbsd: 104,
  netbsd: 104,
};

/** The longest usable UNIX socket path in UTF-8 bytes: 107 on Linux, 103 on macOS. */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return (SUN_PATH_SIZE[platform] ?? 104) - 1;
}

export const SOCKET_NAME = 'cc.sock';
export const RECORD_NAME = 'endpoint';
export const FALLBACK_PREFIX = 'command-center-';

export function runDirOf(userData: string): string {
  return path.join(userData, 'run');
}

export function recordPathOf(userData: string): string {
  return path.join(runDirOf(userData), RECORD_NAME);
}

/** The endpoint record of ADR 0002 decision 2. */
export interface EndpointRecord {
  readonly v: 1;
  readonly transport: 'unix' | 'pipe';
  readonly path: string;
  readonly fallbackDir?: string;
  readonly pid: number;
  readonly startedAt: string;
}

/** Where the endpoint should live, before any file system effect. */
export type EndpointPlan =
  | { readonly transport: 'pipe'; readonly path: string }
  | { readonly transport: 'unix'; readonly fallback: false; readonly path: string }
  | {
      readonly transport: 'unix';
      readonly fallback: true;
      /** The preferred path that was too long. */
      readonly preferred: string;
      readonly preferredBytes: number;
      readonly maxBytes: number;
      readonly tmpRoot: string;
    };

/** A prepared endpoint: the concrete path to listen on. */
export interface PreparedEndpoint {
  readonly transport: 'unix' | 'pipe';
  readonly path: string;
  /** The private `mkdtemp` directory of a fallback socket. */
  readonly fallbackDir?: string;
  /** What preparation found and did, for the log. */
  readonly notes: readonly string[];
}

export interface PlanOptions {
  readonly userData: string;
  readonly platform?: NodeJS.Platform;
  readonly tmpRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Windows pipe name with an unguessable part (ADR 0002 decision 6). */
export function pipeName(env: NodeJS.ProcessEnv = process.env): string {
  const user = String(env['USERNAME'] ?? env['USER'] ?? 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `\\\\.\\pipe\\command-center-${user}-${randomBytes(16).toString('hex')}`;
}

/** Pure apart from the random pipe suffix: decides where the endpoint goes. */
export function planEndpoint(options: PlanOptions): EndpointPlan {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return { transport: 'pipe', path: pipeName(options.env) };
  // A UNIX socket path follows POSIX rules whatever the host (planning runs anywhere).
  const preferred = path.posix.join(options.userData, 'run', SOCKET_NAME);
  const preferredBytes = Buffer.byteLength(preferred);
  const maxBytes = maxSocketPathBytes(platform);
  if (preferredBytes <= maxBytes) return { transport: 'unix', fallback: false, path: preferred };
  return {
    transport: 'unix',
    fallback: true,
    preferred,
    preferredBytes,
    maxBytes,
    tmpRoot: options.tmpRoot ?? '/tmp',
  };
}

function currentUid(): number | undefined {
  return process.getuid?.();
}

function unsafe(message: string, help: readonly string[]): CoreError {
  return new CoreError('E_ENDPOINT_UNSAFE', message, help);
}

/**
 * Verifies a private directory: not a symlink, a directory, owned by this user, mode 0700
 * (ADR 0002 condition 2). With `fix`, a wider mode on our own directory is narrowed.
 */
export function assertPrivateDir(dir: string, options: { fix?: boolean } = {}): void {
  const uid = currentUid();
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw unsafe(`${dir} is a symlink`, ['Remove it, then restart Command Center']);
  }
  if (!stat.isDirectory()) {
    throw unsafe(`${dir} is not a directory`, ['Remove it, then restart Command Center']);
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw unsafe(`${dir} is owned by uid ${stat.uid}, not ${uid}`, [
      'Another user owns this path; remove it as that user or use a shorter profile path',
    ]);
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o700) {
    if (options.fix !== true) {
      throw unsafe(`${dir} has mode ${mode.toString(8)}, expected 700`, [
        `Run \`chmod 700 ${dir}\`, then retry`,
      ]);
    }
    fs.chmodSync(dir, 0o700);
  }
}

/** The byte-length check both sides run before a bind or connect (decision 3). */
export function assertSocketPathFits(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  const bytes = Buffer.byteLength(socketPath);
  const max = maxSocketPathBytes(platform);
  if (bytes > max) {
    throw unsafe(`socket path is ${bytes} bytes, over the ${max}-byte limit: ${socketPath}`, [
      'Use a shorter profile directory',
    ]);
  }
}

export type ProbeResult = 'live' | 'stale' | 'absent' | 'timeout' | `error:${string}`;

/** Connects to a socket path: `live` accepts, `stale` refuses (ECONNREFUSED), `absent`. */
export function probeSocket(socketPath: string, timeoutMs = 500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('live');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolve('stale');
      else if (error.code === 'ENOENT') resolve('absent');
      else resolve(`error:${error.code ?? 'unknown'}`);
    });
  });
}

/**
 * Probe before unlink (decision 4): a live socket means another instance
 * (`E_ALREADY_RUNNING`), a stale one is removed, and anything that is not our socket is
 * never deleted (`E_ENDPOINT_UNSAFE`).
 */
export async function clearStaleSocket(socketPath: string): Promise<string> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (!stat.isSocket()) {
    throw unsafe(`${socketPath} exists and is not a socket`, [
      'Remove it, then restart Command Center',
    ]);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw unsafe(`${socketPath} is owned by uid ${stat.uid}, not ${uid}`, [
      'Another user owns this socket; remove it as that user',
    ]);
  }
  const state = await probeSocket(socketPath);
  if (state === 'live') {
    throw new CoreError('E_ALREADY_RUNNING', `another Command Center is serving ${socketPath}`, [
      'Use the running app, or quit it first',
    ]);
  }
  if (state === 'stale') {
    fs.unlinkSync(socketPath);
    return 'unlinked stale socket';
  }
  return state;
}

/** Reads the record without verifying it (server side, for its own previous run). */
function readRecordLoose(userData: string): Partial<EndpointRecord> | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPathOf(userData), 'utf8')) as Partial<EndpointRecord>;
  } catch {
    return undefined;
  }
}

/** Makes `<userData>/run` (0700), creating `<userData>` (0700) if needed. */
export function ensureRunDir(userData: string): string {
  const runDir = runDirOf(userData);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  assertPrivateDir(runDir, { fix: true });
  return runDir;
}

/** Creates a fresh fallback directory (`mkdtemp`, 0700) and verifies it. */
export function makeFallbackDir(tmpRoot: string): string {
  const uid = currentUid() ?? 'user';
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${FALLBACK_PREFIX}${uid}-`));
  assertPrivateDir(dir);
  return dir;
}

/**
 * Server side: creates the run directory, clears a stale socket, removes a crashed run's
 * fallback directory (found through the old record), and makes a new fallback directory
 * when the preferred path is too long.
 */
export async function prepareEndpoint(
  plan: EndpointPlan,
  options: { userData: string },
): Promise<PreparedEndpoint> {
  const notes: string[] = [];
  ensureRunDir(options.userData);
  if (plan.transport === 'pipe') return { transport: 'pipe', path: plan.path, notes };
  if (!plan.fallback) {
    notes.push(`stale check: ${await clearStaleSocket(plan.path)}`);
    return { transport: 'unix', path: plan.path, notes };
  }

  const old = readRecordLoose(options.userData);
  if (typeof old?.fallbackDir === 'string' && typeof old.path === 'string') {
    try {
      assertPrivateDir(old.fallbackDir);
      const result = await clearStaleSocket(path.join(old.fallbackDir, SOCKET_NAME));
      fs.rmdirSync(old.fallbackDir);
      notes.push(`old fallback ${old.fallbackDir}: ${result}, removed`);
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_ALREADY_RUNNING') throw error;
      const reason = error instanceof CoreError ? error.code : (error as Error).message;
      notes.push(`old fallback ${old.fallbackDir}: left (${reason})`);
    }
  }
  const dir = makeFallbackDir(plan.tmpRoot);
  notes.push(`fallback: preferred path is ${plan.preferredBytes} bytes (max ${plan.maxBytes})`);
  return { transport: 'unix', path: path.join(dir, SOCKET_NAME), fallbackDir: dir, notes };
}

/**
 * Listens with umask 077, so the socket is never visible with wider permissions, then sets
 * mode 0600 (decision 4).
 */
export function listenPrivate(server: net.Server, socketPath: string): Promise<void> {
  assertSocketPathFits(socketPath);
  return new Promise((resolve, reject) => {
    const isPipe = socketPath.startsWith('\\\\');
    const oldMask = isPipe ? undefined : process.umask(0o077);
    const restore = () => {
      if (oldMask !== undefined) process.umask(oldMask);
    };
    const onError = (error: Error) => {
      restore();
      reject(error);
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      restore();
      server.off('error', onError);
      try {
        if (!isPipe) fs.chmodSync(socketPath, 0o600);
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

/** Writes `<userData>/run/endpoint` (0600) atomically: a temporary file, then a rename. */
export function writeRecord(
  userData: string,
  endpoint: PreparedEndpoint,
  startedAt: Date,
): EndpointRecord {
  const record: EndpointRecord = {
    v: 1,
    transport: endpoint.transport,
    path: endpoint.path,
    ...(endpoint.fallbackDir === undefined ? {} : { fallbackDir: endpoint.fallbackDir }),
    pid: process.pid,
    startedAt: startedAt.toISOString(),
  };
  const file = recordPathOf(userData);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return record;
}

/** Removes the record if this process wrote it. */
export function removeRecord(userData: string): void {
  const file = recordPathOf(userData);
  const record = readRecordLoose(userData);
  if (record?.pid === process.pid) fs.rmSync(file, { force: true });
}

/** Where a client should connect, and how it found out. */
export interface DiscoveredEndpoint {
  readonly path: string;
  readonly via: 'record' | 'computed';
  readonly record?: EndpointRecord;
}

function isRecord(value: unknown): value is EndpointRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['v'] === 1 &&
    (record['transport'] === 'unix' || record['transport'] === 'pipe') &&
    typeof record['path'] === 'string' &&
    typeof record['pid'] === 'number' &&
    typeof record['startedAt'] === 'string' &&
    (record['fallbackDir'] === undefined || typeof record['fallbackDir'] === 'string')
  );
}

/**
 * Client side: reads and verifies the record, then the directories and the socket, before
 * the caller sends anything derived from a token (ADR 0002 condition 2). Without a record it
 * computes the preferred path, unless that would need the fallback (or a Windows pipe),
 * which only the record can name.
 */
export function discoverEndpoint(options: {
  userData: string;
  platform?: NodeJS.Platform;
}): DiscoveredEndpoint {
  const platform = options.platform ?? process.platform;
  const runDir = runDirOf(options.userData);
  const file = recordPathOf(options.userData);
  const notRunning = (message: string) =>
    new CoreError('E_APP_NOT_RUNNING', message, [APP_NOT_RUNNING_HELP]);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const plan = planEndpoint({ userData: options.userData, platform });
    if (plan.transport === 'pipe' || plan.fallback) {
      throw notRunning(`no endpoint record at ${file}`);
    }
    return { path: plan.path, via: 'computed' };
  }

  const posix = platform !== 'win32';
  if (posix) assertPrivateDir(runDir);
  const uid = currentUid();
  if (
    !stat.isFile() ||
    (posix && uid !== undefined && stat.uid !== uid) ||
    (posix && (stat.mode & 0o077) !== 0)
  ) {
    throw unsafe(`${file} must be a regular file owned by you with mode 600`, [
      `Remove ${file}, then restart Command Center`,
    ]);
  }
  let record: unknown;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw unsafe(`${file} is not a valid endpoint record`, [
      `Remove ${file}, then restart Command Center`,
    ]);
  }
  if (!isRecord(record)) {
    throw unsafe(`${file} is not a v1 endpoint record`, [
      `Remove ${file}, then restart Command Center`,
    ]);
  }
  if (record.transport === 'pipe') {
    if (!/^\\\\\.\\pipe\\command-center-[A-Za-z0-9_.-]+$/.test(record.path)) {
      throw unsafe(`${file} names an unexpected pipe`, []);
    }
    return { path: record.path, via: 'record', record };
  }
  if (!path.isAbsolute(record.path)) {
    throw unsafe(`${file} names a relative socket path`, []);
  }
  assertSocketPathFits(record.path, platform);
  const dir = path.dirname(record.path);
  if (dir !== runDir) {
    if (record.fallbackDir !== dir) {
      throw unsafe(`${file} names a socket outside the run directory and its fallback`, []);
    }
    try {
      assertPrivateDir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notRunning(`the fallback directory ${dir} is gone`);
      }
      throw error;
    }
  }
  let socketStat: fs.Stats;
  try {
    socketStat = fs.lstatSync(record.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw notRunning(`no socket at ${record.path}`);
    }
    throw error;
  }
  if (!socketStat.isSocket() || (uid !== undefined && socketStat.uid !== uid)) {
    throw unsafe(`${record.path} is not a socket owned by you`, []);
  }
  return { path: record.path, via: 'record', record };
}
