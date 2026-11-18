/**
 * The backup archive format and its encryption (04 §9.1 rules 2 and 3, ADR 0007).
 *
 * Key: a 256-bit key (`keys.ts`). With a passphrase it is derived with scrypt (N = 2^17,
 * r = 8, p = 1, a 16-byte random salt); before the user sets one it is 32 random bytes
 * (04 §9.1 rule 3). The app keeps the key wrapped by `safeStorage`; the core only ever sees
 * the key, never the passphrase.
 *
 * File: `CCBACKUP`, a 4-byte big-endian header length, the header (JSON: format version,
 * archive ID, time, trigger, key ID, the scrypt parameters and salt when the key came from a
 * passphrase, and a 32-byte file salt), then the payload in chunks of 1 MiB sealed with
 * AES-256-GCM. Each archive has its own key, HKDF-SHA-256(key, file salt). Chunk `i` uses the
 * nonce `i` (11 bytes, big-endian) followed by 1 on the last chunk and 0 on every other (the
 * STREAM construction), and every chunk authenticates the SHA-256 of the magic and header, so
 * reordering, truncating, extending or editing the header fails authentication.
 *
 * Payload: entries of `u16 name length, name, u64 size, bytes`, ended by a zero name length.
 * The first entry is `manifest.json` (the hashes of the rest), then `workspace.db`, then
 * `blobs/<aa>/<sha256>`. Nothing in the header is secret; record titles and every other
 * record field are only in the sealed payload (AC-04-10).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CoreError } from '../errors.js';
import type { BackupKey, KdfParams } from './keys.js';

export type { BackupKey, KdfParams } from './keys.js';

export const ARCHIVE_MAGIC = Buffer.from('CCBACKUP', 'ascii');
export const FORMAT_VERSION = 1;
export const CHUNK_BYTES = 1 << 20;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const HKDF_INFO = 'cc-backup/v1 aes-256-gcm';
export const ARCHIVE_EXTENSION = '.ccb';

/** The plaintext header of an archive; nothing in it is secret. */
export interface ArchiveHeader {
  readonly format: 'cc-backup';
  readonly v: typeof FORMAT_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly trigger: string;
  readonly keyId: string;
  /** Present when the key came from a passphrase: how to derive it again. */
  readonly kdf?: KdfParams;
  readonly cipher: 'aes-256-gcm';
  readonly chunkBytes: number;
  /** Base64, 32 bytes. */
  readonly fileSalt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonce(index: number, last: boolean): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(index), 3);
  out[11] = last ? 1 : 0;
  return out;
}

function fileKey(key: Buffer, fileSalt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, fileSalt, HKDF_INFO, 32));
}

function damaged(detail: string): CoreError {
  return new CoreError('E_INVARIANT', `the backup archive is damaged: ${detail}`, [
    '04 §9.1 rule 7: restore from an earlier archive; the next backup writes a new one',
  ]);
}

/** Writes an archive: header, then sealed chunks (ADR 0007). */
class SealedWriter {
  readonly #file: FileHandle;
  readonly #key: Buffer;
  readonly #aad: Buffer;
  readonly #chunkBytes: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #index = 0;

  constructor(file: FileHandle, key: Buffer, aad: Buffer, chunkBytes: number) {
    this.#file = file;
    this.#key = key;
    this.#aad = aad;
    this.#chunkBytes = chunkBytes;
  }

  async write(data: Buffer): Promise<void> {
    this.#pending.push(data);
    this.#pendingBytes += data.length;
    // A chunk is sealed only once more data follows it, so the last one is known at finish.
    while (this.#pendingBytes > this.#chunkBytes) {
      const all = Buffer.concat(this.#pending);
      await this.#seal(all.subarray(0, this.#chunkBytes), false);
      const rest = all.subarray(this.#chunkBytes);
      this.#pending = [rest];
      this.#pendingBytes = rest.length;
    }
  }

  async finish(): Promise<void> {
    await this.#seal(Buffer.concat(this.#pending), true);
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  async #seal(chunk: Buffer, last: boolean): Promise<void> {
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce(this.#index, last));
    cipher.setAAD(this.#aad);
    const sealed = Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
    this.#index += 1;
    await this.#file.write(sealed);
  }
}

function headerBytes(header: ArchiveHeader): { prefix: Buffer; aad: Buffer } {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const prefix = Buffer.concat([ARCHIVE_MAGIC, length, json]);
  return { prefix, aad: createHash('sha256').update(prefix).digest() };
}

/** One file to pack: its name inside the archive and where it is on disk. */
export interface PackEntry {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

function entryHead(name: string, bytes: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(2 + nameBytes.length + 8);
  head.writeUInt16BE(nameBytes.length, 0);
  nameBytes.copy(head, 2);
  head.writeBigUInt64BE(BigInt(bytes), 2 + nameBytes.length);
  return head;
}

/**
 * Writes the archive to `target`: the manifest first, then each entry's file (04 §9.1
 * rule 2). The caller writes to a temporary name and renames it once this resolves.
 */
export async function writeArchive(
  target: string,
  options: {
    readonly key: BackupKey;
    readonly id: string;
    readonly createdAt: string;
    readonly trigger: string;
    readonly manifest: Buffer;
    readonly entries: readonly PackEntry[];
    readonly chunkBytes?: number;
  },
): Promise<void> {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const salt = randomBytes(32);
  const header: ArchiveHeader = {
    format: 'cc-backup',
    v: FORMAT_VERSION,
    id: options.id,
    createdAt: options.createdAt,
    trigger: options.trigger,
    keyId: options.key.id,
    ...(options.key.kdf === undefined ? {} : { kdf: options.key.kdf }),
    cipher: 'aes-256-gcm',
    chunkBytes,
    fileSalt: salt.toString('base64'),
  };
  const { prefix, aad } = headerBytes(header);
  await mkdir(dirname(target), { recursive: true });
  const file = await open(target, 'wx', 0o600);
  try {
    await file.write(prefix);
    const writer = new SealedWriter(file, fileKey(options.key.key, salt), aad, chunkBytes);
    await writer.write(entryHead('manifest.json', options.manifest.length));
    await writer.write(options.manifest);
    for (const entry of options.entries) {
      await writer.write(entryHead(entry.name, entry.bytes));
      let written = 0;
      for await (const piece of createReadStream(entry.path)) {
        const buffer = piece as Buffer;
        written += buffer.length;
        await writer.write(buffer);
      }
      if (written !== entry.bytes) {
        throw new CoreError('E_INVARIANT', `${entry.name} changed size while it was packed`);
      }
    }
    await writer.write(Buffer.from([0, 0]));
    await writer.finish();
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Reads an archive's header without decrypting anything. */
export async function readArchiveHeader(path: string): Promise<ArchiveHeader> {
  const file = await open(path, 'r');
  try {
    return (await readHeader(file)).header;
  } finally {
    await file.close();
  }
}

async function readExactly(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw damaged('it ends early');
    read += bytesRead;
  }
  return buffer;
}

async function readHeader(
  file: FileHandle,
): Promise<{ header: ArchiveHeader; aad: Buffer; offset: number }> {
  const start = await readExactly(file, 0, ARCHIVE_MAGIC.length + 4);
  if (!timingSafeEqual(start.subarray(0, ARCHIVE_MAGIC.length), ARCHIVE_MAGIC)) {
    throw damaged('it is not a Command Center backup');
  }
  const length = start.readUInt32BE(ARCHIVE_MAGIC.length);
  if (length === 0 || length > MAX_HEADER_BYTES) throw damaged('its header has a bad length');
  const json = await readExactly(file, start.length, length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw damaged('its header is not JSON');
  }
  if (
    !isRecord(parsed) ||
    parsed['format'] !== 'cc-backup' ||
    parsed['v'] !== FORMAT_VERSION ||
    parsed['cipher'] !== 'aes-256-gcm' ||
    typeof parsed['id'] !== 'string' ||
    typeof parsed['createdAt'] !== 'string' ||
    typeof parsed['trigger'] !== 'string' ||
    typeof parsed['keyId'] !== 'string' ||
    typeof parsed['fileSalt'] !== 'string' ||
    typeof parsed['chunkBytes'] !== 'number' ||
    !Number.isSafeInteger(parsed['chunkBytes']) ||
    parsed['chunkBytes'] < 1 ||
    parsed['chunkBytes'] > 64 * CHUNK_BYTES
  ) {
    throw damaged('its header is not a version 1 header');
  }
  const prefix = Buffer.concat([start, json]);
  return {
    header: parsed as unknown as ArchiveHeader,
    aad: createHash('sha256').update(prefix).digest(),
    offset: prefix.length,
  };
}

/** The decrypted payload of an archive, chunk by chunk, authenticated before it is yielded. */
async function* openChunks(
  file: FileHandle,
  key: BackupKey,
  header: ArchiveHeader,
  aad: Buffer,
  offset: number,
): AsyncGenerator<Buffer> {
  const size = (await file.stat()).size;
  const derived = fileKey(key.key, Buffer.from(header.fileSalt, 'base64'));
  const sealedBytes = header.chunkBytes + TAG_BYTES;
  let position = offset;
  let index = 0;
  for (;;) {
    const remaining = size - position;
    if (remaining < TAG_BYTES) throw damaged('it ends early');
    const length = Math.min(sealedBytes, remaining);
    const last = position + length === size;
    const sealed = await readExactly(file, position, length);
    const decipher = createDecipheriv('aes-256-gcm', derived, nonce(index, last));
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(length - TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(sealed.subarray(0, length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw damaged(`chunk ${String(index)} fails authentication`);
    }
    yield plain;
    position += length;
    index += 1;
    if (last) return;
  }
}

/** Reads exact byte counts from the chunk stream. */
class PayloadReader {
  readonly #chunks: AsyncGenerator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(chunks: AsyncGenerator<Buffer>) {
    this.#chunks = chunks;
  }

  async take(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) {
      const next = await this.#chunks.next();
      if (next.done === true) throw damaged('its payload ends early');
      this.#buffer =
        this.#buffer.length === 0 ? next.value : Buffer.concat([this.#buffer, next.value]);
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  /** Streams `length` bytes to `sink`, a piece at a time. */
  async pipe(length: number, sink: (piece: Buffer) => Promise<void>): Promise<void> {
    let left = length;
    while (left > 0) {
      if (this.#buffer.length === 0) {
        const next = await this.#chunks.next();
        if (next.done === true) throw damaged('its payload ends early');
        this.#buffer = next.value;
      }
      const piece = this.#buffer.subarray(0, Math.min(left, this.#buffer.length));
      this.#buffer = this.#buffer.subarray(piece.length);
      left -= piece.length;
      await sink(piece);
    }
  }

  async end(): Promise<void> {
    if (this.#buffer.length > 0) throw damaged('it has bytes after its last entry');
    const next = await this.#chunks.next();
    if (next.done !== true) throw damaged('it has bytes after its last entry');
  }
}

/** The names an archive may hold; anything else is refused before it touches the disk. */
const ENTRY_NAME = /^(?:manifest\.json|workspace\.db|blobs\/[0-9a-f]{2}\/[0-9a-f]{64})$/;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface ExtractedEntry {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExtractResult {
  readonly header: ArchiveHeader;
  /** The manifest's bytes, as written. */
  readonly manifest: Buffer;
  readonly entries: readonly ExtractedEntry[];
}

/**
 * Decrypts an archive into `outDir` (04 §9.1 rule 7): every chunk is authenticated before
 * its bytes are written, and every entry is hashed as it is written. The caller checks the
 * hashes against the manifest.
 */
export async function extractArchive(
  path: string,
  keys: readonly BackupKey[],
  outDir: string,
): Promise<ExtractResult> {
  const file = await open(path, 'r');
  try {
    const { header, aad, offset } = await readHeader(file);
    const key = keys.find((candidate) => candidate.id === header.keyId);
    if (key === undefined) {
      throw new CoreError(
        'E_PERMISSION',
        `the archive was sealed with key ${header.keyId}, which this app does not hold`,
        [
          header.kdf === undefined
            ? 'It was written before a passphrase was set, on another machine or install'
            : 'It was written under another passphrase: set that passphrase again to restore it',
        ],
      );
    }
    const reader = new PayloadReader(openChunks(file, key, header, aad, offset));
    const entries: ExtractedEntry[] = [];
    let manifest: Buffer | undefined;
    for (;;) {
      const nameLength = (await reader.take(2)).readUInt16BE(0);
      if (nameLength === 0) break;
      const name = (await reader.take(nameLength)).toString('utf8');
      const bytes = Number((await reader.take(8)).readBigUInt64BE(0));
      if (!ENTRY_NAME.test(name))
        throw damaged(`it holds an unexpected entry ${JSON.stringify(name)}`);
      if (entries.some((entry) => entry.name === name)) throw damaged(`${name} appears twice`);
      if ((manifest === undefined) !== (name === 'manifest.json')) {
        throw damaged('the manifest is not its first entry');
      }
      if (name === 'manifest.json') {
        if (bytes > MAX_MANIFEST_BYTES) throw damaged('its manifest is too large');
        manifest = Buffer.from(await reader.take(bytes));
        entries.push({ name, bytes, sha256: createHash('sha256').update(manifest).digest('hex') });
        continue;
      }
      const target = join(outDir, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        await reader.pipe(bytes, async (piece) => {
          hash.update(piece);
          await out.write(piece);
        });
      } finally {
        await out.close();
      }
      entries.push({ name, bytes, sha256: hash.digest('hex') });
    }
    await reader.end();
    if (manifest === undefined) throw damaged('it has no manifest');
    return { header, manifest, entries };
  } finally {
    await file.close();
  }
}
