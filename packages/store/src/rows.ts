/**
 * Record <-> row: scalar fields to columns, nested structures to JSON columns, validated by
 * the schema the API uses (03 §12 point 3, `validateRecord` from @cc/schemas).
 */
import { validateRecord } from '@cc/schemas';

import { StoreError } from './errors.js';
import type { ColumnSpec, TableSpec } from './tables.js';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a dot path such as "due.date" or "outcome.why"; `undefined` when any step is absent. */
export function readPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const step of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[step];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const steps = path.split('.');
  let current = target;
  for (const step of steps.slice(0, -1)) {
    const next = current[step];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      current[step] = created;
      current = created;
    } else {
      current = next;
    }
  }
  current[steps[steps.length - 1] ?? ''] = value;
}

function invalid(spec: TableSpec, column: ColumnSpec, value: unknown): StoreError {
  return new StoreError(
    'E_INVARIANT',
    `${spec.table}.${column.column}: ${column.field} is not a ${column.kind} (${typeof value})`,
    [`${spec.table} rows are written through the repository layer only (03 §12 point 4)`],
  );
}

function encode(spec: TableSpec, column: ColumnSpec, value: unknown): SqlValue {
  if (value === undefined || value === null) {
    if (column.optional === true || column.nullable === true) return null;
    throw invalid(spec, column, value);
  }
  switch (column.kind) {
    case 'text':
      if (typeof value !== 'string') throw invalid(spec, column, value);
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(spec, column, value);
      return value;
    case 'real':
      if (typeof value !== 'number') throw invalid(spec, column, value);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(spec, column, value);
      return value ? 1 : 0;
    case 'json':
      return JSON.stringify(value);
  }
}

function decode(column: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) {
    // A nullable field is present and null; an optional one is simply absent.
    return column.optional === true ? undefined : column.nullable === true ? null : undefined;
  }
  switch (column.kind) {
    case 'boolean':
      return value === 1;
    case 'json':
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : undefined;
    default:
      return value;
  }
}

/** The row a record writes: one entry per column of the table. */
export function toRow(spec: TableSpec, record: unknown): SqlRow {
  const row: SqlRow = {};
  for (const column of spec.columns) {
    row[column.column] = encode(spec, column, readPath(record, column.field));
  }
  return row;
}

/** The record a row holds, with absent optional fields left out. */
export function fromRow(spec: TableSpec, row: Record<string, unknown>): unknown {
  const record: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = decode(column, row[column.column]);
    if (value !== undefined) writePath(record, column.field, value);
  }
  return record;
}

/**
 * Validates a record against the table's schema, with the fields the store owns (the
 * `version` column, and the parent ID of a projection table) left out of the check. A table
 * whose record type is not written yet is checked only for its storage envelope.
 */
export function validateRow(spec: TableSpec, record: unknown): void {
  if (!isPlainObject(record)) {
    throw new StoreError('E_INVARIANT', `${spec.table}: a record must be an object`, []);
  }
  if (spec.schema === undefined) {
    if (!isPlainObject(record['doc'])) {
      throw new StoreError(
        'E_INVARIANT',
        `${spec.table}.doc must be a JSON object: @cc/schemas has no record type for ${spec.table} yet, so only the storage envelope is checked`,
        [`the record type arrives with ${spec.followUp ?? 'a later build step'}`],
      );
    }
    return;
  }
  const document: Record<string, unknown> = { ...record };
  for (const field of spec.managedFields) delete document[field];
  const issues = validateRecord(spec.schema, document);
  if (issues.length > 0) {
    throw new StoreError(
      'E_INVARIANT',
      `${spec.table}: the record does not match ${spec.schema.type}@${String(spec.schema.major)} (${spec.schema.spec})`,
      issues,
    );
  }
}
