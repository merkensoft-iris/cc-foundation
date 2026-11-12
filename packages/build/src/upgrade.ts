/**
 * `pnpm cc:upgrade [--to <version>] [--check]` (08 §6, 08 §4.3, ADR 0003 decision 6, owner
 * decision D-1, 10 Nov 2026).
 *
 * Runs the foundation's codemods from the engine's `extensionApi` to the installed
 * foundation's API, one step at a time, then the engine's type-check. The user runs it
 * locally after merging a foundation dependency PR; the engine's CI runs `--check` on that
 * PR, which writes nothing and lists the planned edits.
 *
 * Exit codes (08 §6, ADR 0003 decision 6):
 * - 0: the engine is on the current API and no site is marked for a person; or the upgrade
 *   was written and the type-check passed with no site left for a person.
 * - 1: `--check` found an upgrade due; or a site needs a person; or the type-check failed;
 *   or the engine's API cannot be upgraded by this foundation.
 * - 2: usage error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { IndentationText, Node, Project, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph';

import type { CommandResult } from './build.js';
import { TODO_MARKER, type Codemod, type CodemodContext } from './codemod.js';
import { CODEMODS } from './codemods/index.js';
import { CONFIG_FILE, readExtensionApi } from './engine-config.js';
import { currentFoundation, type Foundation } from './foundation.js';
import { engineTypecheck, type Typecheck } from './typecheck.js';

export interface UpgradeOptions {
  readonly root: string;
  readonly check?: boolean;
  /** The foundation version the user means to upgrade to; must be the installed one. */
  readonly to?: string;
  readonly foundation?: Foundation;
  readonly codemods?: readonly Codemod[];
  readonly typecheck?: Typecheck;
}

/** The engine's code the codemods see. */
export const ENGINE_CODE_GLOBS = [CONFIG_FILE, 'ui/**/*.{ts,tsx,mts,cts}', 'theme/**/*.ts'];

interface Todo {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const posix = (path: string) => path.split(sep).join('/');

function loadProject(root: string): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Single,
      indentationText: IndentationText.TwoSpaces,
    },
  });
  project.addSourceFilesAtPaths([
    ...ENGINE_CODE_GLOBS.map((glob) => posix(join(root, glob))),
    `!${posix(join(root, '**/node_modules/**'))}`,
  ]);
  return project;
}

/** Every `cc:upgrade TODO` marker left in the engine's code. */
function markersLeft(root: string, project: Project): Todo[] {
  const left: Todo[] = [];
  for (const file of project.getSourceFiles()) {
    file
      .getFullText()
      .split('\n')
      .forEach((text, index) => {
        const at = text.indexOf(TODO_MARKER);
        if (at >= 0) {
          left.push({
            file: posix(relative(root, file.getFilePath())),
            line: index + 1,
            message: text.slice(at).replace(/\s*\*\/.*$/, ''),
          });
        }
      });
  }
  return left;
}

function setExtensionApi(file: SourceFile, api: number): boolean {
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName().replace(/['"]/g, '') !== 'extensionApi') continue;
    const initializer = property.getInitializer();
    if (initializer?.getKind() !== SyntaxKind.NumericLiteral) return false;
    initializer.replaceWithText(String(api));
    return true;
  }
  return false;
}

export async function runUpgrade(options: UpgradeOptions): Promise<CommandResult> {
  const root = resolve(options.root);
  const name = options.check === true ? 'cc-upgrade --check' : 'cc-upgrade';
  const foundation = options.foundation ?? currentFoundation();
  const codemods = options.codemods ?? CODEMODS;
  const fail = (message: string): CommandResult => ({
    exitCode: 1,
    lines: [`${name}: ${message}`],
  });

  if (options.to !== undefined && options.to !== foundation.version) {
    return fail(
      `the installed foundation is ${foundation.version}, not ${options.to}; install the @cc/* ${options.to} pins first (merge and pull the dependency PR, then pnpm install)`,
    );
  }
  const configPath = join(root, CONFIG_FILE);
  if (!existsSync(configPath)) return fail(`no ${CONFIG_FILE} in ${root}`);
  const declared = readExtensionApi(readFileSync(configPath, 'utf8'));
  if ('error' in declared) return fail(declared.error);
  const from = declared.api;

  if (from > foundation.api) {
    return fail(
      `engine is on API ${from}, newer than foundation ${foundation.version} (API ${foundation.api}); set extensionApi to ${foundation.api} or install a newer foundation`,
    );
  }
  const project = loadProject(root);
  if (from === foundation.api) {
    const left = markersLeft(root, project);
    if (left.length > 0) {
      return {
        exitCode: 1,
        lines: [
          `${name}: engine on extension API ${from} (foundation ${foundation.version}); ${left.length} ${left.length === 1 ? 'site needs' : 'sites need'} a person`,
          ...left.map((todo) => `  ${todo.file}:${todo.line} ${todo.message}`),
        ],
      };
    }
    return {
      exitCode: 0,
      lines: [
        `${name}: ok  engine already on extension API ${from} (foundation ${foundation.version}); nothing to do`,
      ],
    };
  }

  // The chain of steps, from the engine's API to the foundation's.
  const steps: Codemod[] = [];
  for (let api = from; api < foundation.api; api += 1) {
    const step = codemods.find((codemod) => codemod.from === api);
    if (step === undefined) {
      return fail(
        `foundation ${foundation.version} has no codemod from API ${api} to ${api + 1}; upgrade one foundation major at a time (supported: ${foundation.supported.join(', ')})`,
      );
    }
    steps.push(step);
  }

  const started = performance.now();
  const edits = new Map<string, number>();
  const todos: Todo[] = [];
  const json = new Map<string, unknown>();
  const config = project.getSourceFile(configPath) ?? project.addSourceFileAtPath(configPath);
  for (const step of steps) {
    const pending: { node: Node; message: string; to: number }[] = [];
    const context: CodemodContext = {
      root,
      project,
      readJson: (path) => {
        if (json.has(path)) return structuredClone(json.get(path));
        const full = join(root, path);
        return existsSync(full) ? (JSON.parse(readFileSync(full, 'utf8')) as unknown) : undefined;
      },
      writeJson: (path, value) => json.set(path, structuredClone(value)),
      edit: (file, count = 1) => edits.set(file, (edits.get(file) ?? 0) + count),
      todo: (node, message) => pending.push({ node, message, to: step.from + 1 }),
    };
    await step.run(context);
    // Mark the sites left for a person, last first so earlier positions stay valid.
    const marks = pending.map((item) => {
      // The innermost statement holding the site, so the mark sits on the line above it.
      const statement =
        [item.node, ...item.node.getAncestors()].find((node) => Node.isStatement(node)) ??
        item.node;
      const file = item.node.getSourceFile();
      const pos = statement.getStart();
      const lineStart = file.getFullText().lastIndexOf('\n', pos - 1) + 1;
      const indent = /^[ \t]*/.exec(file.getFullText().slice(lineStart, pos))?.[0] ?? '';
      return { file, pos, indent, line: statement.getStartLineNumber(), ...item };
    });
    marks.sort((a, b) => b.pos - a.pos);
    for (const mark of marks) {
      const relativePath = posix(relative(root, mark.file.getFilePath()));
      mark.file.insertText(
        mark.pos,
        `/* ${TODO_MARKER}(API ${mark.to}): ${mark.message} */\n${mark.indent}`,
      );
      todos.push({ file: relativePath, line: mark.line, message: mark.message });
    }
    if (!setExtensionApi(config, step.from + 1))
      return fail(`${CONFIG_FILE}: extensionApi is not a literal integer`);
    edits.set(CONFIG_FILE, (edits.get(CONFIG_FILE) ?? 0) + 1);
  }
  todos.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const editCount = [...edits.values()].reduce((sum, count) => sum + count, 0);
  const summary = `${editCount} edits in ${edits.size} files`;
  const perFile = [...edits.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, count]) => `  ${file}: ${count} ${count === 1 ? 'edit' : 'edits'}`);
  const todoLines = todos.map(
    (todo) => `  needs a person: ${todo.file}:${todo.line} ${todo.message}`,
  );
  const ms = Math.round(performance.now() - started);

  if (options.check === true) {
    return {
      exitCode: 1,
      lines: [
        `${name}: engine on API ${from}, foundation ${foundation.version} is on API ${foundation.api}: ${summary} would be made, ${todos.length} need a person`,
        ...steps.map((step) => `  API ${step.from} -> ${step.from + 1}: ${step.title}`),
        ...perFile,
        ...todoLines,
        `  run pnpm cc:upgrade locally to apply them (owner decision D-1)`,
      ],
    };
  }

  await project.save();
  for (const [path, value] of json) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
  }
  const lines = [
    `${name}: API ${from} -> ${foundation.api}: ${summary} (${ms} ms)`,
    ...perFile,
    ...todoLines,
  ];
  const typecheck = await (options.typecheck ?? engineTypecheck)(root);
  if (!typecheck.ok) {
    return {
      exitCode: 1,
      lines: [...lines, `${name}: type-check failed (${typecheck.ms} ms)`, typecheck.output],
    };
  }
  lines.push(`${name}: type-check passed (${typecheck.ms} ms)`);
  if (todos.length > 0) {
    return {
      exitCode: 1,
      lines: [
        ...lines,
        `${name}: ${todos.length} ${todos.length === 1 ? 'site needs' : 'sites need'} a person; see the marks above`,
      ],
    };
  }
  return { exitCode: 0, lines };
}
