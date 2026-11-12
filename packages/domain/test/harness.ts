/**
 * Test harness for @cc/domain: a fake clock, a counting ID source, a registry backed by the
 * synthetic fixtures of fixtures/records, and helpers that check every write a command
 * returns: one event each (INV-03-09), and every record valid against its schema.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

import {
  type Caller,
  type DomainContext,
  type FrameworkValidator,
  type NewActionItem,
  type Outcome,
  type Registry,
} from '@cc/domain';
import {
  type ActionItem,
  type HumanRefKind,
  type Person,
  recordTypes,
  type Scope,
  validateRecord,
  type Workstream,
} from '@cc/schemas';
import { createFakeClock, type FakeClock } from '@cc/test-kit';

const root = fileURLToPath(new URL('../../..', import.meta.url));

export function fixture<T>(type: string, name: string): T {
  return JSON.parse(
    readFileSync(join(root, 'fixtures', 'records', `${type}@1`, `${name}.json`), 'utf8'),
  ) as T;
}

/**
 * A sensitive workstream for the privacy tests (INV-03-10). The reference scenario has none, so
 * this one is synthetic: a confidential project under Alderwick.
 */
export function privateWorkstream(): Workstream {
  // An R5 child inherits its parent's instance and has none of its own (01 §6.2).
  const parent: Partial<Workstream> = { ...fixture<Workstream>('workstream', 'alderwick') };
  delete parent.frameworkInstanceId;
  return {
    ...(parent as Workstream),
    id: 'ws_private',
    slug: 'private-project',
    name: 'Private project',
    kind: 'project',
    parentId: 'ws_ald',
    privacy: 'sensitive',
    aiDataPolicy: 'redact_people',
  };
}

export interface Harness {
  readonly ctx: DomainContext;
  readonly clock: FakeClock;
  /** Connector actions installed, as "bindingId.action" (INV-03-08). */
  readonly installed: Set<string>;
  /** Framework validators per workstream (INV-03-12). */
  readonly validators: Map<string, FrameworkValidator[]>;
}

export function harness(start = '2026-11-11T05:00:00Z'): Harness {
  const clock = createFakeClock(start);
  let next = 0;
  const counters: Record<HumanRefKind, number> = {
    A: 200,
    D: 10,
    I: 20,
    R: 5,
    M: 40,
    G: 10,
    K: 10,
  };
  const persons = new Map<string, Person>(
    ['self', 'client-contact'].map((name) => {
      const person = fixture<Person>('person', name);
      return [person.id, person];
    }),
  );
  const workstreams = new Map<string, Workstream>(
    [
      ...['alderwick', 'workspace'].map((name) => fixture<Workstream>('workstream', name)),
      privateWorkstream(),
    ].map((workstream) => [workstream.id, workstream]),
  );
  const installed = new Set<string>([
    'bnd_gmail_ald.search_messages',
    'bnd_gmail_ald.create_draft',
    'bnd_gmail_ald.send_draft',
  ]);
  const validators = new Map<string, FrameworkValidator[]>();
  const registry: Registry = {
    selfPersonId: 'per_self',
    person: (id) => persons.get(id),
    workstream: (id) => workstreams.get(id),
    connectorHasAction: (bindingId, action) => installed.has(`${bindingId}.${action}`),
    validators: (id) => validators.get(id) ?? [],
  };
  const ctx: DomainContext = {
    clock,
    ids: {
      id: (prefix) => `${prefix}_t${String(++next).padStart(4, '0')}`,
      ref: (kind) => `${kind}-${String(counters[kind]++).padStart(4, '0')}`,
    },
    registry,
  };
  return { ctx, clock, installed, validators };
}

export const user: Caller = { actor: { kind: 'user' } };

export function agent(...scopes: Scope[]): Caller {
  return { actor: { kind: 'agent', principalId: 'agt_cli_default' }, scopes };
}

export function system(
  component: 'rhythm' | 'review' | 'escalation' | 'ingest' | 'scheduler' | 'migration',
): Caller {
  return { actor: { kind: 'system', component } };
}

export const connector: Caller = {
  actor: { kind: 'connector', bindingId: 'bnd_gmail_ald', runId: 'run_t1' },
};

/** A valid new item in Alderwick, due 2026-11-13, with one required requirement. */
export function newItem(overrides: Partial<NewActionItem> = {}): NewActionItem {
  return {
    workstreamId: 'ws_ald',
    title: 'Send the revised proposal to the consulting lead',
    doneMeans: 'The proposal is sent from the Alderwick mailbox and filed in the client folder.',
    due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' },
    evidenceRequirements: [
      {
        id: 'er1',
        description: 'Sent message or a link to the filed proposal',
        required: true,
        acceptedKinds: ['url', 'connector_record', 'note'],
      },
    ],
    lifecycle: 'open',
    ...overrides,
  };
}

const schemaOf = new Map(recordTypes.map((record) => [record.type, record]));

/**
 * Checks a command's writes: each change has exactly one event for its own record
 * (INV-03-09), the event is a valid DomainEvent, and the record is valid against its schema.
 */
export function checked<T>(outcome: Outcome<T>): Outcome<T> {
  const eventSchema = schemaOf.get('domain_event');
  for (const write of outcome.changes) {
    const record = write.record as { id: string };
    expect(write.event.entity.id).toBe(record.id);
    expect(write.event.type.startsWith(`${write.kind}.`)).toBe(true);
    if (eventSchema !== undefined) expect(validateRecord(eventSchema, write.event)).toEqual([]);
    const schema = schemaOf.get(write.kind);
    if (schema !== undefined) expect(validateRecord(schema, write.record)).toEqual([]);
  }
  if (outcome.status === 'no-op') expect(outcome.changes).toEqual([]);
  return outcome;
}

/** Runs a command expected to fail and returns its DomainError fields. */
export function failure(run: () => unknown): {
  code: string;
  rule: string;
  help: readonly string[];
} {
  try {
    run();
  } catch (error) {
    const e = error as { code: string; rule: string; help: readonly string[] };
    return { code: e.code, rule: e.rule, help: e.help };
  }
  throw new Error('expected the command to fail');
}

export type { ActionItem };
