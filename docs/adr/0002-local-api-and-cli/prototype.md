# 0002 prototype code

Supporting material for [ADR 0002](../0002-local-api-and-cli.md): the two prototype files the
decision builds on, as run in the P0-08 spike (2026-11-09). This is throwaway spike code, not
production code; P1-04, P1-05 and P1-16 reimplement it with tests. Paths below are relative to
the prototype root, which is not in this repository.

Two differences from the decision, both known when it was taken: the prototype computes the
Windows pipe name from a profile key, whereas decision 6 requires an unguessable part recorded
in the endpoint record; and `auth.hello` in the prototype is the design's one-way token check,
not the mutual-proof handshake of decision 6.

## 1. `lib/endpoint.mjs`: plan, prepare, record and discover

```js
// Spike S5 (P0-08) - endpoint planning, preparation, recording and discovery.
// Throwaway prototype; not production code.
//
// Design under test (04 §4.1, OQ-08-05 default):
//   preferred   <userData>/run/cc.sock        (socket 0600, dir 0700)
//   fallback    a per-user 0700 dir under /tmp when the preferred path is too long
//   record      <userData>/run/endpoint       (the path clients must use)
//   windows     \\.\pipe\command-center-<username>  (reasoned only; not run here)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// sizeof(struct sockaddr_un.sun_path). Usable bytes are one less (the NUL terminator).
export const SUN_PATH_SIZE = { linux: 108, darwin: 104, freebsd: 104, openbsd: 104, netbsd: 104 };
export function maxSocketPathBytes(platform = process.platform) {
  return (SUN_PATH_SIZE[platform] ?? 104) - 1;
}

export class EndpointError extends Error {
  constructor(code, message, help = []) {
    super(message);
    this.code = code;
    this.help = help;
  }
}

export function profileKey(userData) {
  return crypto.createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 12);
}

// Windows (reasoned): the design's fixed name plus a profile key so that two
// profiles (worktrees, tests) of one user never collide (C-08-05).
export function pipeName(userData, env = process.env) {
  const user = String(env.USERNAME || env.USER || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `\\\\.\\pipe\\command-center-${user}-${profileKey(userData)}`;
}

export function runDirOf(userData) {
  return path.join(userData, 'run');
}

// Pure: decide where the endpoint should live. No file system effects.
export function planEndpoint({
  userData,
  platform = process.platform,
  uid = process.getuid?.(),
  tmpRoot = '/tmp',
  strategy = 'mkdtemp',
}) {
  if (platform === 'win32') return { transport: 'pipe', path: pipeName(userData), fallback: false };
  const preferred = path.join(runDirOf(userData), 'cc.sock');
  const preferredBytes = Buffer.byteLength(preferred);
  const max = maxSocketPathBytes(platform);
  if (preferredBytes <= max)
    return { transport: 'unix', path: preferred, fallback: false, preferredBytes, max };
  // Fallback. 'fixed' = /tmp/command-center-<uid>/<profileKey>.sock (predictable name; squattable by other users).
  //           'mkdtemp' = /tmp/command-center-<uid>-XXXXXX/cc.sock (random, created 0700 atomically; found only via the record).
  return {
    transport: 'unix',
    fallback: true,
    strategy,
    preferred,
    preferredBytes,
    max,
    tmpRoot,
    uid,
  };
}

function assertPrivateDir(dir, uid, { fix = false } = {}) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink())
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${dir} is a symlink`, [
      'Remove it, then restart Command Center',
    ]);
  if (!st.isDirectory())
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${dir} is not a directory`, [
      'Remove it, then restart Command Center',
    ]);
  if (st.uid !== uid)
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${dir} is owned by uid ${st.uid}, not ${uid}`, [
      'Another user owns this path; remove it as that user or choose a shorter profile path',
    ]);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    if (!fix)
      throw new EndpointError(
        'E_ENDPOINT_UNSAFE',
        `${dir} has mode ${mode.toString(8)}, expected 700`,
        ['Run `chmod 700` on it, then retry'],
      );
    fs.chmodSync(dir, 0o700);
    return { fixedMode: mode.toString(8) };
  }
  return {};
}

// Probe an existing socket path: 'live' (something accepts), 'stale' (ECONNREFUSED), 'absent'.
export function probeSocket(p, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect(p);
    const t = setTimeout(() => {
      s.destroy();
      resolve('timeout');
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve('live');
    });
    s.once('error', (e) => {
      clearTimeout(t);
      if (e.code === 'ECONNREFUSED') resolve('stale');
      else if (e.code === 'ENOENT') resolve('absent');
      else resolve(`error:${e.code}`);
    });
  });
}

// Make the socket path usable: never unlink a live socket, never unlink a non-socket.
export async function clearStale(p, uid) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw e;
  }
  if (!st.isSocket())
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${p} exists and is not a socket`, [
      'Remove it, then restart Command Center',
    ]);
  if (st.uid !== uid)
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${p} is owned by uid ${st.uid}`, []);
  const state = await probeSocket(p);
  if (state === 'live')
    throw new EndpointError('E_ALREADY_RUNNING', `another Command Center is serving ${p}`, [
      'Use the running app, or quit it first',
    ]);
  if (state === 'stale') {
    fs.unlinkSync(p);
    return 'unlinked-stale';
  }
  return state;
}

function readRecord(userData) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDirOf(userData), 'endpoint'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Server side: create directories, resolve the fallback, clear stale state. Returns the concrete endpoint.
export async function prepareEndpoint(plan, { userData, uid = process.getuid?.() }) {
  const notes = [];
  const runDir = runDirOf(userData);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const fixed = assertPrivateDir(runDir, uid, { fix: true });
  if (fixed.fixedMode) notes.push(`run dir mode ${fixed.fixedMode} -> 700`);
  if (plan.transport === 'pipe') return { ...plan, notes };
  if (!plan.fallback) {
    notes.push(`stale check: ${await clearStale(plan.path, uid)}`);
    return { ...plan, notes };
  }
  // Remove a fallback dir left by a previous crashed run of this profile (found through the old record).
  const old = readRecord(userData);
  if (old?.fallbackDir) {
    try {
      assertPrivateDir(old.fallbackDir, uid);
      const sock = path.join(old.fallbackDir, path.basename(old.path));
      const r = await clearStale(sock, uid);
      if (plan.strategy !== 'fixed') {
        fs.rmdirSync(old.fallbackDir);
        notes.push(`old fallback ${old.fallbackDir}: ${r}, removed`);
      } else notes.push(`old fallback ${old.fallbackDir}: ${r}`);
    } catch (e) {
      if (e.code === 'E_ALREADY_RUNNING') throw e; // a live instance owns this profile
      notes.push(`old fallback ${old.fallbackDir}: left (${e.code || e.message})`);
    }
  }
  let dir;
  if (plan.strategy === 'fixed') {
    dir = path.join(plan.tmpRoot, `command-center-${uid}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      notes.push(`created ${dir}`);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const f = assertPrivateDir(dir, uid, { fix: true });
    if (f.fixedMode) notes.push(`fallback dir mode ${f.fixedMode} -> 700`);
    const p = path.join(dir, `${profileKey(userData)}.sock`);
    notes.push(`stale check: ${await clearStale(p, uid)}`);
    return { ...plan, path: p, dir, notes };
  }
  dir = fs.mkdtempSync(path.join(plan.tmpRoot, `command-center-${uid}-`));
  assertPrivateDir(dir, uid); // mkdtemp creates 0700; verify anyway
  notes.push(`created ${dir}`);
  return { ...plan, path: path.join(dir, 'cc.sock'), dir, notes };
}

// Listen with a 077 umask so the socket is never visible with wider permissions, then chmod 0600.
export function listenPrivate(server, p) {
  return new Promise((resolve, reject) => {
    const old = process.umask(0o077);
    server.once('error', (e) => {
      process.umask(old);
      reject(e);
    });
    server.listen(p, () => {
      process.umask(old);
      if (!p.startsWith('\\\\')) fs.chmodSync(p, 0o600);
      resolve();
    });
  });
}

// Atomic write of <userData>/run/endpoint (0600).
export function writeRecord(userData, ep) {
  const rec = {
    v: 1,
    transport: ep.transport,
    path: ep.path,
    fallbackDir: ep.fallback ? ep.dir : undefined,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const f = path.join(runDirOf(userData), 'endpoint');
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  return rec;
}

export function removeRecord(userData) {
  const f = path.join(runDirOf(userData), 'endpoint');
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec.pid === process.pid) fs.unlinkSync(f);
  } catch {
    /* gone */
  }
}

// Client side: find the endpoint and verify it before sending a token to it.
export function discoverEndpoint({
  userData,
  platform = process.platform,
  uid = process.getuid?.(),
}) {
  if (platform === 'win32') return { path: pipeName(userData), via: 'computed' };
  const runDir = runDirOf(userData);
  const recFile = path.join(runDir, 'endpoint');
  let st;
  try {
    st = fs.lstatSync(recFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const plan = planEndpoint({ userData, platform, uid });
    if (plan.fallback)
      throw new EndpointError('E_APP_NOT_RUNNING', `no endpoint record at ${recFile}`, [
        'Open Command Center, then retry',
      ]);
    return { path: plan.path, via: 'computed' };
  }
  assertPrivateDir(runDir, uid);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new EndpointError(
      'E_ENDPOINT_UNSAFE',
      `${recFile} must be a regular file owned by you with mode 600`,
      [],
    );
  }
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  if (rec.v !== 1 || typeof rec.path !== 'string' || !path.isAbsolute(rec.path)) {
    throw new EndpointError('E_ENDPOINT_UNSAFE', `${recFile} is not a v1 endpoint record`, []);
  }
  if (Buffer.byteLength(rec.path) > maxSocketPathBytes(platform)) {
    throw new EndpointError(
      'E_ENDPOINT_UNSAFE',
      `recorded path is ${Buffer.byteLength(rec.path)} bytes, over the limit`,
      [],
    );
  }
  const dir = path.dirname(rec.path);
  if (dir !== runDir) assertPrivateDir(dir, uid); // a fallback dir must be ours and 0700 before we send a token there
  try {
    const s = fs.lstatSync(rec.path);
    if (!s.isSocket() || s.uid !== uid)
      throw new EndpointError('E_ENDPOINT_UNSAFE', `${rec.path} is not a socket owned by you`, []);
  } catch (e) {
    if (e.code === 'ENOENT')
      throw new EndpointError('E_APP_NOT_RUNNING', `no socket at ${rec.path}`, [
        'Open Command Center, then retry',
      ]);
    throw e;
  }
  return { path: rec.path, via: 'record', record: rec };
}

export function defaultUserData(
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
) {
  if (platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Command Center');
  if (platform === 'win32')
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Command Center');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Command Center');
}
```

## 2. The `cc-axi` bin entry (fast path) and the exit-code mapping

`bin/cc-axi.mjs`:

```js
#!/usr/bin/env node
// Fast path first: answer -v/-V/--version before the command graph loads (axi-sdk-js/fast-path).
import { tryFastPath } from 'axi-sdk-js/fast-path';
import { VERSION } from '../src/version.mjs';

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  await import('../src/cli.mjs');
}
```

`src/cli.mjs` lines 33-40 (the `formatError` passed to `runAxiCli`):

```js
// 07 §4.4: E_USAGE and E_UNKNOWN_FLAG exit 2; the SDK's default maps only VALIDATION_ERROR to 2.
const EXIT_2 = new Set(['E_USAGE', 'E_UNKNOWN_FLAG', 'VALIDATION_ERROR']);
function formatError(error) {
  const code = error instanceof AxiError ? error.code : 'E_INTERNAL';
  const out = { error: error instanceof Error ? error.message : String(error), code };
  if (error instanceof AxiError && error.suggestions.length) out.help = error.suggestions;
  return { output: `${encode(out)}\n`, exitCode: EXIT_2.has(code) ? 2 : 1 };
}
```

Other prototype files (not reproduced here): `lib/rpc.mjs` (JSON-RPC lines and `auth.hello` with timing-safe token compare), `core/core.mjs` (`utilityProcess` entry, watchdog, graceful stop), `app/main.mjs` (Electron main), `tests/fallback.mjs` (the 39 checks), and `bench/*.mjs`.
