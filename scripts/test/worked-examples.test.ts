/**
 * AC-03-06: each worked example in docs/design/03-decisions-and-action-items.md §13 validates
 * against the generated JSON Schemas, as `pnpm cc:gen --check` fixtures.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

import {
  compileJsonSchema,
  RECORDS_DIR,
  runGen,
  validateFixtures,
  type JsonSchemaValidator,
} from '../gen.ts';
import { recordTypes } from '@cc/schemas';

const root = fileURLToPath(new URL('../..', import.meta.url));
const DESIGN = 'docs/design/03-decisions-and-action-items.md';

/** Every subsection of 03 §13 and the record fixture that carries it. */
const WORKED_EXAMPLES: Record<string, string> = {
  '13.1': 'fixtures/records/action_item@1/a-0142.json',
  '13.2': 'fixtures/records/action_item@1/a-0160.json',
  '13.3': 'fixtures/records/action_item@1/a-0152.json',
  '13.4': 'fixtures/records/action_item@1/a-0144.json',
  '13.5': 'fixtures/records/decision@1/d-0008.json',
};

function section13(): string {
  const text = readFileSync(join(root, DESIGN), 'utf8').replaceAll('\r\n', '\n');
  const start = text.indexOf('\n## 13. ');
  const end = text.indexOf('\n## 14. ', start);
  expect(start).toBeGreaterThan(0);
  return text.slice(start, end);
}

/** The JSON blocks of each §13 subsection, keyed by subsection number. */
function exampleJson(): Map<string, unknown[]> {
  const blocks = new Map<string, unknown[]>();
  for (const part of section13()
    .split(/\n### (?=13\.\d+ )/)
    .slice(1)) {
    const number = part.slice(0, part.indexOf(' '));
    const json = [...part.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (match) => JSON.parse(match[1] ?? '') as unknown,
    );
    blocks.set(number, json);
  }
  return blocks;
}

function readFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

/** The generated record schemas on disk, compiled. */
function generatedValidators(): Map<string, JsonSchemaValidator> {
  const validators = new Map<string, JsonSchemaValidator>();
  for (const record of recordTypes) {
    const name = `${record.type}@${record.major}.json`;
    const schema = JSON.parse(readFileSync(join(root, RECORDS_DIR, name), 'utf8')) as object;
    validators.set(name, compileJsonSchema(schema));
  }
  return validators;
}

/** True when every member of `part` appears with the same value in `whole`. */
function contains(whole: unknown, part: unknown): boolean {
  if (Array.isArray(part)) {
    return (
      Array.isArray(whole) &&
      whole.length === part.length &&
      part.every((item, index) => contains(whole[index], item))
    );
  }
  if (part !== null && typeof part === 'object') {
    if (whole === null || typeof whole !== 'object' || Array.isArray(whole)) return false;
    return Object.entries(part).every(([key, value]) =>
      contains((whole as Record<string, unknown>)[key], value),
    );
  }
  return Object.is(whole, part);
}

// Each runGen formats and compiles every generated schema; slower CI runners need the room.
describe('03 §13 worked examples', { timeout: 30_000 }, () => {
  it('AC-03-06 every worked example in 03 §13 has a record fixture', () => {
    expect([...exampleJson().keys()]).toEqual(Object.keys(WORKED_EXAMPLES));
  });

  it('AC-03-06 each worked example validates against the generated JSON Schemas and its zod source', () => {
    const results = validateFixtures(root, recordTypes, generatedValidators());
    for (const path of Object.values(WORKED_EXAMPLES)) {
      expect(results.find((result) => result.path === path)).toEqual({ path, issues: [] });
    }
  });

  it('AC-03-06 the JSON of 03 §13.1 and §13.5 is in its fixture unchanged', () => {
    const blocks = exampleJson();
    const withJson = [...blocks].filter(([, json]) => json.length > 0);
    expect(withJson.map(([number]) => number)).toEqual(['13.1', '13.5']);
    for (const [number, json] of withJson) {
      const fixture = readFixture(WORKED_EXAMPLES[number] ?? '');
      expect(json).toHaveLength(1);
      expect(contains(fixture, json[0]), `03 §${number} JSON is not contained in its fixture`).toBe(
        true,
      );
      // The fixture adds only what the example leaves out: the audit fields, and the empty
      // actionItemIds of the still-open D-0008.
      const added = Object.keys(fixture).filter((key) => !(key in (json[0] as object)));
      expect(added.sort()).toEqual(
        [
          'createdAt',
          'createdBy',
          'updatedAt',
          'updatedBy',
          'version',
          ...(number === '13.5' ? ['actionItemIds'] : []),
        ].sort(),
      );
    }
  });

  it('AC-03-06 the prose examples of 03 §13.2 to §13.4 carry the facts the design states', () => {
    const a0160 = readFixture(WORKED_EXAMPLES['13.2'] ?? '');
    expect(a0160).toMatchObject({
      ref: 'A-0160',
      source: {
        kind: 'template',
        templateId: 'tpl.marketing.linkedin-batch',
        recurrenceKey: '2026-W47',
      },
      due: { date: '2026-11-19' },
      execution: {
        mode: 'mixed',
        steps: [
          { performer: { kind: 'agent', profile: 'drafter' } },
          { performer: { kind: 'user' } },
          { performer: { kind: 'user' } },
        ],
      },
      evidenceRequirements: [
        {
          id: 'er1',
          check: {
            type: 'connector_query',
            bindingId: 'bnd_linkedin_self',
            action: 'list_recent_posts',
          },
        },
      ],
    });

    const a0152 = readFixture(WORKED_EXAMPLES['13.3'] ?? '');
    expect(a0152).toMatchObject({
      ref: 'A-0152',
      ownerId: 'per_client',
      reviewerId: 'per_self',
      privacy: 'sensitive',
      execution: {
        steps: [
          { performer: { kind: 'agent', profile: 'drafter' } },
          { performer: { kind: 'user' } },
          { performer: { kind: 'connector', bindingId: 'bnd_gmail_ald', action: 'create_draft' } },
          { performer: { kind: 'user' } },
          { performer: { kind: 'person', personId: 'per_client' } },
        ],
      },
      evidenceRequirements: [{ id: 'er1', acceptedKinds: ['connector_record', 'note'] }],
    });

    const a0144 = readFixture(WORKED_EXAMPLES['13.4'] ?? '');
    expect(a0144).toMatchObject({
      ref: 'A-0144',
      execution: {
        steps: [
          { performer: { kind: 'external_agent', system: 'firstmate' } },
          { performer: { kind: 'user' }, satisfies: ['er2'] },
        ],
      },
      evidenceRequirements: [
        {
          id: 'er1',
          check: {
            type: 'external_task_state',
            system: 'firstmate',
            taskId: 'quillmarsh-contact-form',
            expect: 'merged',
          },
        },
        {
          id: 'er2',
          check: { type: 'url_reachable', expectStatus: [200], expectText: 'Thank you' },
        },
      ],
    });
  });

  it('AC-03-06 pnpm cc:gen --check fails when a worked example stops validating', async () => {
    const result = await runGen(root, true);
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toMatch(/; (\d+) of \1 fixture\(s\) valid\.$/);

    const dir = createProfileDir();
    try {
      for (const path of [
        '.prettierrc.json',
        RECORDS_DIR,
        'packages/schemas/api',
        'fixtures/records',
      ]) {
        cpSync(join(root, path), join(dir.path, path), { recursive: true });
      }
      const path = WORKED_EXAMPLES['13.1'] ?? '';
      const example = readFixture(path);
      writeFileSync(join(dir.path, path), JSON.stringify({ ...example, lifecycle: 'finished' }));
      const broken = await runGen(dir.path, true);
      expect(broken.exitCode).toBe(1);
      expect(broken.lines).toContain(
        `INVALID ${path}: lifecycle: must be equal to one of the allowed values (JSON Schema)`,
      );
      expect(
        broken.lines.some((line) => line.startsWith(`INVALID ${path}: lifecycle: Invalid`)),
      ).toBe(true);
    } finally {
      dir.cleanup();
    }
  });
});
