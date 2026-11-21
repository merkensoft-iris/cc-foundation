/**
 * pnpm cc:gen [--check]: generates files from packages/schemas and validates fixtures (08 §6).
 *
 * Each entry of `recordTypes` in @cc/schemas becomes packages/schemas/records/<type>@<major>.json,
 * each entry of `apiMethods` becomes packages/schemas/api/<method>.json, each entry of
 * `frameworkFileTypes` becomes packages/schemas/frameworks/<type>@<major>.json, the `cc-axi`
 * command catalogue becomes apps/cli/reference/cc-axi.md, the product skill
 * skills/command-center/SKILL.md (07 §8), and the MCP tools become
 * packages/schemas/mcp/tools.json (07 §7; over 12 KB fails), the methods marked `ui` become
 * main's `window.cc` allowlist apps/desktop/src/main/generated/ui-methods.ts (ADR 0003
 * decision 9), the typed client of `@cc/ui-sdk` packages/ui-sdk/src/generated/methods.ts and
 * the UI contract of the current extension API packages/ui-sdk/contract/v<N>/ (ADR 0008
 * decision 1). The contract is also a guard: a method marked `ui` whose params or result
 * changed incompatibly since the contract was recorded (scripts/ui-contract.ts) fails, with or
 * without --check, and the recorded contract is kept, until EXTENSION_API_CURRENT is bumped.
 * The framework
 * templates and packs (packages/frameworks/templates/<id>/<version>.yaml and
 * packs/<id>/<version>.yaml, 01 §4) are checked with @cc/frameworks and compiled into
 * packages/frameworks/src/generated/catalogue.ts; the onboarding fixtures
 * (fixtures/onboarding/*.json) are validated as OnboardingProfiles. Every fixture in
 * fixtures/records/<type>@<major>/*.json, the 03 §13 worked examples among them (AC-03-06), is
 * validated twice: against the zod source and against the generated JSON Schema. With --check
 * nothing is written: any difference between the generated output and the files on disk (a
 * changed, missing or extra file) is drift and fails (C-08-03, AC-08-03).
 *
 * Exit codes follow 08 §6: 0 success or no drift, 1 drift or an invalid fixture, 2 usage error.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import * as prettier from 'prettier';
import { parse as parseYaml } from 'yaml';

import { renderReference, renderSkill, SKILL_NAME } from '@cc/cli';
import { checkPack, checkTemplate, templateDir } from '@cc/frameworks';
import {
  apiMethods,
  EXTENSION_API_CURRENT,
  fileTypeJsonSchema,
  frameworkFileTypes,
  MCP_SERVER_NAME,
  MCP_TOOLS_BUDGET_BYTES,
  mcpToolList,
  methodJsonSchema,
  methods,
  OnboardingProfile,
  recordJsonSchema,
  recordTypes,
  uiMethodJsonSchemas,
  validateRecord,
  type ApiMethod,
  type FrameworkTemplate,
  type Pack,
  type RecordType,
} from '@cc/schemas';

import {
  contractBreaks,
  withoutAnnotations,
  type ContractDocument,
  type ContractMethod,
  type SchemaNode,
} from './ui-contract.ts';

/** One generated file; `path` is relative to the repository root, with `/` separators. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * One kind of generated output. `dir` is owned by the generator: every file in it must be one
 * the generator produced, so a hand-added file is drift too.
 */
export interface Generator {
  readonly name: string;
  readonly dir: string;
  generate(root: string): Promise<GeneratedFile[]>;
  /** What makes this output fail even when it is written: a broken guard. */
  problems?(root: string): Promise<string[]>;
}

export const RECORDS_DIR = 'packages/schemas/records';
export const API_DIR = 'packages/schemas/api';
export const RECORD_FIXTURES_DIR = 'fixtures/records';
export const FRAMEWORK_SCHEMAS_DIR = 'packages/schemas/frameworks';
export const TEMPLATES_DIR = 'packages/frameworks/templates';
export const PACKS_DIR = 'packages/frameworks/packs';
export const CATALOGUE_DIR = 'packages/frameworks/src/generated';
export const ONBOARDING_FIXTURES_DIR = 'fixtures/onboarding';
export const CLI_REFERENCE_DIR = 'apps/cli/reference';
export const SKILL_DIR = `skills/${SKILL_NAME}`;
export const MCP_DIR = 'packages/schemas/mcp';
export const UI_METHODS_DIR = 'apps/desktop/src/main/generated';
export const UI_CLIENT_DIR = 'packages/ui-sdk/src/generated';
export const UI_CONTRACT_DIR = 'packages/ui-sdk/contract';

export function recordFileName(record: Pick<RecordType, 'type' | 'major'>): string {
  return `${record.type}@${record.major}.json`;
}

async function formatted(root: string, path: string, text: string): Promise<string> {
  const filepath = join(root, path);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...options, filepath });
}

/** Record JSON Schemas (08 §4.1 `records/<type>@<major>.json`). */
export const recordSchemas: Generator = {
  name: 'record JSON Schemas',
  dir: RECORDS_DIR,
  async generate(root) {
    const files: GeneratedFile[] = [];
    for (const record of recordTypes) {
      const path = `${RECORDS_DIR}/${recordFileName(record)}`;
      const { $schema, ...rest } = recordJsonSchema(record);
      const document = {
        $schema,
        $comment: `Generated by pnpm cc:gen from ${record.source} (${record.spec}). Do not edit by hand: change the source and run pnpm cc:gen.`,
        title: `${record.type}@${record.major}`,
        ...rest,
      };
      files.push({ path, content: await formatted(root, path, JSON.stringify(document)) });
    }
    return files;
  },
};

/** Local API method schemas (04 §4.1): `api/<method>.json`, params and result side by side. */
export const apiSchemas: Generator = {
  name: 'API method schemas',
  dir: API_DIR,
  async generate(root) {
    const files: GeneratedFile[] = [];
    for (const definition of apiMethods) {
      const path = `${API_DIR}/${methodFileName(definition)}`;
      const { $schema, ...rest } = methodJsonSchema(definition);
      const document = {
        $schema,
        $comment: `Generated by pnpm cc:gen from packages/schemas/src/api/methods.ts (${definition.spec}). Do not edit by hand: change the source and run pnpm cc:gen.`,
        title: definition.method,
        ...rest,
      };
      files.push({ path, content: await formatted(root, path, JSON.stringify(document)) });
    }
    return files;
  },
};

export function methodFileName(definition: Pick<ApiMethod, 'method'>): string {
  return `${definition.method}.json`;
}

/** Framework file schemas (01 §4): framework templates, packs and the onboarding profile. */
export const frameworkSchemas: Generator = {
  name: 'framework file schemas',
  dir: FRAMEWORK_SCHEMAS_DIR,
  async generate(root) {
    const files: GeneratedFile[] = [];
    for (const fileType of frameworkFileTypes) {
      const path = `${FRAMEWORK_SCHEMAS_DIR}/${fileType.type}@${fileType.major}.json`;
      const { $schema, ...rest } = fileTypeJsonSchema(fileType);
      const document = {
        $schema,
        $comment: `Generated by pnpm cc:gen from ${fileType.source} (${fileType.spec}). Do not edit by hand: change the source and run pnpm cc:gen.`,
        title: `${fileType.type}@${fileType.major}`,
        ...rest,
      };
      files.push({ path, content: await formatted(root, path, JSON.stringify(document)) });
    }
    return files;
  },
};

/** One framework YAML file: where it is, what it holds, and what is wrong with it. */
export interface FrameworkFile {
  readonly path: string;
  readonly kind: 'template' | 'pack';
  readonly value: unknown;
  readonly issues: readonly string[];
}

function yamlFiles(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => `${dir}/${file}`);
}

/**
 * Reads and checks every template and pack YAML file: the schema and the rules of
 * @cc/frameworks (registered validators, bounds), and that the file sits at
 * <id>/<version>.yaml (a custom: template at custom/<name>/<version>.yaml).
 */
export function readFrameworkFiles(root: string): FrameworkFile[] {
  const files: FrameworkFile[] = [];
  for (const [kind, dir] of [
    ['template', TEMPLATES_DIR],
    ['pack', PACKS_DIR],
  ] as const) {
    for (const path of yamlFiles(root, dir)) {
      let value: unknown;
      try {
        value = parseYaml(readFileSync(join(root, path), 'utf8'));
      } catch (error) {
        files.push({
          path,
          kind,
          value: undefined,
          issues: [`not YAML: ${(error as Error).message}`],
        });
        continue;
      }
      const issues: string[] = kind === 'template' ? checkTemplate(value) : checkPack(value);
      if (issues.length === 0) {
        const { id, version } = value as { id: FrameworkTemplate['id']; version: string };
        const expected = `${dir}/${kind === 'template' ? templateDir(id) : id}/${version}.yaml`;
        if (path !== expected) issues.push(`${id} ${version} belongs at ${expected}`);
      }
      files.push({ path, kind, value, issues });
    }
  }
  return files;
}

/** The built catalogue: every valid template and pack, compiled into one TypeScript module. */
export const frameworkCatalogue: Generator = {
  name: 'framework catalogue',
  dir: CATALOGUE_DIR,
  async generate(root) {
    const valid = readFrameworkFiles(root).filter((file) => file.issues.length === 0);
    const templates = valid.filter((file) => file.kind === 'template').map((file) => file.value);
    const packs = valid.filter((file) => file.kind === 'pack').map((file) => file.value);
    const path = `${CATALOGUE_DIR}/catalogue.ts`;
    const text = [
      '/**',
      ` * Generated by pnpm cc:gen from ${TEMPLATES_DIR}/ and ${PACKS_DIR}/ (01 §4). Do not edit`,
      ' * by hand: change the YAML files and run pnpm cc:gen.',
      ' */',
      "import type { FrameworkTemplate, Pack } from '@cc/schemas';",
      '',
      `export const TEMPLATES: readonly FrameworkTemplate[] = ${JSON.stringify(templates as FrameworkTemplate[])};`,
      '',
      `export const PACKS: readonly Pack[] = ${JSON.stringify(packs as Pack[])};`,
      '',
    ].join('\n');
    return [{ path, content: await formatted(root, path, text) }];
  },
};

/** The `cc-axi` command reference (07 §4), from the command catalogue in apps/cli/src/spec.ts. */
export const cliReference: Generator = {
  name: 'CLI reference',
  dir: CLI_REFERENCE_DIR,
  async generate(root) {
    const path = `${CLI_REFERENCE_DIR}/cc-axi.md`;
    return [{ path, content: await formatted(root, path, renderReference()) }];
  },
};

/** The size of the `tools/list` payload as the relay sends it: compact JSON, in bytes. */
export function mcpToolsBytes(): number {
  return Buffer.byteLength(JSON.stringify({ tools: mcpToolList() }), 'utf8');
}

/**
 * The MCP tool definitions (07 §7, C-07-06): the `tools/list` payload `cc-axi mcp` serves, from
 * packages/schemas/src/mcp/tools.ts. `runGen` fails when it is over the 12 KB budget.
 */
export const mcpTools: Generator = {
  name: 'MCP tool definitions',
  dir: MCP_DIR,
  async generate(root) {
    const path = `${MCP_DIR}/tools.json`;
    const document = {
      $comment: `Generated by pnpm cc:gen from packages/schemas/src/mcp/tools.ts (07 §7): the tools/list result of the ${MCP_SERVER_NAME} MCP server, ${String(mcpToolsBytes())} of ${String(MCP_TOOLS_BUDGET_BYTES)} bytes. Do not edit by hand: change the source and run pnpm cc:gen.`,
      tools: mcpToolList(),
    };
    return [{ path, content: await formatted(root, path, JSON.stringify(document)) }];
  },
};

/**
 * Main's `window.cc` method allowlist (ADR 0003 decision 9): the methods marked `ui` in
 * packages/schemas/src/api/methods.ts, and the methods only an agent may call, which main
 * refuses with E_FORBIDDEN rather than E_METHOD.
 */
export const uiMethodAllowlist: Generator = {
  name: 'window.cc method allowlist',
  dir: UI_METHODS_DIR,
  async generate(root) {
    const path = `${UI_METHODS_DIR}/ui-methods.ts`;
    const names = (ui: boolean): string[] =>
      apiMethods
        .filter((definition) => definition.ui === ui)
        .map((definition) => definition.method)
        .sort();
    const text = [
      '/**',
      ' * Generated by pnpm cc:gen from packages/schemas/src/api/methods.ts (ADR 0003 decision 9).',
      ' * Do not edit by hand: mark a method `ui` in the source and run pnpm cc:gen.',
      ' */',
      '',
      '/** The methods the app window may call through `window.cc.invoke`. */',
      `export const UI_METHODS: ReadonlySet<string> = new Set(${JSON.stringify(names(true))});`,
      '',
      '/** Methods of the local API that only an agent calls; main refuses them to the window. */',
      `export const AGENT_ONLY_METHODS: ReadonlySet<string> = new Set(${JSON.stringify(names(false))});`,
      '',
    ].join('\n');
    return [{ path, content: await formatted(root, path, text) }];
  },
};

/**
 * The typed client of `@cc/ui-sdk` (ADR 0008 decision 1): for each method marked `ui`, what the
 * app window sends and what it reads back, as the types of its @cc/schemas definition, so no
 * UI hand-copies a result type.
 */
export const uiClientTypes: Generator = {
  name: 'UI client types',
  dir: UI_CLIENT_DIR,
  async generate(root) {
    const path = `${UI_CLIENT_DIR}/methods.ts`;
    const exportName = new Map<unknown, string>(
      Object.entries(methods)
        .filter(([, value]) => apiMethods.includes(value as ApiMethod))
        .map(([name, value]) => [value, name]),
    );
    const entries = apiMethods
      .filter((definition) => definition.ui)
      .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
      .map((definition) => {
        const name = exportName.get(definition);
        if (name === undefined) {
          throw new Error(
            `${definition.method} is not exported from packages/schemas/src/api/methods.ts`,
          );
        }
        const params =
          definition.uiParams === undefined
            ? `typeof methods.${name}.params`
            : `NonNullable<typeof methods.${name}.uiParams>`;
        return [
          `  /** ${definition.description.replaceAll('*/', '* /')} */`,
          `  readonly '${definition.method}': {`,
          `    readonly params: z.input<${params}>;`,
          `    readonly result: z.output<typeof methods.${name}.result>;`,
          '  };',
        ].join('\n');
      });
    const text = [
      '/**',
      ' * Generated by pnpm cc:gen from the methods marked `ui` in packages/schemas/src/api/methods.ts',
      ' * (ADR 0008 decision 1). Do not edit by hand: change the source and run pnpm cc:gen.',
      ' */',
      "import type { methods } from '@cc/schemas';",
      "import type { z } from 'zod';",
      '',
      '/**',
      ' * The local API methods the app window may call through `window.cc.invoke`: what it sends',
      " * (`params`, the schema's input) and what it reads back (`result`, the schema's output).",
      ' */',
      'export interface UiMethods {',
      ...entries,
      '}',
      '',
    ].join('\n');
    return [{ path, content: await formatted(root, path, text) }];
  },
};

export function uiContractDir(apiVersion: number): string {
  return `${UI_CONTRACT_DIR}/v${String(apiVersion)}`;
}

/** The UI contract of `list` now, as `pnpm cc:gen` records it. */
export function uiContractDocument(
  list: readonly ApiMethod[],
  apiVersion: number,
): ContractDocument {
  const entries = list
    .filter((definition) => definition.ui)
    .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
    .map((definition): [string, ContractMethod] => {
      const { params, result } = uiMethodJsonSchemas(definition);
      return [
        definition.method,
        {
          params: withoutAnnotations(params) as SchemaNode,
          result: withoutAnnotations(result) as SchemaNode,
        },
      ];
    });
  return { apiVersion, methods: Object.fromEntries(entries) };
}

/** The contract recorded in packages/ui-sdk/contract/v<N>/, one file per method. */
function readContract(root: string, apiVersion: number): ContractDocument | undefined {
  const files = listFiles(root, uiContractDir(apiVersion)).filter((path) => path.endsWith('.json'));
  if (files.length === 0) return undefined;
  const recorded: Record<string, ContractMethod> = {};
  for (const path of files) {
    try {
      const value = JSON.parse(readText(root, path) ?? '') as Partial<ContractMethod> & {
        method?: unknown;
      };
      if (typeof value.method !== 'string' || value.params === undefined) continue;
      if (value.result === undefined) continue;
      recorded[value.method] = { params: value.params, result: value.result };
    } catch {
      // Not JSON: cc:gen rewrites it, and --check reports it as drift.
    }
  }
  return { apiVersion, methods: recorded };
}

/**
 * The UI contract of extension API `apiVersion` (ADR 0008 decision 1): the JSON Schemas of
 * every method marked `ui`, as the window sees them, one file per method in
 * packages/ui-sdk/contract/v<N>/. It follows the schemas while they change compatibly. An
 * incompatible change is a problem, and the recorded contract is kept as it is, until the
 * version is bumped; a bump records the new version beside the old one, which stays for API
 * N−1 (08 §4.3).
 */
export function uiContractGenerator(
  list: readonly ApiMethod[] = apiMethods,
  apiVersion: number = EXTENSION_API_CURRENT,
): Generator {
  const dir = uiContractDir(apiVersion);
  const breaks = (root: string): string[] => {
    const recorded = readContract(root, apiVersion);
    return recorded === undefined
      ? []
      : contractBreaks(recorded, uiContractDocument(list, apiVersion));
  };
  return {
    name: 'UI contract',
    dir,
    async generate(root) {
      if (breaks(root).length > 0) {
        return listFiles(root, dir).map((path) => ({ path, content: readText(root, path) ?? '' }));
      }
      const files: GeneratedFile[] = [];
      for (const [method, schemas] of Object.entries(
        uiContractDocument(list, apiVersion).methods,
      )) {
        const path = `${dir}/${method}.json`;
        const document = {
          $comment: `Generated by pnpm cc:gen from packages/schemas/src/api/methods.ts (ADR 0008 decision 1): ${method} in the UI contract of extension API ${String(apiVersion)}, as the app window sends and reads it. Within the version it changes only compatibly (scripts/ui-contract.ts), or pnpm cc:gen fails. Do not edit by hand.`,
          method,
          ...schemas,
        };
        files.push({ path, content: await formatted(root, path, JSON.stringify(document)) });
      }
      return files;
    },
    async problems(root) {
      const found = breaks(root);
      if (found.length === 0) return [];
      return [
        ...found.map((problem) => `UI CONTRACT ${dir}: ${problem}`),
        `UI CONTRACT ${dir}: ${String(found.length)} incompatible change(s) to methods marked ui within extension API ${String(apiVersion)}. Make the change compatible (a result only gains optional fields; params keep accepting what they accepted), or bump EXTENSION_API_CURRENT and ship the codemod (ADR 0003 decision 6, ADR 0008 decision 1).`,
      ];
    },
  };
}

export const uiContract: Generator = uiContractGenerator();

/**
 * The product skill for users' agents (07 §8 item 3, C-07-06), from the help text of `cc-axi`
 * with no live data. `npx skills add <org>/cc-foundation --skill command-center` installs it.
 */
export const productSkill: Generator = {
  name: 'product skill',
  dir: SKILL_DIR,
  async generate(root) {
    const path = `${SKILL_DIR}/SKILL.md`;
    return [{ path, content: await formatted(root, path, renderSkill()) }];
  },
};

/**
 * Every generator `pnpm cc:gen` runs. Extension points, each a new Generator here with its
 * own output directory and its source in packages/schemas, added by the build step whose
 * spec defines its input (09 §6.1):
 * - the cc.config schema (08 §4.3; P1-16, P1-18)
 * - AI tool definitions (04 §6; P3-01)
 */
export const generators: readonly Generator[] = [
  recordSchemas,
  apiSchemas,
  frameworkSchemas,
  frameworkCatalogue,
  cliReference,
  productSkill,
  mcpTools,
  uiMethodAllowlist,
  uiClientTypes,
  uiContract,
];

function listFiles(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function readText(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

export interface Drift {
  readonly path: string;
  readonly kind: 'changed' | 'missing' | 'extra';
}

/** Compares generated files with the files on disk under each generator's directory. */
export function findDrift(
  root: string,
  dirs: readonly string[],
  files: readonly GeneratedFile[],
): Drift[] {
  const drift: Drift[] = [];
  const expected = new Set(files.map((file) => file.path));
  for (const file of files) {
    const actual = readText(root, file.path);
    if (actual === undefined) drift.push({ path: file.path, kind: 'missing' });
    else if (actual !== file.content) drift.push({ path: file.path, kind: 'changed' });
  }
  for (const dir of dirs) {
    for (const path of listFiles(root, dir)) {
      if (!expected.has(path)) drift.push({ path, kind: 'extra' });
    }
  }
  return drift;
}

/** Writes generated files and removes files the generators no longer produce. */
export function writeGenerated(
  root: string,
  dirs: readonly string[],
  files: readonly GeneratedFile[],
): Drift[] {
  const drift = findDrift(root, dirs, files);
  for (const item of drift) {
    if (item.kind === 'extra') {
      rmSync(join(root, item.path));
      continue;
    }
    const file = files.find((candidate) => candidate.path === item.path);
    if (file === undefined) continue;
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  return drift;
}

export interface FixtureResult {
  readonly path: string;
  readonly issues: readonly string[];
}

/** A validator for one generated JSON Schema; returns the issues, empty when valid. */
export type JsonSchemaValidator = (value: unknown) => string[];

/**
 * Compiles a generated JSON Schema (draft 2020-12). Formats are not asserted: every
 * `format` the generator writes comes with a `pattern` that carries the same rule.
 */
export function compileJsonSchema(schema: object): JsonSchemaValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
    // Validators run once per fixture; optimising the generated code costs more than it saves.
    code: { optimize: false },
  });
  const validate = ajv.compile(schema);
  return (value) => {
    if (validate(value)) return [];
    const issues = (validate.errors ?? []).map(
      (error) =>
        `${error.instancePath === '' ? '(root)' : error.instancePath.slice(1).replaceAll('/', '.')}: ${error.message ?? 'invalid'} (JSON Schema)`,
    );
    return [...new Set(issues)];
  };
}

/**
 * Validates every fixture under fixtures/records/<type>@<major>/ against its record type: the
 * zod source and, when given, the generated JSON Schema of that file name. A directory that
 * names no registered record type is itself an error.
 */
export function validateFixtures(
  root: string,
  records: readonly RecordType[] = recordTypes,
  jsonSchemas: ReadonlyMap<string, JsonSchemaValidator> = new Map(),
): FixtureResult[] {
  const results: FixtureResult[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(join(root, RECORD_FIXTURES_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return results;
  }
  for (const dir of dirs) {
    const record = records.find((candidate) => recordFileName(candidate) === `${dir}.json`);
    const files = listFiles(root, `${RECORD_FIXTURES_DIR}/${dir}`);
    for (const path of files) {
      if (record === undefined) {
        results.push({ path, issues: [`no record type ${dir} in @cc/schemas`] });
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(root, path), 'utf8'));
      } catch (error) {
        results.push({ path, issues: [`not JSON: ${(error as Error).message}`] });
        continue;
      }
      const jsonSchema = jsonSchemas.get(recordFileName(record));
      const issues = validateRecord(record, value);
      if (jsonSchema !== undefined) issues.push(...jsonSchema(value));
      results.push({ path, issues });
    }
  }
  return results;
}

/** Validates every fixtures/onboarding/*.json as an OnboardingProfile (01 §4). */
export function validateOnboardingFixtures(root: string): FixtureResult[] {
  return listFiles(root, ONBOARDING_FIXTURES_DIR)
    .filter((path) => path.endsWith('.json'))
    .map((path) => {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(root, path), 'utf8'));
      } catch (error) {
        return { path, issues: [`not JSON: ${(error as Error).message}`] };
      }
      const result = OnboardingProfile.safeParse(value);
      return {
        path,
        issues: result.success
          ? []
          : result.error.issues.map(
              (issue) =>
                `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
            ),
      };
    });
}

export interface GenResult {
  readonly exitCode: 0 | 1;
  readonly lines: string[];
}

export async function runGen(
  root: string,
  check: boolean,
  selected: readonly Generator[] = generators,
): Promise<GenResult> {
  const lines: string[] = [];
  const files: GeneratedFile[] = [];
  for (const generator of selected) files.push(...(await generator.generate(root)));
  const dirs = selected.map((generator) => generator.dir);
  const drift = check ? findDrift(root, dirs, files) : writeGenerated(root, dirs, files);
  // The generated record schemas must compile under strict draft 2020-12; they then validate
  // the record fixtures. (The API method schemas are compiled in scripts/test/gen.test.ts.)
  const jsonSchemas = new Map<string, JsonSchemaValidator>();
  const uncompiled: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith(`${RECORDS_DIR}/`)) continue;
    try {
      const validator = compileJsonSchema(JSON.parse(file.content) as object);
      jsonSchemas.set(file.path.slice(RECORDS_DIR.length + 1), validator);
    } catch (error) {
      uncompiled.push(`SCHEMA ${file.path}: does not compile: ${(error as Error).message}`);
    }
  }
  const fixtures = [
    ...validateFixtures(root, recordTypes, jsonSchemas),
    ...readFrameworkFiles(root).map(({ path, issues }) => ({ path, issues })),
    ...validateOnboardingFixtures(root),
  ];
  const invalid = fixtures.filter((fixture) => fixture.issues.length > 0);
  // Guards on the generated output, such as the UI contract's stability (ADR 0008).
  for (const generator of selected) {
    if (generator.problems !== undefined) uncompiled.push(...(await generator.problems(root)));
  }
  // The tools/list payload stays within its budget (07 §7, checked in CI).
  if (selected.includes(mcpTools) && mcpToolsBytes() > MCP_TOOLS_BUDGET_BYTES) {
    uncompiled.push(
      `BUDGET ${MCP_DIR}/tools.json: tools/list is ${String(mcpToolsBytes())} bytes, over ${String(MCP_TOOLS_BUDGET_BYTES)} (07 §7)`,
    );
  }

  for (const item of drift) {
    lines.push(
      check
        ? `DRIFT ${item.path}: ${item.kind} (generated files are never edited by hand; change packages/schemas and run pnpm cc:gen)`
        : `${item.kind === 'extra' ? 'removed' : 'wrote'} ${item.path}`,
    );
  }
  lines.push(...uncompiled);
  for (const fixture of invalid) {
    for (const issue of fixture.issues) lines.push(`INVALID ${fixture.path}: ${issue}`);
  }
  const fixtureSummary = `${fixtures.length - invalid.length} of ${fixtures.length} fixture(s) valid`;
  if (check) {
    lines.push(
      drift.length === 0
        ? `cc:gen --check: no drift in ${files.length} generated file(s); ${fixtureSummary}.`
        : `cc:gen --check: ${drift.length} file(s) drifted; ${fixtureSummary}.`,
    );
  } else {
    lines.push(
      `cc:gen: ${files.length} generated file(s), ${drift.length} changed; ${fixtureSummary}.`,
    );
  }
  const failed = (check && drift.length > 0) || invalid.length > 0 || uncompiled.length > 0;
  return { exitCode: failed ? 1 : 0, lines };
}

async function main(args: readonly string[]): Promise<number> {
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 1 || (args.length === 1 && !check)) {
    console.error('usage: pnpm cc:gen [--check]');
    return 2;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await runGen(root, check);
  for (const line of result.lines) console.log(line);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
