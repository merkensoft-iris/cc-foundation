/**
 * Backup keys (04 §9.1 rule 3, ADR 0007): derived from the user's passphrase with scrypt, or
 * random until the user sets one. Main derives and keeps them, wrapped by `safeStorage`
 * (OQ-04-08), and hands them to the core; the passphrase itself never leaves main.
 *
 * Imported by main as `@cc/core/backup-keys`: this module needs only `node:crypto`, so main
 * does not load the store or its database driver.
 */
import { createHash, randomBytes, scrypt } from 'node:crypto';

/** The scrypt parameters of ADR 0007: 128 MiB of memory per derivation. */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;

export interface KdfParams {
  readonly alg: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  /** Base64, 16 bytes. */
  readonly salt: string;
}

/** A backup key as main hands it to the core (04 §3: secrets come from main). */
export interface BackupKey {
  /** `key_` and 16 hex digits of a hash of the key; written into each archive's header. */
  readonly id: string;
  readonly key: Buffer;
  /** `passphrase` once the user set one; `random` until then (04 §9.1 rule 3). */
  readonly origin: 'passphrase' | 'random';
  /** How a passphrase key was derived, so another machine can derive it again. */
  readonly kdf?: KdfParams;
}

/** A backup key as it crosses a process boundary or sits wrapped in the secret store. */
export interface SerializedBackupKey {
  readonly id: string;
  /** Base64. */
  readonly key: string;
  readonly origin: 'passphrase' | 'random';
  readonly kdf?: KdfParams;
}

export function keyIdOf(key: Buffer): string {
  const digest = createHash('sha256').update('cc-backup-key-id\0').update(key).digest('hex');
  return `key_${digest.slice(0, 16)}`;
}

/** A fresh random key: the local set's key until the user sets a passphrase. */
export function randomBackupKey(): BackupKey {
  const key = randomBytes(32);
  return { id: keyIdOf(key), key, origin: 'random' };
}

/**
 * Derives the key from a passphrase (ADR 0007). Pass `kdf` to derive again with an archive's
 * salt and parameters; leave it out for a new salt.
 */
export function deriveBackupKey(passphrase: string, kdf?: KdfParams): Promise<BackupKey> {
  const params: KdfParams = kdf ?? {
    alg: 'scrypt',
    ...SCRYPT_PARAMS,
    salt: randomBytes(16).toString('base64'),
  };
  if (params.alg !== 'scrypt') {
    return Promise.reject(new Error(`unknown key derivation ${String(params.alg)}`));
  }
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFC'),
      Buffer.from(params.salt, 'base64'),
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 },
      (error, key) => {
        if (error !== null) reject(error);
        else resolve({ id: keyIdOf(key), key, origin: 'passphrase', kdf: params });
      },
    );
  });
}

export function serializeKey(key: BackupKey): SerializedBackupKey {
  return {
    id: key.id,
    key: key.key.toString('base64'),
    origin: key.origin,
    ...(key.kdf === undefined ? {} : { kdf: key.kdf }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseKdf(value: unknown): KdfParams | undefined {
  if (!isRecord(value)) return undefined;
  const { alg, N, r, p, salt } = value;
  if (alg !== 'scrypt' || typeof salt !== 'string') return undefined;
  const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (!positive(N) || !positive(r) || !positive(p)) return undefined;
  return { alg, N, r, p, salt };
}

/** A serialized key, checked: the key is 32 bytes and its ID matches it. */
export function parseKey(value: unknown): BackupKey | undefined {
  if (!isRecord(value)) return undefined;
  const { id, key, origin } = value;
  if (typeof id !== 'string' || typeof key !== 'string') return undefined;
  if (origin !== 'passphrase' && origin !== 'random') return undefined;
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32 || keyIdOf(bytes) !== id) return undefined;
  const kdf = value['kdf'] === undefined ? undefined : parseKdf(value['kdf']);
  if (value['kdf'] !== undefined && kdf === undefined) return undefined;
  return { id, key: bytes, origin, ...(kdf === undefined ? {} : { kdf }) };
}

/** Parses a list of serialized keys, dropping any that do not check out. */
export function parseKeys(value: unknown): BackupKey[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseKey).filter((key): key is BackupKey => key !== undefined);
}
