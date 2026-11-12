/**
 * Principal tokens (04 §4.2 rule 2): random 256-bit values, one file per principal at
 * `<userData>/run/tokens/<principal>.token`, mode 0600 in a 0700 directory. Created when the
 * user adds the principal, deleted when the user revokes it.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_ACCESS_HELP, CoreError } from './errors.js';
import { assertPrivateDir, runDirOf } from './endpoint.js';

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** 256 bits as lower-case hex. */
const TOKEN = /^[0-9a-f]{64}$/;

export function tokensDirOf(userData: string): string {
  return path.join(runDirOf(userData), 'tokens');
}

export function tokenPathOf(userData: string, principal: string): string {
  if (!NAME.test(principal)) {
    throw new CoreError('E_USAGE', `invalid principal name "${principal}"`, [
      'Principal names are lower-case letters, digits and hyphens',
    ]);
  }
  return path.join(tokensDirOf(userData), `${principal}.token`);
}

/** A new random 256-bit token. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

function ensureTokensDir(userData: string): void {
  const dir = tokensDirOf(userData);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(runDirOf(userData), { fix: true });
  assertPrivateDir(dir, { fix: true });
}

/** Writes a new token file for `principal` (0600, temporary file then rename). */
export function writeToken(userData: string, principal: string, token = newToken()): string {
  const file = tokenPathOf(userData, principal);
  ensureTokensDir(userData);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return token;
}

/** Deletes a principal's token file; absent is fine. */
export function deleteToken(userData: string, principal: string): void {
  fs.rmSync(tokenPathOf(userData, principal), { force: true });
}

export function tokenExists(userData: string, principal: string): boolean {
  return fs.existsSync(tokenPathOf(userData, principal));
}

/**
 * Reads a token, verifying the file first: a regular file owned by this user with no group
 * or other permissions, in private directories. Returns `undefined` when there is none.
 */
export function readToken(userData: string, principal: string): string | undefined {
  const file = tokenPathOf(userData, principal);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (process.platform !== 'win32') {
    assertPrivateDir(runDirOf(userData));
    assertPrivateDir(tokensDirOf(userData));
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new CoreError(
        'E_ENDPOINT_UNSAFE',
        `${file} must be a regular file owned by you with mode 600`,
        [AGENT_ACCESS_HELP],
      );
    }
  } else if (!stat.isFile()) {
    throw new CoreError('E_ENDPOINT_UNSAFE', `${file} is not a regular file`, []);
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!TOKEN.test(token)) {
    throw new CoreError('E_ENDPOINT_UNSAFE', `${file} does not hold a 256-bit token`, [
      AGENT_ACCESS_HELP,
    ]);
  }
  return token;
}
