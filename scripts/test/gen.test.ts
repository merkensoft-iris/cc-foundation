import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  apiMethods,
  MCP_TOOLS_BUDGET_BYTES,
  mcpToolList,
  methods,
  recordTypes,
  type ApiMethod,
} from '@cc/schemas';
import { createProfileDir } from '@cc/test-kit';

import {
  API_DIR,
  apiSchemas,
  CATALOGUE_DIR,
  CLI_REFERENCE_DIR,
  compileJsonSchema,
  FRAMEWORK_SCHEMAS_DIR,
  frameworkCatalogue,
  MCP_DIR,
  mcpTools,
  mcpToolsBytes,
  frameworkSchemas,
  ONBOARDING_FIXTURES_DIR,
  PACKS_DIR,
  RECORDS_DIR,
  recordSchemas,
  runGen,
  SKILL_DIR,
  TEMPLATES_DIR,
  UI_CLIENT_DIR,
  UI_CONTRACT_DIR,
  UI_METHODS_DIR,
  uiContractDir,
  uiContractGenerator,
  validateFixtures,
} from '../gen.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** A throwaway copy of what cc:gen reads and writes: Prettier config, generated files, fixtures. */
function copyRepo(): { path: string; cleanup(): void } {
  const dir = createProfileDir();
  for (const path of [
    '.prettierrc.json',
    RECORDS_DIR,
    API_DIR,
    'fixtures/records',
    FRAMEWORK_SCHEMAS_DIR,
    TEMPLATES_DIR,
    PACKS_DIR,
    CATALOGUE_DIR,
    ONBOARDING_FIXTURES_DIR,
    CLI_REFERENCE_DIR,
    SKILL_DIR,
    MCP_DIR,
    UI_METHODS_DIR,
    UI_CLIENT_DIR,
    UI_CONTRACT_DIR,
  ]) {
    cpSync(join(root, path), join(dir.path, path), { recursive: true });
  }
  return dir;
}

// Each runGen formats and compiles every generated schema; slower CI runners need the room.
describe('cc:gen', { timeout: 30_000 }, () => {
  it('AC-08-03 the committed record schemas match their packages/schemas sources', async () => {
    const result = await runGen(root, true);
    expect(result.lines.join('\n')).not.toContain('DRIFT');
    expect(result.exitCode).toBe(0);
  });

  it('C-07-06 the product skill is generated: a hand edit of SKILL.md fails cc:gen --check', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, SKILL_DIR, 'SKILL.md');
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(
        'description: Use when the user asks about their action items, decisions, meetings, scorecards, or Command Center.',
      );
      writeFileSync(file, `${text}\nA hand-written line.\n`);
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain(`DRIFT ${SKILL_DIR}/SKILL.md: changed`);
    } finally {
      copy.cleanup();
    }
  });

  it("ADR 0003 decision 9 main's window.cc allowlist is generated: a hand-added method fails cc:gen --check", async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, UI_METHODS_DIR, 'ui-methods.ts');
      const text = readFileSync(file, 'utf8');
      expect(text).toContain("'home.get'");
      writeFileSync(file, text.replace("'home.get',", "'home.get',\n  'auth.hello',"));
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain(`DRIFT ${UI_METHODS_DIR}/ui-methods.ts: changed`);
    } finally {
      copy.cleanup();
    }
  });

  it('AC-08-10 (UI part) the typed client of @cc/ui-sdk is generated from every method marked ui', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, UI_CLIENT_DIR, 'methods.ts');
      const text = readFileSync(file, 'utf8');
      for (const definition of apiMethods) {
        expect(text.includes(`readonly '${definition.method}': {`)).toBe(definition.ui);
      }
      expect(text).toContain('z.input<NonNullable<typeof methods.backupsDestination.uiParams>>');
      writeFileSync(file, text.replace("readonly 'home.get': {", "readonly 'home.get2': {"));
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain(`DRIFT ${UI_CLIENT_DIR}/methods.ts: changed`);
    } finally {
      copy.cleanup();
    }
  });

  describe('the UI contract guard (ADR 0008 decision 1)', () => {
    const dir = uiContractDir(1);
    const homeGet = methods.homeGet;
    const withHomeGet = (replacement: ApiMethod | undefined): ApiMethod[] =>
      apiMethods.flatMap((definition) =>
        definition === homeGet ? (replacement === undefined ? [] : [replacement]) : [definition],
      );

    it('records one contract file per method marked ui, and it matches the schemas', async () => {
      const files = await uiContractGenerator().generate(root);
      expect(files.map((file) => file.path)).toEqual(
        apiMethods
          .filter((definition) => definition.ui)
          .map((definition) => `${dir}/${definition.method}.json`)
          .sort(),
      );
      expect(await uiContractGenerator().problems?.(root)).toEqual([]);
    });

    it('AC-08-10 (UI part) an incompatible change to a ui method fails cc:gen, with or without --check, until the API is bumped', async () => {
      const copy = copyRepo();
      try {
        const broken = uiContractGenerator(
          withHomeGet({ ...homeGet, result: homeGet.result.omit({ workspace: true }) }),
        );
        const file = join(copy.path, dir, 'home.get.json');
        const recorded = readFileSync(file, 'utf8');
        for (const check of [true, false]) {
          const result = await runGen(copy.path, check, [broken]);
          expect(result.exitCode).toBe(1);
          expect(result.lines).toContain(`UI CONTRACT ${dir}: home.get result.workspace: removed`);
          expect(result.lines.join('\n')).toContain('bump EXTENSION_API_CURRENT');
        }
        // Writing keeps the recorded contract, so running cc:gen does not wave the break through.
        expect(readFileSync(file, 'utf8')).toBe(recorded);
        // A bump records the new version beside the old one, which stays for API N−1.
        const bumped = uiContractGenerator(
          withHomeGet({ ...homeGet, result: homeGet.result.omit({ workspace: true }) }),
          2,
        );
        const result = await runGen(copy.path, false, [bumped]);
        expect(result.exitCode).toBe(0);
        expect(
          readFileSync(join(copy.path, uiContractDir(2), 'home.get.json'), 'utf8'),
        ).not.toContain('"workspace"');
        expect(readFileSync(file, 'utf8')).toBe(recorded);
      } finally {
        copy.cleanup();
      }
    });

    it('AC-08-10 (UI part) a method that leaves the contract fails cc:gen --check', async () => {
      const copy = copyRepo();
      try {
        for (const replacement of [{ ...homeGet, ui: false }, undefined]) {
          const result = await runGen(copy.path, true, [
            uiContractGenerator(withHomeGet(replacement)),
          ]);
          expect(result.exitCode).toBe(1);
          expect(result.lines).toContain(
            `UI CONTRACT ${dir}: home.get: left the UI contract (removed, or no longer marked ui)`,
          );
        }
      } finally {
        copy.cleanup();
      }
    });

    it('AC-08-10 (UI part) a compatible change updates the recorded contract', async () => {
      const copy = copyRepo();
      try {
        const grown = uiContractGenerator(
          withHomeGet({
            ...homeGet,
            result: homeGet.result.extend({ hint: homeGet.result.shape.workspace.optional() }),
          }),
        );
        const check = await runGen(copy.path, true, [grown]);
        expect(check.exitCode).toBe(1);
        expect(check.lines.join('\n')).toContain(`DRIFT ${dir}/home.get.json: changed`);
        expect(check.lines.join('\n')).not.toContain('UI CONTRACT');
        expect((await runGen(copy.path, false, [grown])).exitCode).toBe(0);
        expect(readFileSync(join(copy.path, dir, 'home.get.json'), 'utf8')).toContain('"hint"');
        expect((await runGen(copy.path, true, [grown])).exitCode).toBe(0);
      } finally {
        copy.cleanup();
      }
    });
  });

  it('AC-08-03 hand-editing a file under packages/schemas/records/ fails cc:gen --check', async () => {
    const copy = copyRepo();
    try {
      expect((await runGen(copy.path, true)).exitCode).toBe(0);
      const file = join(copy.path, RECORDS_DIR, 'workspace@1.json');
      writeFileSync(file, readFileSync(file, 'utf8').replace('"workspace@1"', '"workspace"'));
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(
        `DRIFT ${RECORDS_DIR}/workspace@1.json: changed (generated files are never edited by hand; change packages/schemas and run pnpm cc:gen)`,
      );
      // Without --check, cc:gen restores the generated file.
      expect((await runGen(copy.path, false)).exitCode).toBe(0);
      expect((await runGen(copy.path, true)).exitCode).toBe(0);
    } finally {
      copy.cleanup();
    }
  });

  it('AC-08-03 a hand-added or deleted file under packages/schemas/records/ fails cc:gen --check', async () => {
    const copy = copyRepo();
    try {
      writeFileSync(join(copy.path, RECORDS_DIR, 'extra@1.json'), '{}\n');
      const extra = await runGen(copy.path, true);
      expect(extra.exitCode).toBe(1);
      expect(extra.lines[0]).toMatch(/^DRIFT packages\/schemas\/records\/extra@1\.json: extra/);
      await runGen(copy.path, false);
      rmSync(join(copy.path, RECORDS_DIR, 'workspace@1.json'));
      const missing = await runGen(copy.path, true);
      expect(missing.exitCode).toBe(1);
      expect(missing.lines[0]).toMatch(
        /^DRIFT packages\/schemas\/records\/workspace@1\.json: missing/,
      );
    } finally {
      copy.cleanup();
    }
  });

  it('generates one JSON Schema per record type, marked as generated', async () => {
    const files = await recordSchemas.generate(root);
    expect(files.map((file) => file.path)).toEqual(
      recordTypes.map((record) => `${RECORDS_DIR}/${record.type}@${record.major}.json`),
    );
    const schema = JSON.parse(files[0]?.content ?? '{}') as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$comment']).toMatch(/^Generated by pnpm cc:gen from packages\/schemas\/src/);
    expect(schema['required']).toContain('selfPersonId');
  });

  it('AC-08-03 hand-editing a file under packages/schemas/api/ fails cc:gen --check', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, API_DIR, 'items.claim.json');
      writeFileSync(file, readFileSync(file, 'utf8').replace('"items.claim"', '"items.claimed"'));
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe(
        `DRIFT ${API_DIR}/items.claim.json: changed (generated files are never edited by hand; change packages/schemas and run pnpm cc:gen)`,
      );
    } finally {
      copy.cleanup();
    }
  });

  it('C-07-06 generates the MCP tools/list payload within 12 KB; hand-editing it fails cc:gen --check', async () => {
    const [file] = await mcpTools.generate(root);
    expect(file?.path).toBe(`${MCP_DIR}/tools.json`);
    const document = JSON.parse(file?.content ?? '{}') as { $comment: string; tools: unknown };
    expect(document.tools).toEqual(mcpToolList());
    expect(document.$comment).toMatch(
      /^Generated by pnpm cc:gen from packages\/schemas\/src\/mcp\/tools\.ts/,
    );
    expect(mcpToolsBytes()).toBeLessThanOrEqual(MCP_TOOLS_BUDGET_BYTES);
    const copy = copyRepo();
    try {
      const path = join(copy.path, MCP_DIR, 'tools.json');
      writeFileSync(path, readFileSync(path, 'utf8').replace('"cc_home"', '"cc_start"'));
      const result = await runGen(copy.path, true, [mcpTools]);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toMatch(new RegExp(`^DRIFT ${MCP_DIR}/tools\\.json: changed`));
    } finally {
      copy.cleanup();
    }
  });

  it('generates one JSON Schema per API method, with params and result', async () => {
    const files = await apiSchemas.generate(root);
    expect(files.map((file) => file.path)).toEqual(
      apiMethods.map((definition) => `${API_DIR}/${definition.method}.json`),
    );
    for (const file of files) {
      const schema = JSON.parse(file.content) as Record<string, unknown>;
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['$comment']).toMatch(/^Generated by pnpm cc:gen from packages\/schemas\/src/);
      expect(schema['required']).toEqual(['params', 'result']);
      expect(() => compileJsonSchema(schema), file.path).not.toThrow();
    }
    const drop = JSON.parse(
      files.find((file) => file.path.endsWith('/items.drop.json'))?.content ?? '{}',
    ) as Record<string, unknown>;
    expect(drop['description']).toMatch(/Human-only \(04 §4\.3\)\.$/);
  });

  it('validates fixtures and fails on an invalid one', async () => {
    expect(validateFixtures(root).every((fixture) => fixture.issues.length === 0)).toBe(true);
    const copy = copyRepo();
    try {
      const dir = join(copy.path, 'fixtures', 'records', 'workspace@1');
      const valid = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8')) as object;
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...valid, id: 'ws_wrong' }));
      mkdirSync(join(copy.path, 'fixtures', 'records', 'unknown@1'));
      writeFileSync(join(copy.path, 'fixtures', 'records', 'unknown@1', 'x.json'), '{}');
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(
        'INVALID fixtures/records/unknown@1/x.json: no record type unknown@1 in @cc/schemas',
      );
      expect(
        result.lines.some((line) =>
          line.startsWith('INVALID fixtures/records/workspace@1/bad.json: id:'),
        ),
      ).toBe(true);
    } finally {
      copy.cleanup();
    }
  });

  it('generates the framework file schemas and the catalogue from the YAML files (01 §4)', async () => {
    const schemas = await frameworkSchemas.generate(root);
    expect(schemas.map((file) => file.path)).toEqual([
      `${FRAMEWORK_SCHEMAS_DIR}/framework_template@1.json`,
      `${FRAMEWORK_SCHEMAS_DIR}/pack@1.json`,
      `${FRAMEWORK_SCHEMAS_DIR}/agenda_template@1.json`,
      `${FRAMEWORK_SCHEMAS_DIR}/onboarding_profile@1.json`,
    ]);
    for (const file of schemas) {
      expect(() => compileJsonSchema(JSON.parse(file.content) as object), file.path).not.toThrow();
    }
    const [catalogue] = await frameworkCatalogue.generate(root);
    expect(catalogue?.path).toBe(`${CATALOGUE_DIR}/catalogue.ts`);
    expect(catalogue?.content).toMatch(/^\/\*\*\n \* Generated by pnpm cc:gen/);
  });

  it('AC-08-03 hand-editing the generated framework catalogue fails cc:gen --check', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, CATALOGUE_DIR, 'catalogue.ts');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace("key: 'priorityCount'", "key: 'rockCount'"),
      );
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe(
        `DRIFT ${CATALOGUE_DIR}/catalogue.ts: changed (generated files are never edited by hand; change packages/schemas and run pnpm cc:gen)`,
      );
    } finally {
      copy.cleanup();
    }
  });

  it('C-01-03 a template YAML that breaks the template checks fails cc:gen and stays out of the catalogue', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, TEMPLATES_DIR, 'eos-lite', '1.0.0.yaml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('validator: scorecardSize', 'validator: noSuchCheck'),
      );
      writeFileSync(
        join(copy.path, TEMPLATES_DIR, '4dx', '2.0.0.yaml'),
        readFileSync(join(copy.path, TEMPLATES_DIR, '4dx', '1.0.0.yaml'), 'utf8'),
      );
      const result = await runGen(copy.path, false);
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(
        `INVALID ${TEMPLATES_DIR}/eos-lite/1.0.0.yaml: invariant E-2: no validator noSuchCheck in packages/frameworks/validators`,
      );
      expect(result.lines).toContain(
        `INVALID ${TEMPLATES_DIR}/4dx/2.0.0.yaml: 4dx 1.0.0 belongs at ${TEMPLATES_DIR}/4dx/1.0.0.yaml`,
      );
      const catalogue = readFileSync(join(copy.path, CATALOGUE_DIR, 'catalogue.ts'), 'utf8');
      expect(catalogue).not.toContain('"eos-lite"');
    } finally {
      copy.cleanup();
    }
  });

  it('validates the onboarding fixtures as OnboardingProfiles (01 §4)', async () => {
    const copy = copyRepo();
    try {
      const file = join(copy.path, ONBOARDING_FIXTURES_DIR, 'scenario.json');
      const profile = JSON.parse(readFileSync(file, 'utf8')) as { workstreams: { kind: string }[] };
      const [first] = profile.workstreams;
      if (first !== undefined) first.kind = 'workspace';
      writeFileSync(file, JSON.stringify(profile));
      const result = await runGen(copy.path, true);
      expect(result.exitCode).toBe(1);
      expect(
        result.lines.some((line) =>
          line.startsWith(`INVALID ${ONBOARDING_FIXTURES_DIR}/scenario.json: workstreams.0.kind:`),
        ),
      ).toBe(true);
    } finally {
      copy.cleanup();
    }
  });
});
