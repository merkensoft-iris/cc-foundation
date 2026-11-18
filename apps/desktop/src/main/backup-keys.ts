/**
 * The backup keys main keeps (04 §9.1 rule 3, OQ-04-08, ADR 0007).
 *
 * Main holds them in one secret, `<userData>/secrets/backup-keys`, wrapped by `safeStorage`,
 * and hands them to the core at each start (04 §3: the core gets secrets from main). The list
 * is oldest first; the last key seals new archives, and the older ones still open the archives
 * they sealed.
 *
 * - First start: a random key, so the local set is written before the user sets a passphrase.
 * - The user sets a passphrase (onboarding S1 or Settings → Backups): main derives a key from
 *   it with scrypt and appends it. The passphrase itself is never stored, sent to the core or
 *   logged; only the derived key is kept, so scheduled backups need no prompt.
 * - A passphrase kept by the P1-12 build in `secrets/backup-passphrase` is turned into its key
 *   at the next start, and the passphrase file is deleted.
 */
import {
  deriveBackupKey,
  parseKeys,
  randomBackupKey,
  serializeKey,
  type BackupKey,
  type SerializedBackupKey,
} from '@cc/core/backup-keys';

export const KEYS_SECRET = 'backup-keys';
/** Where the P1-12 build kept the S1 passphrase until P1-17 derived a key from it. */
export const LEGACY_PASSPHRASE_SECRET = 'backup-passphrase';

/** `safeStorage`-wrapped files under `<userData>/secrets/` (04 §9 rule 1). */
export interface SecretStore {
  read(name: string): Promise<string | undefined>;
  write(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface BackupKeyringOptions {
  readonly secrets: SecretStore;
  readonly derive?: (passphrase: string) => Promise<BackupKey>;
  readonly random?: () => BackupKey;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class BackupKeyring {
  readonly #options: BackupKeyringOptions;
  #keys: BackupKey[] = [];

  constructor(options: BackupKeyringOptions) {
    this.#options = options;
  }

  /** The keys as the core receives them. */
  get serialized(): SerializedBackupKey[] {
    return this.#keys.map(serializeKey);
  }

  /** Reads the keys, turns a P1-12 passphrase into its key, and makes the first random key. */
  async load(): Promise<SerializedBackupKey[]> {
    const { secrets } = this.#options;
    const stored = await secrets.read(KEYS_SECRET);
    let keys: BackupKey[] = [];
    if (stored !== undefined) {
      try {
        keys = parseKeys(JSON.parse(stored));
      } catch {
        this.#options.log?.('backups.keys_unreadable');
      }
    }
    let changed = false;
    if (keys.length === 0) {
      keys = [(this.#options.random ?? randomBackupKey)()];
      changed = true;
    }
    const legacy = await secrets.read(LEGACY_PASSPHRASE_SECRET);
    if (legacy !== undefined) {
      keys.push(await this.#derive(legacy));
      changed = true;
    }
    this.#keys = keys;
    if (changed) await this.#save();
    if (legacy !== undefined) {
      await secrets.remove(LEGACY_PASSPHRASE_SECRET);
      this.#options.log?.('backups.passphrase_migrated');
    }
    return this.serialized;
  }

  /** Derives the key from a new passphrase and makes it the current one (rule 3). */
  async setPassphrase(passphrase: string): Promise<SerializedBackupKey[]> {
    const key = await this.#derive(passphrase);
    this.#keys = [...this.#keys.filter((existing) => existing.id !== key.id), key];
    await this.#save();
    this.#options.log?.('backups.passphrase_set', { keyId: key.id });
    return this.serialized;
  }

  #derive(passphrase: string): Promise<BackupKey> {
    return (this.#options.derive ?? deriveBackupKey)(passphrase);
  }

  async #save(): Promise<void> {
    await this.#options.secrets.write(KEYS_SECRET, JSON.stringify(this.serialized));
  }
}
