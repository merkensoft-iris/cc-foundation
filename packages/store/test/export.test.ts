/**
 * Export (03 §12 point 6): one JSONL file per table plus the blobs the records reference,
 * with a manifest of hashes, and never a secret (C-03-06).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { blobPath, exportWorkspace, tableSpecs } from '@cc/store';

import { openTestStore, seedReferenceWorkspace, type TestStore } from './support/reference.js';

function writeBlob(blobsDir: string, content: string): string {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const path = blobPath(blobsDir, sha256);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return sha256;
}

function allFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allFiles(root, join(prefix, entry.name))
      : [join(prefix, entry.name).replaceAll('\\', '/')],
  );
}

describe('exportWorkspace', () => {
  const open: TestStore[] = [];
  afterEach(() => {
    while (open.length > 0) open.pop()?.cleanup();
  });

  function seeded(): TestStore {
    const test = openTestStore();
    open.push(test);
    seedReferenceWorkspace(test.store);
    return test;
  }

  it('writes one JSONL file per table with a manifest of hashes', () => {
    const test = seeded();
    const outDir = join(test.dir, 'export');
    const result = exportWorkspace(test.store, { outDir, now: () => '2026-11-13T10:00:00Z' });

    expect(result.manifest.tables.map((table) => table.table)).toEqual(
      tableSpecs.map((spec) => spec.table),
    );
    expect(result.manifest.schemaVersion).toBe(test.store.schemaVersion);
    for (const table of result.manifest.tables) {
      const content = readFileSync(join(outDir, table.path), 'utf8');
      expect(createHash('sha256').update(content).digest('hex')).toBe(table.sha256);
      expect(content === '' ? 0 : content.trimEnd().split('\n').length).toBe(table.rows);
    }
    const items = readFileSync(join(outDir, 'tables/action_items.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string });
    expect(items.map((item) => item.id)).toEqual(
      test.store.read((tx) => tx.list('action_items')).map((item) => item.id),
    );
  });

  it('names the tables no schema validates yet, and the record type of the rest', () => {
    const test = seeded();
    const result = exportWorkspace(test.store, { outDir: join(test.dir, 'export') });
    const byTable = new Map(result.manifest.tables.map((table) => [table.table, table.recordType]));
    expect(byTable.get('action_items')).toBe('action_item@1');
    expect(byTable.get('events')).toBe('domain_event@1');
    expect(byTable.get('meeting_series')).toBe('meeting_series@1');
    expect(byTable.get('connector_installs')).toBeNull();
    expect(byTable.get('backup_runs')).toBeNull();
  });

  it('C-03-06 copies every blob a record references and lists the ones it cannot find', () => {
    const test = seeded();
    const present = writeBlob(test.store.blobsDir, 'the memo for the one-way door');
    const item = test.store.read((tx) => tx.require('decisions', 'dec_d0008'));
    test.store.command({ actor: { kind: 'user' } }, (tx) => {
      tx.update('decisions', { ...item, memoSha256: present }, item.version);
      tx.event({ type: 'decision.updated', entity: { kind: 'decision', id: item.id } });
    });

    const outDir = join(test.dir, 'export');
    const result = exportWorkspace(test.store, { outDir });
    expect(result.manifest.blobs.map((blob) => blob.sha256)).toContain(present);
    const copied = result.manifest.blobs.find((blob) => blob.sha256 === present);
    expect(readFileSync(join(outDir, copied?.path ?? ''), 'utf8')).toBe(
      'the memo for the one-way door',
    );
    // run_01's log digest is a fixture placeholder with no file behind it.
    expect(result.manifest.missingBlobs).toContain(
      '3f00000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('C-03-06 never writes a secret: the export holds tables, blobs and the manifest only', () => {
    const test = seeded();
    const secrets = join(test.dir, 'secrets');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, 'sec_gmail_ald'), 'ciphertext that must never be exported');
    writeFileSync(join(test.dir, 'run-token'), 'a token that must never be exported');

    const outDir = join(test.dir, 'export');
    exportWorkspace(test.store, { outDir });
    const files = allFiles(outDir);
    expect(files.every((file) => file === 'manifest.json' || /^(tables|blobs)\//.test(file))).toBe(
      true,
    );
    const everything = files.map((file) => readFileSync(join(outDir, file), 'utf8')).join('\n');
    expect(everything).not.toContain('ciphertext that must never be exported');
    expect(everything).not.toContain('a token that must never be exported');
  });
});
