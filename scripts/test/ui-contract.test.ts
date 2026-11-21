/**
 * The UI contract's stability rule (ADR 0008 decision 1; scripts/ui-contract.ts): within an
 * extension API version, params keep accepting what they accepted and results only gain
 * optional fields.
 */
import { describe, expect, it } from 'vitest';

import {
  contractBreaks,
  schemaBreaks,
  withoutAnnotations,
  type SchemaNode,
} from '../ui-contract.ts';

const str = { type: 'string' };
const int = { type: 'integer', minimum: 0 };

function object(
  properties: Record<string, unknown>,
  required: readonly string[] = Object.keys(properties),
): SchemaNode {
  return { type: 'object', properties, required, additionalProperties: false };
}

describe('UI contract: results', () => {
  const before = object({ ref: str, count: int, note: str }, ['ref', 'count']);

  it('AC-08-10 (UI part) a result may gain an optional field', () => {
    const after = object({ ref: str, count: int, note: str, hint: str }, ['ref', 'count']);
    expect(schemaBreaks(before, after, 'result')).toEqual([]);
  });

  it('AC-08-10 (UI part) a result may not lose a field, gain a required one or drop a guarantee', () => {
    expect(schemaBreaks(before, object({ ref: str, note: str }, ['ref']), 'result')).toEqual([
      'result.count: removed',
    ]);
    expect(
      schemaBreaks(
        before,
        object({ ref: str, count: int, note: str, added: str }, ['ref', 'count', 'added']),
        'result',
      ),
    ).toEqual([
      'result.added: a new field is always present; within an API version a result only gains optional fields',
    ]);
    expect(
      schemaBreaks(before, object({ ref: str, count: int, note: str }, ['ref']), 'result'),
    ).toEqual(['result.count: is no longer always present']);
  });

  it('a result may not change a type, gain a value, become nullable or loosen a limit', () => {
    const state = { type: 'string', enum: ['open', 'done'] };
    expect(schemaBreaks(state, { type: 'string', enum: ['done', 'open'] }, 'result')).toEqual([]);
    expect(schemaBreaks(state, { type: 'string', enum: ['open'] }, 'result')).toEqual([]);
    expect(
      schemaBreaks(state, { type: 'string', enum: ['open', 'done', 'gone'] }, 'result'),
    ).toEqual(['result: gained the value(s) "gone"']);
    expect(schemaBreaks(str, int, 'result')).toEqual([
      'result: type changed from string to integer',
    ]);
    expect(schemaBreaks(str, { anyOf: [str, { type: 'null' }] }, 'result')).toEqual([
      'result: can now be null, which it could not be before (result: type changed from string to null)',
    ]);
    expect(
      schemaBreaks(
        { type: 'array', items: str, maxItems: 3 },
        { type: 'array', items: str },
        'result',
      ),
    ).toEqual(['result: maxItems changed from 3 to undefined']);
    expect(
      schemaBreaks(
        { type: 'array', items: str },
        { type: 'array', items: str, maxItems: 3 },
        'result',
      ),
    ).toEqual([]);
  });

  it('an integer result may not become any number, but a number result may become an integer', () => {
    expect(schemaBreaks(int, { type: 'number', minimum: 0 }, 'result')).toEqual([
      'result: type changed from integer to number',
    ]);
    expect(schemaBreaks({ type: 'number' }, { type: 'integer' }, 'result')).toEqual([]);
  });
});

describe('UI contract: params', () => {
  const before = object({ ref: str, limit: int }, ['ref']);

  it('AC-08-10 (UI part) params may gain an optional field, relax a required one or accept more', () => {
    expect(
      schemaBreaks(before, object({ ref: str, limit: int, tab: str }, ['ref']), 'params'),
    ).toEqual([]);
    expect(schemaBreaks(before, object({ ref: str, limit: int }, []), 'params')).toEqual([]);
    expect(
      schemaBreaks({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] }, 'params'),
    ).toEqual([]);
    expect(schemaBreaks(str, { anyOf: [str, { type: 'null' }] }, 'params')).toEqual([]);
    expect(schemaBreaks({ ...int, maximum: 200 }, { ...int, maximum: 500 }, 'params')).toEqual([]);
  });

  it('AC-08-10 (UI part) params may not lose a field, require a new one or accept less', () => {
    expect(schemaBreaks(before, object({ ref: str }, ['ref']), 'params')).toEqual([
      'params.limit: removed',
    ]);
    expect(
      schemaBreaks(before, object({ ref: str, limit: int, why: str }, ['ref', 'why']), 'params'),
    ).toEqual(['params.why: a new field is required']);
    expect(
      schemaBreaks(before, object({ ref: str, limit: int }, ['ref', 'limit']), 'params'),
    ).toEqual(['params.limit: is now required']);
    expect(
      schemaBreaks({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }, 'params'),
    ).toEqual(['params: no longer accepts "b"']);
    expect(schemaBreaks({ ...int, maximum: 500 }, { ...int, maximum: 200 }, 'params')).toEqual([
      'params: maximum changed from 500 to 200',
    ]);
    expect(schemaBreaks(str, { ...str, pattern: '^A-' }, 'params')).toEqual([
      'params: pattern changed from undefined to "^A-"',
    ]);
  });

  it('a discriminated union keeps accepting each kind it accepted', () => {
    const folder = object({ kind: { type: 'string', const: 'folder' }, label: str });
    const s3 = object({ kind: { type: 'string', const: 's3' }, bucket: str });
    expect(schemaBreaks({ oneOf: [folder] }, { oneOf: [folder, s3] }, 'params')).toEqual([]);
    expect(schemaBreaks({ oneOf: [folder, s3] }, { oneOf: [folder] }, 'params')).toEqual([
      'params: no longer accepts object (params.kind: no longer accepts "s3")',
    ]);
  });
});

describe('UI contract: references, annotations and methods', () => {
  it('follows $defs, recursive ones included', () => {
    const tree = (extra: Record<string, unknown>): SchemaNode => ({
      $ref: '#/$defs/Node',
      $defs: {
        Node: object(
          { name: str, children: { type: 'array', items: { $ref: '#/$defs/Node' } }, ...extra },
          ['name', 'children'],
        ),
      },
    });
    expect(schemaBreaks(tree({}), tree({ hint: str }), 'result')).toEqual([]);
    expect(
      schemaBreaks(
        tree({}),
        {
          $ref: '#/$defs/Node',
          $defs: { Node: object({ children: { type: 'array', items: { $ref: '#/$defs/Node' } } }) },
        },
        'result',
      ),
    ).toEqual(['result.name: removed']);
  });

  it('ignores descriptions and defaults, but not property names that look like them', () => {
    const before = withoutAnnotations({
      type: 'object',
      description: 'A row',
      properties: { description: { type: 'string', description: 'The text' } },
      required: ['description'],
    }) as Record<string, unknown>;
    expect(before).toEqual({
      type: 'object',
      properties: { description: { type: 'string' } },
      required: ['description'],
    });
    expect(
      schemaBreaks(before, withoutAnnotations({ ...before, title: 'Row' }) as SchemaNode, 'result'),
    ).toEqual([]);
  });

  it('AC-08-10 (UI part) a method may not leave the contract, and a new one may join it', () => {
    const method = { params: object({}), result: object({ ok: { type: 'boolean' } }) };
    expect(
      contractBreaks(
        { apiVersion: 1, methods: { 'home.get': method } },
        { apiVersion: 1, methods: { 'home.get': method, 'items.list': method } },
      ),
    ).toEqual([]);
    expect(
      contractBreaks(
        { apiVersion: 1, methods: { 'home.get': method, 'items.list': method } },
        { apiVersion: 1, methods: { 'home.get': method } },
      ),
    ).toEqual(['items.list: left the UI contract (removed, or no longer marked ui)']);
  });
});
