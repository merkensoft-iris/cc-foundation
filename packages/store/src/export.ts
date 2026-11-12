/**
 * Export (03 §12 point 6): one JSONL file per table plus the blobs the records reference,
 * with a manifest of hashes. Export never includes secrets - it reads the store's tables
 * and the content-addressed blob directory only, never `<userData>/secrets/`, which holds
 * the `safeStorage` ciphertext (04 §9 rule 1), and never the token or log directories.
 *
 * 03 §12 point 6 spells the user-facing surface as `cc-axi export --out <dir>`. `cc-axi`
 * lands in P1-05 and the `export.run` method in P1-04 (09 §6.1), so this package provides
 * the function both will call rather than a CLI of its own.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { sha256Hex } from './migrations.js';
import { blobPath } from './location.js';
import { readPath } from './rows.js';
import type { Store } from './store.js';
import { tableSpecs, type TableName } from './tables.js';

export const MANIFEST_NAME = 'manifest.json';
export const TABLES_DIRNAME = 'tables';
export const BLOBS_DIRNAME = 'blobs';

export interface ExportOptions {
  /** The directory `cc-axi export --out <dir>` names; created if it does not exist. */
  readonly outDir: string;
  /** Where the blobs are read from; `<userData>/blobs` by default. */
  readonly blobsDir?: string;
  /** The time written into the manifest; the store's clock by default. */
  readonly now?: () => string;
}

export interface ExportedFile {
  /** Path inside the export directory, with forward slashes. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExportedTable extends ExportedFile {
  readonly table: TableName;
  readonly rows: number;
  /** The record type that validated the rows, or null while @cc/schemas has none. */
  readonly recordType: string | null;
}

export interface ExportManifest {
  readonly tool: '@cc/store';
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly tables: readonly ExportedTable[];
  readonly blobs: readonly ExportedFile[];
  /** Digests a record references that the blob directory does not hold. */
  readonly missingBlobs: readonly string[];
}

export interface ExportResult {
  readonly outDir: string;
  readonly manifestPath: string;
  readonly manifest: ExportManifest;
}

function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

function writeFile(outDir: string, relativePath: string, content: string | Uint8Array): number {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return statSync(target).size;
}

/**
 * Writes every record and blob reachable from the workspace into `outDir` (C-03-06). The
 * rows are the records as the schemas define them, one JSON object per line.
 */
export function exportWorkspace(store: Store, options: ExportOptions): ExportResult {
  const outDir = resolve(options.outDir);
  const blobsRoot = resolve(options.blobsDir ?? store.blobsDir);
  mkdirSync(outDir, { recursive: true });

  const tables: ExportedTable[] = [];
  const digests = new Set<string>();

  store.read((tx) => {
    for (const spec of tableSpecs) {
      const rows = tx.list(spec.table);
      for (const row of rows) {
        for (const field of spec.blobFields ?? []) {
          const digest = readPath(row, field);
          if (typeof digest === 'string') digests.add(digest);
        }
      }
      const body = rows.map((row) => JSON.stringify(row)).join('\n');
      const content = body === '' ? '' : `${body}\n`;
      const path = `${TABLES_DIRNAME}/${spec.table}.jsonl`;
      const bytes = writeFile(outDir, path, content);
      tables.push({
        table: spec.table,
        rows: rows.length,
        path,
        sha256: sha256Hex(content),
        bytes,
        recordType:
          spec.schema === undefined ? null : `${spec.schema.type}@${String(spec.schema.major)}`,
      });
    }
  });

  const blobs: ExportedFile[] = [];
  const missingBlobs: string[] = [];
  for (const digest of [...digests].sort()) {
    const source = blobPath(blobsRoot, digest);
    if (!existsSync(source)) {
      missingBlobs.push(digest);
      continue;
    }
    const path = posix(join(BLOBS_DIRNAME, relative(blobsRoot, source)));
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    blobs.push({ path, sha256: digest, bytes: statSync(target).size });
  }

  const manifest: ExportManifest = {
    tool: '@cc/store',
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    schemaVersion: store.schemaVersion,
    tables,
    blobs,
    missingBlobs,
  };
  const manifestPath = join(outDir, MANIFEST_NAME);
  writeFile(outDir, MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifestPath, manifest };
}
