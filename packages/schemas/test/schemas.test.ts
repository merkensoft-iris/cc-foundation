import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ActionItemId,
  Actor,
  ApiErrorData,
  apiMethods,
  ConnectorBindingId,
  HumanRef,
  humanRef,
  methods,
  pendingNamespaces,
  Predicate,
  recordTypes,
  UtcTimestamp,
  validateRecord,
  WorkstreamKind,
} from '@cc/schemas';

const root = fileURLToPath(new URL('../../..', import.meta.url));

function design(file: string): string {
  return readFileSync(join(root, 'docs', 'design', file), 'utf8').replaceAll('\r\n', '\n');
}

/** The method names in backticks of 04 §4.1 rule 2, e.g. `items.list` or `decisions.*`. */
function designMethods(): string[] {
  const text = design('04-platform.md');
  const start = text.indexOf('\n### 4.1 ');
  const rule = text.slice(start, text.indexOf('\n### 4.2 ', start)).split('\n2. Protocol:')[1];
  return [...(rule?.split('\n')[0] ?? '').matchAll(/`([a-z]+\.(?:[a-z]+|\*))`/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('record conventions (03 §3)', () => {
  it('IDs carry their prefix, and placeholders may hold underscores as in 03 §13', () => {
    expect(ConnectorBindingId.safeParse('bnd_gmail_ald').success).toBe(true);
    expect(ActionItemId.safeParse('act_01JD3QW8Y6').success).toBe(true);
    expect(ActionItemId.safeParse('dec_d0008').success).toBe(false);
    expect(ActionItemId.safeParse('act_').success).toBe(false);
  });

  it('HumanRefs are a counted letter and at least four digits', () => {
    expect(HumanRef.safeParse('A-0142').success).toBe(true);
    expect(HumanRef.safeParse('K-10000').success).toBe(true);
    expect(HumanRef.safeParse('X-0001').success).toBe(false);
    expect(humanRef('D').safeParse('A-0142').success).toBe(false);
  });

  it('timestamps are UTC and actors are one of four kinds', () => {
    expect(UtcTimestamp.safeParse('2026-11-13T09:30:00Z').success).toBe(true);
    expect(UtcTimestamp.safeParse('2026-11-13T15:00:00+05:30').success).toBe(false);
    expect(Actor.safeParse({ kind: 'agent', principalId: 'agt_cli_default' }).success).toBe(true);
    expect(Actor.safeParse({ kind: 'agent' }).success).toBe(false);
    expect(Actor.safeParse({ kind: 'user', principalId: 'agt_x' }).success).toBe(false);
  });

  it('predicates nest through all and any', () => {
    const nested = {
      all: [
        { path: 'messages.length', op: 'gte', value: 1 },
        {
          any: [
            { path: 'status', op: 'eq', value: 'publish' },
            { path: 'url', op: 'exists' },
          ],
        },
      ],
    };
    expect(Predicate.safeParse(nested).success).toBe(true);
    expect(Predicate.safeParse({ all: [] }).success).toBe(false);
    expect(Predicate.safeParse({ path: 'x', op: 'like' }).success).toBe(false);
  });

  it('the Workspace pseudo-workstream kind exists (owner decision Q4, PR 3)', () => {
    expect(WorkstreamKind.options).toContain('workspace');
  });
});

describe('record types (03 §5)', () => {
  it('registers every record type of 03 §5, AgentPrincipal, FrameworkInstance, MeetingSeries and MeetingInstance once', () => {
    expect(recordTypes.map((record) => record.type)).toEqual([
      'workspace',
      'person',
      'workstream',
      'goal',
      'measure',
      'measure_value',
      'decision',
      'issue',
      'risk',
      'action_item',
      'run',
      'evidence',
      'domain_event',
      'agent_principal',
      'framework_instance',
      'meeting_series',
      'meeting_instance',
    ]);
  });

  it('records are strict: an unknown field is an issue', () => {
    const risk = recordTypes.find((record) => record.type === 'risk');
    expect(risk).toBeDefined();
    if (risk === undefined) return;
    const value = {
      id: 'rsk_r0001',
      ref: 'R-0001',
      workstreamId: 'ws_workspace',
      description: 'A risk',
      watcherId: 'per_self',
      trigger: 'A trigger',
      status: 'watching',
      reviewCadence: 'monthly',
      createdAt: '2026-11-04T05:00:00Z',
      createdBy: { kind: 'user' },
      updatedAt: '2026-11-04T05:00:00Z',
      updatedBy: { kind: 'user' },
      version: 1,
    };
    expect(validateRecord(risk, value)).toEqual([]);
    expect(validateRecord(risk, { ...value, severity: 'high' })).toEqual([
      '(root): Unrecognized key: "severity"',
    ]);
  });
});

describe('local API methods (04 §4.1)', () => {
  it('covers every method 04 §4.1 names, or lists its namespace as pending', () => {
    const named = designMethods();
    expect(named.length).toBeGreaterThan(20);
    const defined = new Set(apiMethods.map((definition) => definition.method));
    const pending = new Set(pendingNamespaces.map((entry) => entry.namespace));
    for (const name of named) {
      if (name.endsWith('.*')) {
        const namespace = name.slice(0, -1);
        const covered =
          pending.has(name) || [...defined].some((method) => method.startsWith(namespace));
        expect(covered, `${name} has no methods and is not pending`).toBe(true);
      } else {
        expect(defined.has(name), `${name} has no schema`).toBe(true);
      }
    }
    for (const entry of pendingNamespaces) {
      expect(named).toContain(entry.namespace);
      const namespace = entry.namespace.slice(0, -1);
      expect([...defined].some((method) => method.startsWith(namespace))).toBe(false);
    }
  });

  it('names are <namespace>.<verb>, unique, and each has a scope unless human-only or auth.*', () => {
    const names = apiMethods.map((definition) => definition.method);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of apiMethods) {
      expect(definition.method).toMatch(/^[a-z]+\.[a-z]+$/);
      if (definition.humanOnly || definition.method.startsWith('auth.')) {
        expect(definition.scope, definition.method).toBeUndefined();
      } else {
        expect(definition.scope, definition.method).toBeDefined();
      }
    }
  });

  it('the human-only operations of 04 §4.3 the API serves are marked human-only', () => {
    const humanOnly = apiMethods.filter((definition) => definition.humanOnly);
    expect(humanOnly.map((definition) => definition.method)).toEqual([
      'items.drop',
      'items.accept',
      'items.confirm',
      'items.attest',
      'items.reject',
      'decisions.decide',
      'meetings.confirm',
      'goals.update',
      'principals.create',
      'principals.update',
      'principals.revoke',
    ]);
  });

  it('claim params take every --evidence form of 07 §4.2', () => {
    const params = {
      ref: 'A-0142',
      evidence: [
        { kind: 'url', url: 'https://example.com/post' },
        { kind: 'file', path: 'proposal.pdf', requirementId: 'er1' },
        {
          kind: 'connector_record',
          binding: 'gmail-alderwick',
          recordType: 'message',
          externalId: 'msg_1',
        },
      ],
      note: 'Sent from Gmail directly',
    };
    expect(methods.itemsClaim.params.safeParse(params).success).toBe(true);
    expect(methods.itemsClaim.params.safeParse({ ...params, ref: 'D-0008' }).success).toBe(false);
    expect(methods.itemsClaim.params.safeParse({ ...params, ref: 'act_a0142' }).success).toBe(true);
  });

  it('create params require title, due and done-means, and cap the title at 120 characters', () => {
    const params = {
      workstream: 'alderwick',
      title: 'Send revised proposal with phased pricing to the consulting lead',
      due: '2026-11-12',
      doneMeans: 'The revised proposal is sent to the lead.',
    };
    expect(methods.itemsCreate.params.safeParse(params).success).toBe(true);
    expect(
      methods.itemsCreate.params.safeParse({ ...params, title: 'x'.repeat(121) }).success,
    ).toBe(false);
    const withoutDoneMeans: Partial<typeof params> = { ...params };
    delete withoutDoneMeans.doneMeans;
    expect(methods.itemsCreate.params.safeParse(withoutDoneMeans).success).toBe(false);
  });

  it('error data carries a CC error code of 07 §4.4 and help lines', () => {
    const data = {
      code: 'E_HUMAN_REQUIRED',
      message: 'Confirming a claim is human-only',
      help: ['Open it in the app: commandcenter://items/A-0142'],
    };
    expect(ApiErrorData.safeParse(data).success).toBe(true);
    expect(ApiErrorData.safeParse({ ...data, code: 'E_GUARD_ORIGIN' }).success).toBe(true);
    expect(ApiErrorData.safeParse({ ...data, code: 'E_TEAPOT' }).success).toBe(false);
  });
});
