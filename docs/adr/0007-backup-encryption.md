# 0007. Backup encryption: scrypt and chunked AES-256-GCM

- **Status:** accepted
- **Date:** 2026-11-18
- **Task:** P1-17
- **Closes:** none (OQ-04-06 was settled by the board on 6 Nov 2026; this record fixes the
  algorithms 04 §9.1 rule 3 left to P1-17)
- **Spec:** 04 §9.1 rules 2, 3 and 7, C-04-09, AC-04-10, AC-04-11

## Question

04 §9.1 rule 3: every backup archive, local and off-machine, is encrypted with an
authenticated cipher under a key derived from a user passphrase with a memory-hard KDF. Which
KDF and cipher, with which parameters, and how is an archive laid out so that the restore test
can tell a damaged archive from a good one?

## Method

Constraints taken from the design:

1. The core runs in an Electron `utilityProcess` and, for development and tests, headless
   under the pinned Node (04 §3 rule 2). Both must read and write archives.
2. Main derives the key and keeps it wrapped by `safeStorage`; the passphrase never reaches
   the core (04 §9.1 rule 3, OQ-04-08). Derivation runs once per passphrase change, not per
   backup.
3. Another machine must be able to derive the same key from the passphrase alone, so the KDF
   parameters and salt travel in each archive, in the clear.
4. Archives can be large (the store plus its blobs); they are sealed and opened as streams.
5. A corrupted or truncated off-machine archive must fail the restore test (AC-04-11), and
   nothing a sync client or a disk could do to a file may pass as a good archive.

Options compared: Argon2id through Node's `crypto.argon2` or a package (`argon2`, a native
addon; `hash-wasm`), scrypt from `node:crypto`; AES-256-GCM and ChaCha20-Poly1305 from
`node:crypto`, as one sealed blob or in chunks.

The derivation cost was measured on the development host (Linux x64, Node 22.23.3, 14 cores
under load) with `deriveBackupKey` from `packages/core/src/backups/keys.ts`: 287, 308 and
286 ms for scrypt N = 2^17, r = 8, p = 1.

## Result

- `node:crypto` has scrypt in every Node release and Electron build CC targets. Node's own
  `crypto.argon2` is new (Node 24.7) and experimental, and is not available on every Node the
  core runs on today (it is absent on the host's Node 22). Argon2id from a package means a
  native addon to rebuild for Electron or a WebAssembly build, for a derivation that runs once
  per passphrase change.
- scrypt with N = 2^17, r = 8, p = 1 needs 128 MiB per derivation and about 0.3 s on the
  development host: the OWASP password storage cheat sheet's minimum for scrypt. Main runs it
  off its event loop (`crypto.scrypt` is asynchronous).
- AES-256-GCM is in `node:crypto` everywhere, hardware-accelerated on both target CPUs, and
  authenticated. One GCM call over a whole archive would release unauthenticated plaintext
  before the tag is checked and has one tag for gigabytes; chunking with a STREAM nonce
  (Hoang, Reyhanitabar, Rogaway and Vizár, 2015) authenticates each 1 MiB chunk before its
  bytes are used and detects reordering, truncation and extension.
- The tests in `packages/core/test/backups.test.ts` show a corrupted byte, a dropped final
  chunk, an appended chunk and an edited header each fail with `the backup archive is
damaged`, and a wrong key fails with `E_PERMISSION` before any payload is read.

## Decision

1. **KDF: scrypt** from `node:crypto`, N = 2^17, r = 8, p = 1, a 16-byte random salt per
   passphrase, a 32-byte key. The passphrase is NFC-normalised first. The parameters and the
   salt are written into every archive header (`kdf`), so another machine can derive the key
   again from the passphrase. A random 32-byte key stands in until the user sets a passphrase
   (04 §9.1 rule 3); its archives have no `kdf` and open only where that key is kept.
2. **Key ID:** `key_` and the first 16 hex digits of SHA-256(`cc-backup-key-id\0` ‖ key). It
   names the key in each header, so the core picks the right key from the keyring; it says
   nothing about the passphrase.
3. **Cipher: AES-256-GCM** under a per-archive key, HKDF-SHA-256(key, a 32-byte random file
   salt, info `cc-backup/v1 aes-256-gcm`), so a nonce never repeats under a key.
4. **Chunks:** the payload is sealed in 1 MiB chunks. Chunk `i` has the 12-byte nonce `i` as
   an 11-byte big-endian counter followed by 1 on the last chunk and 0 on every other, and
   each chunk's additional data is SHA-256 of the magic and the header. Each chunk is
   ciphertext followed by its 16-byte tag.
5. **File:** `CCBACKUP`, a 4-byte big-endian header length, the header as JSON
   (`format`, `v` = 1, `id`, `createdAt`, `trigger`, `keyId`, `kdf`, `cipher`, `chunkBytes`,
   `fileSalt`), then the chunks. The header holds no record data.
6. **Payload:** entries of a 2-byte name length, the name, an 8-byte size and the bytes,
   ended by a zero name length. `manifest.json` (the SHA-256 and size of every other entry,
   the row counts, the last event ID) comes first, then `workspace.db`, then
   `blobs/<aa>/<sha256>`. A reader refuses any other name before it writes anything.

Not chosen: Argon2id (no stable built-in on every runtime CC uses; a package is a native or
WebAssembly dependency for a once-per-passphrase step); ChaCha20-Poly1305 (equally sound,
slower than AES-GCM on the hardware CC targets); one GCM call over the whole archive (no
streaming authentication, no truncation detection); `tar` plus a separate encryption step
(a dependency, and a plaintext tar would exist on disk in between).

## Consequences

- 04 §9.1 rule 3 points here for the algorithms; the sentence about P1-12 keeping the
  passphrase until P1-17 is replaced by how main keeps the derived key (this PR).
- Main keeps the keyring (`<userData>/secrets/backup-keys`, `safeStorage`), migrates a
  P1-12 `backup-passphrase` secret to its key at the next start and deletes it.
- Changing a parameter or an algorithm later is a new format version (`v` = 2) and a new
  ADR; readers keep opening version 1.
- Restoring on a new machine needs the passphrase and the archive's header: the derivation
  helper (`deriveBackupKey(passphrase, header.kdf)`) is in place; the app flow that asks for
  the passphrase of an archive from elsewhere is not part of P1-17.
- Risk accepted: scrypt is memory-hard but not as tunable as Argon2id. Revisit when every
  runtime CC supports a stable built-in Argon2id.

## Evidence

- `packages/core/src/backups/keys.ts` (derivation, key IDs) and
  `packages/core/src/backups/format.ts` (the archive format).
- `packages/core/test/backups.test.ts`: `ADR 0007 archive format`, AC-04-10 and AC-04-11.
- OWASP Password Storage Cheat Sheet, scrypt parameters; Node.js `crypto.scrypt`,
  `crypto.hkdfSync` and `crypto.createCipheriv` documentation; Hoang, Reyhanitabar, Rogaway
  and Vizár, "Online Authenticated-Encryption and its Nonce-Reuse Misuse-Resistance",
  CRYPTO 2015 (the STREAM construction).
