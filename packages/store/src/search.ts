/**
 * `fts_items`, the FTS5 index over titles, done-means and notes (03 §12 point 2). The
 * repository layer keeps it in sync inside the same transaction as the rows it indexes, so
 * a rolled-back command leaves no search entry behind either.
 */
import { readPath } from './rows.js';
import type { TableName, TableSpec } from './tables.js';

export interface SearchHit {
  readonly table: TableName;
  readonly id: string;
  readonly ref?: string;
  readonly title: string;
  /** The matching text with the match marked, from FTS5's `snippet()`. */
  readonly snippet: string;
  /** BM25 score; lower is a better match, as SQLite returns it. */
  readonly rank: number;
}

export interface FtsRow {
  readonly table_name: string;
  readonly item_id: string;
  readonly ref: string;
  readonly title: string;
  readonly done_means: string;
  readonly notes: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The `fts_items` row a record contributes, or `undefined` when the table is not indexed. */
export function ftsRow(spec: TableSpec, id: string, record: unknown): FtsRow | undefined {
  const fts = spec.fts;
  if (fts === undefined) return undefined;
  const notes = (fts.notes ?? [])
    .map((path) => text(readPath(record, path)))
    .filter((note) => note !== '')
    .join('\n');
  return {
    table_name: spec.table,
    item_id: id,
    ref: fts.ref === undefined ? '' : text(readPath(record, fts.ref)),
    title: text(readPath(record, fts.title)),
    done_means: fts.doneMeans === undefined ? '' : text(readPath(record, fts.doneMeans)),
    notes,
  };
}

/**
 * Turns what a person typed into an FTS5 MATCH expression: each word becomes a quoted term,
 * so punctuation and FTS5's own operators cannot make the query fail or mean something else.
 * A trailing `*` stays a prefix search, and `"a phrase"` stays one phrase.
 */
export function ftsQuery(input: string): string {
  const terms = input.match(/"[^"]*"|\S+/g) ?? [];
  return terms
    .map((term) => {
      if (term.startsWith('"')) return term.endsWith('"') ? term : `${term}"`;
      const prefix = term.endsWith('*');
      const word = (prefix ? term.slice(0, -1) : term).replaceAll('"', '');
      if (word === '') return '';
      return prefix ? `"${word}"*` : `"${word}"`;
    })
    .filter((term) => term !== '')
    .join(' ');
}
