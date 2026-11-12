/**
 * pnpm cc:new-template --id <id> [--from <id>@<version>] [--pack]: scaffolds a framework
 * template or pack (08 §6; 01 §4, §9).
 *
 * - `--id <catalogue id>`: a new template from templates/framework-template, written to
 *   packages/frameworks/templates/<id>/1.0.0.yaml, with a validator stub
 *   (packages/frameworks/validators/<id>.ts) and recommender test cases
 *   (packages/frameworks/test/<id>.test.ts). A template ID is one of the catalogue IDs of
 *   01 §4 (eos, okr and scaling-up are not built yet) or custom:<name>.
 * - `--id custom:<name> --from <id>[@<version>]`: a fork (01 §9 level 5) of a built template,
 *   written to packages/frameworks/templates/custom/<name>/1.0.0.yaml, with test cases. A
 *   custom: template is always a fork.
 * - `--id pack.<name> --pack [--from <pack>[@<version>]]`: a new pack, empty or copied,
 *   written to packages/frameworks/packs/<id>/1.0.0.yaml, with test cases.
 *
 * It never overwrites a file. Run pnpm cc:gen afterwards to check the files and compile the
 * catalogue. Exit codes follow 08 §6: 0 written, 1 a file exists or the source is unknown,
 * 2 usage error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { stringify } from 'yaml';

import {
  findPack,
  findTemplate,
  forkTemplate,
  FrameworkError,
  templateDir,
  type ForkOptions,
} from '@cc/frameworks';
import { CATALOGUE_TEMPLATE_IDS, CUSTOM_NAME, type FrameworkId } from '@cc/schemas';

export const USAGE = 'usage: pnpm cc:new-template --id <id> [--from <id>@<version>] [--pack]';
export const SCAFFOLD_DIR = 'templates/framework-template';
const FRAMEWORKS = 'packages/frameworks';

export interface NewTemplateOptions {
  readonly id: string;
  readonly from?: { readonly id: string; readonly version?: string };
  readonly pack: boolean;
}

export interface NewTemplateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: string[];
}

export function parseArgs(args: readonly string[]): NewTemplateOptions | undefined {
  let id: string | undefined;
  let from: NewTemplateOptions['from'];
  let pack = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--pack' && !pack) {
      pack = true;
    } else if (arg === '--id' && value !== undefined && id === undefined) {
      id = value;
      i++;
    } else if (arg === '--from' && value !== undefined && from === undefined) {
      const [sourceId = '', version] = value.split('@');
      if (sourceId === '' || (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version))) {
        return undefined;
      }
      from = version === undefined ? { id: sourceId } : { id: sourceId, version };
      i++;
    } else {
      return undefined;
    }
  }
  if (id === undefined) return undefined;
  return from === undefined ? { id, pack } : { id, from, pack };
}

/** A camelCase identifier from an ID: "scaling-up" → "scalingUp". */
export function camel(id: string): string {
  return id
    .replace(/^custom:/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join('');
}

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

async function format(root: string, path: string, text: string): Promise<string> {
  const filepath = join(root, path);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...options, filepath });
}

/** The files to write, path relative to root → content; or a usage or source error. */
async function plan(
  root: string,
  options: NewTemplateOptions,
): Promise<{ files: [string, string][] } | NewTemplateResult> {
  const scaffold = (name: string) => readFileSync(join(root, SCAFFOLD_DIR, name), 'utf8');
  const usage = (message: string): NewTemplateResult => ({
    exitCode: 2,
    lines: [`cc:new-template: ${message}`, USAGE],
  });
  const testPath = (id: string) => `${FRAMEWORKS}/test/${id.replace(':', '-')}.test.ts`;
  const testFile = async (id: string): Promise<[string, string]> => {
    const path = testPath(id);
    return [path, await format(root, path, fill(scaffold('test.ts.tmpl'), { id }))];
  };

  if (options.pack) {
    if (!/^pack\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.id)) {
      return usage(`a pack ID is pack.<name>, such as pack.sales, not "${options.id}"`);
    }
    const path = `${FRAMEWORKS}/packs/${options.id}/1.0.0.yaml`;
    let text: string;
    if (options.from !== undefined) {
      const source = findPack(options.from.id, options.from.version);
      if (source === undefined) {
        return {
          exitCode: 1,
          lines: [`cc:new-template: no pack ${options.from.id} in the catalogue`],
        };
      }
      const copy = { ...structuredClone(source), id: options.id, version: '1.0.0' };
      text = `# ${options.id} 1.0.0, copied from ${source.id} ${source.version} (01 §5.5).\n${stringify(copy)}`;
    } else {
      text = fill(scaffold('pack.yaml.tmpl'), { id: options.id, name: options.id.slice(5) });
    }
    return { files: [[path, await format(root, path, text)], await testFile(options.id)] };
  }

  const isCustom = options.id.startsWith('custom:');
  if (isCustom) {
    const name = options.id.slice('custom:'.length);
    if (!CUSTOM_NAME.test(name)) {
      return usage(
        `a custom template is custom:<name> with a lower-case slug name, not "${options.id}"`,
      );
    }
    if (options.from === undefined) {
      return usage('a custom: template is a fork: name its source with --from <id>@<version>');
    }
    const source = findTemplate(options.from.id as FrameworkId, options.from.version);
    if (source === undefined) {
      const version = options.from.version === undefined ? '' : ` ${options.from.version}`;
      return {
        exitCode: 1,
        lines: [`cc:new-template: no template ${options.from.id}${version} in the catalogue`],
      };
    }
    const forkOptions: ForkOptions = { name };
    const fork = forkTemplate(source, forkOptions);
    const path = `${FRAMEWORKS}/templates/${templateDir(fork.id)}/${fork.version}.yaml`;
    const text =
      `# ${fork.id} ${fork.version}: custom (based on ${source.id} ${source.version}) (01 §9 level 5).\n` +
      `# Invariants are editable here: remove the ones this fork does not keep.\n${stringify(fork)}`;
    return { files: [[path, await format(root, path, text)], await testFile(fork.id)] };
  }

  if (options.from !== undefined) {
    return usage('--from makes a fork, whose ID is custom:<name>');
  }
  if (!(CATALOGUE_TEMPLATE_IDS as readonly string[]).includes(options.id)) {
    return usage(
      `a template ID is one of ${CATALOGUE_TEMPLATE_IDS.join(', ')} (01 §4) or custom:<name>, not "${options.id}"`,
    );
  }
  if (findTemplate(options.id as FrameworkId) !== undefined) {
    return {
      exitCode: 1,
      lines: [`cc:new-template: ${options.id} is already built; change its YAML file instead`],
    };
  }
  const validator = `${camel(options.id)}Placeholder`;
  const values = { id: options.id, name: options.id, validator };
  const yamlPath = `${FRAMEWORKS}/templates/${options.id}/1.0.0.yaml`;
  const validatorPath = `${FRAMEWORKS}/validators/${options.id}.ts`;
  return {
    files: [
      [yamlPath, await format(root, yamlPath, fill(scaffold('template.yaml.tmpl'), values))],
      [
        validatorPath,
        await format(root, validatorPath, fill(scaffold('validator.ts.tmpl'), values)),
      ],
      await testFile(options.id),
    ],
  };
}

export async function runNewTemplate(
  root: string,
  options: NewTemplateOptions,
): Promise<NewTemplateResult> {
  let planned: Awaited<ReturnType<typeof plan>>;
  try {
    planned = await plan(root, options);
  } catch (error) {
    if (error instanceof FrameworkError) {
      return {
        exitCode: error.code === 'E_USAGE' ? 2 : 1,
        lines: [`cc:new-template: ${error.message}`],
      };
    }
    throw error;
  }
  if (!('files' in planned)) return planned;
  const existing = planned.files.filter(([path]) => existsSync(join(root, path)));
  if (existing.length > 0) {
    return {
      exitCode: 1,
      lines: existing.map(([path]) => `cc:new-template: ${path} exists; nothing was written`),
    };
  }
  const lines: string[] = [];
  for (const [path, content] of planned.files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    lines.push(`wrote ${path}`);
  }
  if (planned.files.some(([path]) => path.includes('/validators/'))) {
    lines.push(
      `next: register ${camel(options.id)}Placeholder in ${FRAMEWORKS}/validators/index.ts, cite each invariant and bound, then run pnpm cc:gen`,
    );
  } else {
    lines.push('next: edit the YAML file, then run pnpm cc:gen');
  }
  return { exitCode: 0, lines };
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(USAGE);
    return 2;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await runNewTemplate(root, options);
  for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
