/**
 * The UI contract's stability rule (ADR 0008 decision 1, 08 §6 `cc:gen`): within one extension
 * API version a method marked `ui` changes only compatibly for the UIs built on it.
 *
 * - **Params** (what a UI sends) must accept everything they accepted: a field may become
 *   optional and an optional field may be added; a field may not be removed or become
 *   required, a value may not stop being accepted, and a limit may only loosen.
 * - **Results** (what a UI reads) may only gain optional fields: a field may not be removed or
 *   stop being always present, a new field must be optional, a value or type a UI does not
 *   know may not appear, and a limit may only tighten.
 * - A method may not leave the contract (lose its `ui` mark, or be removed).
 *
 * The rule compares the JSON Schemas `pnpm cc:gen` records for the version
 * (`packages/ui-sdk/contract/v<N>.json`) with the schemas generated now. Anything it does not
 * understand counts as a break, so it errs towards asking for a version bump. Annotations
 * (descriptions, titles, defaults, examples) never matter.
 */

/** A JSON Schema node as zod writes it (draft 2020-12). */
export type SchemaNode = Readonly<Record<string, unknown>> | boolean;

export type Direction = 'params' | 'result';

/** What `pnpm cc:gen` records for one method of the UI contract. */
export interface ContractMethod {
  readonly params: SchemaNode;
  readonly result: SchemaNode;
}

/** `packages/ui-sdk/contract/v<N>.json`. */
export interface ContractDocument {
  readonly apiVersion: number;
  readonly methods: Readonly<Record<string, ContractMethod>>;
}

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const SCHEMA_MAPS = new Set(['properties', '$defs', 'patternProperties', 'dependentSchemas']);
const SCHEMA_VALUES = new Set([
  'items',
  'additionalProperties',
  'propertyNames',
  'not',
  'contains',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A schema without its annotations: what the contract records and compares. */
export function withoutAnnotations(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, withoutAnnotations(child)]),
      );
    } else if (SCHEMA_VALUES.has(key)) {
      out[key] = withoutAnnotations(value);
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map((child) => withoutAnnotations(child));
    } else {
      out[key] = value;
    }
  }
  return out;
}

const LOWER_LIMITS = ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'];
const UPPER_LIMITS = ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'];
const EXACT_LIMITS = ['pattern', 'format', 'multipleOf', 'uniqueItems'];
/** Keywords `compare` reads; any other one must be unchanged. */
const HANDLED = new Set([
  ...ANNOTATIONS,
  ...LOWER_LIMITS,
  ...UPPER_LIMITS,
  ...EXACT_LIMITS,
  '$ref',
  '$defs',
  'anyOf',
  'oneOf',
  'enum',
  'const',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
]);

interface Context {
  readonly direction: Direction;
  readonly oldRoot: SchemaNode;
  readonly newRoot: SchemaNode;
  /** The `$ref` pairs being compared, outermost first: a recursive type stops here. */
  readonly inProgress: Set<string>;
}

const show = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

function asObject(schema: SchemaNode | unknown): Readonly<Record<string, unknown>> {
  if (schema === false) return { not: {} };
  return isObject(schema) ? schema : {};
}

/** Follows a local `$ref` (`#` or `#/$defs/<name>`), keeping the referring node's siblings. */
function resolve(
  node: Readonly<Record<string, unknown>>,
  root: SchemaNode,
): Readonly<Record<string, unknown>> {
  const ref = node['$ref'];
  if (typeof ref !== 'string') return node;
  const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
  const rootObject = asObject(root);
  let target: unknown;
  if (ref === '#') target = rootObject;
  else if (ref.startsWith('#/$defs/')) {
    const defs = rootObject['$defs'];
    target = isObject(defs) ? defs[ref.slice('#/$defs/'.length)] : undefined;
  }
  if (target === undefined) return { ...siblings, $unresolved: ref };
  return { ...resolve(asObject(target), root), ...siblings };
}

function alternatives(node: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  const list = node['anyOf'] ?? node['oneOf'];
  return Array.isArray(list) ? list : undefined;
}

function values(node: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  if ('const' in node) return [node['const']];
  const list = node['enum'];
  return Array.isArray(list) ? list : undefined;
}

function types(node: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  const type = node['type'];
  if (typeof type === 'string') return [type];
  return Array.isArray(type) ? type.filter((entry) => typeof entry === 'string') : undefined;
}

/** Whether every type in `inner` is one of `outer` (an integer is a number). */
function coversTypes(outer: readonly string[], inner: readonly string[]): boolean {
  return inner.every(
    (type) => outer.includes(type) || (type === 'integer' && outer.includes('number')),
  );
}

function summary(schema: unknown): string {
  const node = asObject(schema);
  const vals = values(node);
  if (vals !== undefined) return vals.map(show).join(' or ');
  const kinds = types(node);
  return kinds === undefined ? 'any value' : kinds.join(' or ');
}

/** Whether a limit moved towards accepting fewer values (`tighter`), more, or neither. */
function limitChange(
  key: string,
  before: unknown,
  after: unknown,
): 'tighter' | 'looser' | 'changed' {
  if (before === undefined) return 'tighter';
  if (after === undefined) return 'looser';
  if (LOWER_LIMITS.includes(key) && typeof before === 'number' && typeof after === 'number') {
    return after > before ? 'tighter' : 'looser';
  }
  if (UPPER_LIMITS.includes(key) && typeof before === 'number' && typeof after === 'number') {
    return after < before ? 'tighter' : 'looser';
  }
  return 'changed';
}

function compare(oldSchema: unknown, newSchema: unknown, path: string, context: Context): string[] {
  const oldRef = asObject(oldSchema)['$ref'];
  const newRef = asObject(newSchema)['$ref'];
  if (typeof oldRef !== 'string' && typeof newRef !== 'string') {
    return compareResolved(oldSchema, newSchema, path, context);
  }
  // A recursive type met again inside its own comparison: the outer comparison covers it.
  const key = `${String(oldRef)}|${String(newRef)}`;
  if (context.inProgress.has(key)) return [];
  context.inProgress.add(key);
  try {
    return compareResolved(oldSchema, newSchema, path, context);
  } finally {
    context.inProgress.delete(key);
  }
}

function compareResolved(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  context: Context,
): string[] {
  const before = resolve(asObject(oldSchema), context.oldRoot);
  const after = resolve(asObject(newSchema), context.newRoot);
  const params = context.direction === 'params';
  const problems: string[] = [];

  if ('$unresolved' in before || '$unresolved' in after) {
    return [`${path}: has a reference the check cannot follow`];
  }

  const beforeAlts = alternatives(before);
  const afterAlts = alternatives(after);
  if (beforeAlts !== undefined || afterAlts !== undefined) {
    const olds = beforeAlts ?? [before];
    const news = afterAlts ?? [after];
    // Params: every old alternative is still accepted by a new one. Results: every new
    // alternative is one an old one allowed.
    const [must, may] = params ? [olds, news] : [news, olds];
    for (const candidate of must) {
      const attempts = may.map((other) =>
        params
          ? compare(candidate, other, path, context)
          : compare(other, candidate, path, context),
      );
      if (attempts.some((attempt) => attempt.length === 0)) continue;
      const closest = attempts.reduce<string[] | undefined>(
        (best, attempt) => (best === undefined || attempt.length < best.length ? attempt : best),
        undefined,
      );
      const why = closest?.[0] === undefined ? '' : ` (${closest[0]})`;
      problems.push(
        params
          ? `${path}: no longer accepts ${summary(candidate)}${why}`
          : `${path}: can now be ${summary(candidate)}, which it could not be before${why}`,
      );
    }
    return problems;
  }

  const beforeValues = values(before);
  const afterValues = values(after);
  if (params) {
    if (afterValues !== undefined) {
      if (beforeValues === undefined) {
        problems.push(`${path}: now accepts only ${afterValues.map(show).join(', ')}`);
      } else {
        const lost = beforeValues.filter(
          (value) => !afterValues.some((v) => show(v) === show(value)),
        );
        if (lost.length > 0)
          problems.push(`${path}: no longer accepts ${lost.map(show).join(', ')}`);
      }
    }
  } else if (beforeValues !== undefined) {
    if (afterValues === undefined) {
      problems.push(`${path}: is no longer limited to ${beforeValues.map(show).join(', ')}`);
    } else {
      const gained = afterValues.filter(
        (value) => !beforeValues.some((v) => show(v) === show(value)),
      );
      if (gained.length > 0)
        problems.push(`${path}: gained the value(s) ${gained.map(show).join(', ')}`);
    }
  }

  const beforeTypes = types(before);
  const afterTypes = types(after);
  const [outer, inner] = params ? [afterTypes, beforeTypes] : [beforeTypes, afterTypes];
  if (outer !== undefined && (inner === undefined || !coversTypes(outer, inner))) {
    problems.push(
      `${path}: type changed from ${beforeTypes?.join(' or ') ?? 'any'} to ${afterTypes?.join(' or ') ?? 'any'}`,
    );
  }

  for (const key of [...LOWER_LIMITS, ...UPPER_LIMITS, ...EXACT_LIMITS]) {
    const was = before[key];
    const now = after[key];
    if (show(was) === show(now)) continue;
    const change = limitChange(key, was, now);
    if (change === 'changed' || change === (params ? 'tighter' : 'looser')) {
      problems.push(`${path}: ${key} changed from ${show(was)} to ${show(now)}`);
    }
  }

  problems.push(...compareObjects(before, after, path, context));

  if ('items' in before || 'items' in after) {
    problems.push(...compare(before['items'] ?? {}, after['items'] ?? {}, `${path}[]`, context));
  }

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (HANDLED.has(key)) continue;
    if (show(before[key]) !== show(after[key])) problems.push(`${path}: ${key} changed`);
  }
  return problems;
}

function compareObjects(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  path: string,
  context: Context,
): string[] {
  const keywords = ['properties', 'required', 'additionalProperties', 'propertyNames'];
  if (!keywords.some((key) => key in before || key in after)) return [];
  const params = context.direction === 'params';
  const problems: string[] = [];
  const beforeProps = asObject(before['properties']);
  const afterProps = asObject(after['properties']);
  const required = (node: Readonly<Record<string, unknown>>) =>
    new Set(Array.isArray(node['required']) ? (node['required'] as unknown[]) : []);
  const beforeRequired = required(before);
  const afterRequired = required(after);

  for (const [name, schema] of Object.entries(beforeProps)) {
    const field = `${path}.${name}`;
    if (!(name in afterProps)) {
      problems.push(`${field}: removed`);
      continue;
    }
    if (params && !beforeRequired.has(name) && afterRequired.has(name)) {
      problems.push(`${field}: is now required`);
    }
    if (!params && beforeRequired.has(name) && !afterRequired.has(name)) {
      problems.push(`${field}: is no longer always present`);
    }
    problems.push(...compare(schema, afterProps[name], field, context));
  }
  for (const name of Object.keys(afterProps)) {
    if (name in beforeProps || !afterRequired.has(name)) continue;
    problems.push(
      params
        ? `${path}.${name}: a new field is required`
        : `${path}.${name}: a new field is always present; within an API version a result only gains optional fields`,
    );
  }

  // Other fields: absent means any are allowed, `false` none, a schema those matching it.
  const beforeExtra = before['additionalProperties'];
  const afterExtra = after['additionalProperties'];
  const open = (extra: unknown) => extra === undefined || extra === true;
  if (isObject(beforeExtra) && isObject(afterExtra)) {
    problems.push(...compare(beforeExtra, afterExtra, `${path}[*]`, context));
  } else if (show(beforeExtra) !== show(afterExtra)) {
    // Which side accepts more other fields: open, then a schema, then none.
    const rank = (extra: unknown) => (open(extra) ? 2 : extra === false ? 0 : 1);
    const widened = rank(afterExtra) > rank(beforeExtra);
    if (params ? !widened : widened) {
      problems.push(
        params
          ? `${path}: accepts fewer other fields than before`
          : `${path}: may now carry other fields`,
      );
    }
  }
  if ('propertyNames' in before || 'propertyNames' in after) {
    problems.push(
      ...compare(
        before['propertyNames'] ?? {},
        after['propertyNames'] ?? {},
        `${path}{key}`,
        context,
      ),
    );
  }
  return problems;
}

/** The incompatible changes from `before` to `after`, for a UI that sends or reads it. */
export function schemaBreaks(
  before: SchemaNode,
  after: SchemaNode,
  direction: Direction,
  path: string = direction,
): string[] {
  const context: Context = { direction, oldRoot: before, newRoot: after, inProgress: new Set() };
  return compare(before, after, path, context);
}

/** Every incompatible change from the recorded contract to the current one. */
export function contractBreaks(before: ContractDocument, after: ContractDocument): string[] {
  const problems: string[] = [];
  for (const [name, method] of Object.entries(before.methods)) {
    const now = after.methods[name];
    if (now === undefined) {
      problems.push(`${name}: left the UI contract (removed, or no longer marked ui)`);
      continue;
    }
    problems.push(...schemaBreaks(method.params, now.params, 'params', `${name} params`));
    problems.push(...schemaBreaks(method.result, now.result, 'result', `${name} result`));
  }
  return problems;
}
