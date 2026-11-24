/**
 * Ejected screens (ADR 0008 decision 1; 08 §6 `cc:eject`, `cc:ui-update`, `cc:upgrade --check`):
 * an engine that wants to change a default screen beyond what `createApp(overrides)` and a
 * stylesheet allow takes a copy of it, and the copy is tracked against its upstream.
 *
 * - `cc-eject <screen>` copies the screen's source from the installed `@cc/ui` into the engine's
 *   `ui/`, at the same path it has under `@cc/ui`'s `src/` (`screens/home.ts` becomes
 *   `ui/screens/home.ts`), with the modules only that screen uses (`screens/settings-*.ts`,
 *   `screens/onboarding/*`). An import of the default UI's own modules (`../app/screen.js`,
 *   `../ui/parts.js`) becomes the versioned entry point `@cc/ui/v<N>`, which exports them, so the
 *   copy passes the D3 check. It records the screen in `ui/.cc-ui.json`: the `@cc/ui` version,
 *   the extension API and the sha256 of each upstream file. The upstream text itself is kept
 *   under `ui/.cc-ui/base/` (`<path>.base`, which no tool compiles) as the base of the next merge.
 * - `uiDrift` compares each ejected screen with the installed `@cc/ui`, for `cc-upgrade --check`:
 *   which files changed upstream, by how many lines, whether the copy changed too, and whether
 *   `cc-ui-update` would merge them cleanly. It writes nothing.
 * - `cc-ui-update [<screen>...]` does the 3-way merge (`merge3.ts`) of each changed file: the
 *   base is the recorded upstream, ours the engine's copy, theirs the new upstream. A copy the
 *   engine never changed takes the new upstream as it is. Conflicts are written with git's
 *   markers and the command exits 1 until a person resolves them; `cc-upgrade` lists any marker
 *   left in an ejected file.
 *
 * The engine owns the copy (ADR 0008): nothing here changes a file the manifest does not list,
 * and nothing reaches the network.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { sha256 } from '@cc/build-runtime';
import { ts } from 'ts-morph';

import type { CommandResult } from './build.js';
import { currentFoundation, type Foundation } from './foundation.js';
import { conflictLines, lineChanges, merge3 } from './merge3.js';

/** The default UI package an engine ejects screens from. */
export const DEFAULT_UI_PACKAGE = '@cc/ui';
/** The manifest of ejected screens, in the engine. */
export const UI_MANIFEST = 'ui/.cc-ui.json';
/** Where the upstream text of each ejected file is kept, as the base of the next merge. */
export const UI_BASE_DIR = 'ui/.cc-ui/base';

const MANIFEST_NOTE =
  'Screens ejected from @cc/ui: written by cc:eject and cc:ui-update, read by cc:upgrade --check. Do not edit.';

export interface EjectedScreen {
  /** The `@cc/ui` version the copy was taken or last merged from. */
  readonly version: string;
  /** The extension API its imports were written for (`@cc/ui/v<N>`). */
  readonly api: number;
  /** Each file, by its path under `ui/`, with the sha256 of its upstream text. */
  readonly files: Readonly<Record<string, string>>;
}

export interface UiManifest {
  readonly screens: Readonly<Record<string, EjectedScreen>>;
}

/** The installed default UI. */
export interface DefaultUi {
  readonly dir: string;
  readonly version: string;
}

const SCREENS_DIR = 'screens';

/** The installed `@cc/ui`, found as Node finds a package: in `node_modules` up from the engine. */
export function findDefaultUi(root: string): DefaultUi | { readonly error: string } {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...DEFAULT_UI_PACKAGE.split('/'));
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)) {
      const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
      if (!existsSync(join(candidate, 'src', SCREENS_DIR))) {
        return {
          error: `${DEFAULT_UI_PACKAGE} in ${candidate} has no screen sources (src/screens); install a release that ships them`,
        };
      }
      return { dir: candidate, version: typeof version === 'string' ? version : 'unknown' };
    }
    if (dirname(dir) === dir) break;
  }
  return {
    error: `${DEFAULT_UI_PACKAGE} is not installed in the engine; add it to the dependencies (ui/app.ts composes it) and run pnpm install`,
  };
}

const sourcePath = (ui: DefaultUi, path: string) => join(ui.dir, 'src', ...path.split('/'));

/** The default screens of the installed `@cc/ui`: `src/screens/<name>.ts` exporting `<name>Screen`. */
export function defaultScreens(ui: DefaultUi): string[] {
  return readdirSync(join(ui.dir, 'src', SCREENS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-z][a-z0-9]*\.ts$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -3))
    .filter((name) =>
      new RegExp(`^export const ${name}Screen\\b`, 'm').test(
        readFileSync(sourcePath(ui, `${SCREENS_DIR}/${name}.ts`), 'utf8'),
      ),
    )
    .sort();
}

interface Specifier {
  readonly text: string;
  /** Where the specifier's text starts and ends, inside its quotes. */
  readonly start: number;
  readonly end: number;
}

/** The module specifiers of a file's import and export declarations. */
function specifiers(path: string, text: string): Specifier[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: Specifier[] = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const literal = statement.moduleSpecifier;
      found.push({
        text: literal.text,
        start: literal.getStart(file) + 1,
        end: literal.getEnd() - 1,
      });
    }
  }
  return found;
}

/** The `src/`-relative file a relative specifier of `from` names (`./x.js` is `x.ts`). */
function resolveRelative(from: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.js$/, '.ts');
}

const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');

/**
 * A screen's files: `screens/<name>.ts` and the modules under `screens/` it imports, by their
 * `src/`-relative path, with their upstream text.
 */
export function screenSources(ui: DefaultUi, name: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = [`${SCREENS_DIR}/${name}.ts`];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (files.has(path)) continue;
    const text = readFileSync(sourcePath(ui, path), 'utf8');
    files.set(path, text);
    for (const specifier of specifiers(path, text)) {
      if (!isRelative(specifier.text)) continue;
      const target = resolveRelative(path, specifier.text);
      if (target.startsWith(`${SCREENS_DIR}/`) && existsSync(sourcePath(ui, target))) {
        queue.push(target);
      }
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The text an ejected file has in the engine: every relative import of a module outside the
 * screen's own files becomes `@cc/ui/v<api>`, the entry point that exports it.
 */
export function ejectedText(
  path: string,
  text: string,
  own: ReadonlySet<string>,
  api: number,
): string {
  let out = text;
  for (const specifier of specifiers(path, text).reverse()) {
    if (!isRelative(specifier.text) || own.has(resolveRelative(path, specifier.text))) continue;
    out = `${out.slice(0, specifier.start)}${DEFAULT_UI_PACKAGE}/v${String(api)}${out.slice(specifier.end)}`;
  }
  return out;
}

/** The engine path of an upstream file (`screens/home.ts` is `ui/screens/home.ts`). */
const enginePath = (path: string) => `ui/${path}`;
const basePath = (path: string) => `${UI_BASE_DIR}/${path}.base`;
const full = (root: string, path: string) => join(root, ...path.split('/'));

function readText(root: string, path: string): string | undefined {
  const file = full(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function writeText(root: string, path: string, text: string): void {
  mkdirSync(dirname(full(root, path)), { recursive: true });
  writeFileSync(full(root, path), text);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The engine's manifest; an empty one when there is none. */
export function readUiManifest(root: string): UiManifest | { readonly error: string } {
  const text = readText(root, UI_MANIFEST);
  if (text === undefined) return { screens: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${UI_MANIFEST} is not valid JSON` };
  }
  const screens = isRecord(parsed) ? parsed['screens'] : undefined;
  if (!isRecord(screens)) return { error: `${UI_MANIFEST} has no screens object` };
  for (const [name, entry] of Object.entries(screens)) {
    if (
      !isRecord(entry) ||
      typeof entry['version'] !== 'string' ||
      !Number.isInteger(entry['api']) ||
      !isRecord(entry['files']) ||
      !Object.values(entry['files']).every((hash) => typeof hash === 'string')
    ) {
      return { error: `${UI_MANIFEST}: screen ${name} needs a version, an api and files` };
    }
  }
  return { screens: screens as Record<string, EjectedScreen> };
}

function writeUiManifest(root: string, manifest: UiManifest): void {
  const screens = Object.fromEntries(
    Object.entries(manifest.screens)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => [
        name,
        {
          version: entry.version,
          api: entry.api,
          files: Object.fromEntries(
            Object.entries(entry.files).sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      ]),
  );
  writeText(
    root,
    UI_MANIFEST,
    `${JSON.stringify({ $comment: MANIFEST_NOTE, screens }, null, 2)}\n`,
  );
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

export interface EjectOptions {
  readonly root: string;
  readonly screen: string;
  readonly foundation?: Foundation;
}

/** `cc-eject <screen>`. */
export function runEject(options: EjectOptions): CommandResult {
  const { root, screen } = options;
  const api = (options.foundation ?? currentFoundation()).api;
  const fail = (...lines: string[]): CommandResult => ({
    exitCode: 1,
    lines: lines.map((line, index) => (index === 0 ? `cc-eject: ${line}` : line)),
  });
  const ui = findDefaultUi(root);
  if ('error' in ui) return fail(ui.error);
  const screens = defaultScreens(ui);
  if (!screens.includes(screen)) {
    return {
      exitCode: 2,
      lines: [
        `cc-eject: ${screen} is not a default screen of ${DEFAULT_UI_PACKAGE} ${ui.version} (screens: ${screens.join(', ')})`,
      ],
    };
  }
  const manifest = readUiManifest(root);
  if ('error' in manifest) return fail(manifest.error);
  const already = manifest.screens[screen];
  if (already !== undefined) {
    return fail(
      `${screen} is already ejected (from ${DEFAULT_UI_PACKAGE} ${already.version}); pnpm cc:ui-update merges upstream changes into it`,
    );
  }
  const sources = screenSources(ui, screen);
  const clashes = [...sources.keys()].filter((path) => existsSync(full(root, enginePath(path))));
  if (clashes.length > 0) {
    return fail(
      `${plural(clashes.length, 'file')} of ${screen} already ${clashes.length === 1 ? 'exists' : 'exist'} in the engine; move ${clashes.length === 1 ? 'it' : 'them'} away first`,
      ...clashes.map((path) => `  ${enginePath(path)}`),
    );
  }
  const own = new Set(sources.keys());
  const files: Record<string, string> = {};
  for (const [path, text] of sources) {
    writeText(root, enginePath(path), ejectedText(path, text, own, api));
    writeText(root, basePath(path), text);
    files[enginePath(path)] = sha256(text);
  }
  writeUiManifest(root, {
    screens: { ...manifest.screens, [screen]: { version: ui.version, api, files } },
  });
  const typesFromSchemas = [...sources]
    .filter(([path, text]) =>
      specifiers(path, text).some((specifier) => specifier.text === '@cc/schemas'),
    )
    .map(([path]) => enginePath(path));
  return {
    exitCode: 0,
    lines: [
      `cc-eject: ${screen} ejected from ${DEFAULT_UI_PACKAGE} ${ui.version} (${plural(sources.size, 'file')}); recorded in ${UI_MANIFEST}`,
      ...[...sources.keys()].map((path) => `  ${enginePath(path)}`),
      ...(typesFromSchemas.length > 0
        ? [
            `  ${typesFromSchemas.join(', ')} ${typesFromSchemas.length === 1 ? 'imports' : 'import'} types from @cc/schemas; the engine's type-check needs @cc/schemas in its devDependencies`,
          ]
        : []),
      `  use it in ui/app.ts: import { ${screen}Screen } from './screens/${screen}.js'; createApp({ screens: { ${screen}: ${screen}Screen } })`,
      '  pnpm cc:upgrade --check lists upstream changes to it; pnpm cc:ui-update merges them',
    ],
  };
}

/** One file of an ejected screen, compared with the installed upstream. */
interface FilePlan {
  /** Its path in the engine. */
  readonly path: string;
  /** The upstream path, under `@cc/ui`'s `src/`. */
  readonly source: string;
  readonly kind: 'changed' | 'added' | 'removed';
  /** The new upstream text, as the engine would have it (not for `removed`). */
  readonly theirs?: string;
  readonly theirsHash?: string;
  /** The engine's copy, undefined when it was deleted. */
  readonly ours: string | undefined;
  /** The recorded upstream text, as the engine had it; undefined when the base copy is missing. */
  readonly base: string | undefined;
}

interface ScreenPlan {
  readonly name: string;
  readonly entry: EjectedScreen;
  /** Undefined when the screen is no longer a default screen. */
  readonly sources: Map<string, string> | undefined;
  readonly files: readonly FilePlan[];
}

function planScreen(
  root: string,
  ui: DefaultUi,
  name: string,
  entry: EjectedScreen,
  api: number,
): ScreenPlan {
  const recordedSource = (path: string) => path.replace(/^ui\//, '');
  const baseOf = (path: string, own: ReadonlySet<string>): string | undefined => {
    const text = readText(root, basePath(recordedSource(path)));
    return text === undefined ? undefined : ejectedText(recordedSource(path), text, own, entry.api);
  };
  const recordedOwn = new Set(Object.keys(entry.files).map(recordedSource));
  if (!defaultScreens(ui).includes(name)) {
    return { name, entry, sources: undefined, files: [] };
  }
  const sources = screenSources(ui, name);
  const own = new Set(sources.keys());
  const files: FilePlan[] = [];
  for (const [source, text] of sources) {
    const path = enginePath(source);
    const recorded = entry.files[path];
    const theirsHash = sha256(text);
    if (recorded === theirsHash) continue;
    files.push({
      path,
      source,
      kind: recorded === undefined ? 'added' : 'changed',
      theirs: ejectedText(source, text, own, api),
      theirsHash,
      ours: readText(root, path),
      base: recorded === undefined ? '' : baseOf(path, recordedOwn),
    });
  }
  for (const path of Object.keys(entry.files)) {
    if (sources.has(recordedSource(path))) continue;
    files.push({
      path,
      source: recordedSource(path),
      kind: 'removed',
      ours: readText(root, path),
      base: baseOf(path, recordedOwn),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { name, entry, sources, files };
}

/** The merge `cc-ui-update` would make of one changed or added file. */
function mergeOf(plan: FilePlan, from: string, to: string): { text: string; conflicts: number } {
  const theirs = plan.theirs ?? '';
  const ours = plan.ours ?? '';
  const base = plan.base ?? '';
  if (ours === base) return { text: theirs, conflicts: 0 };
  return merge3(base, ours, theirs, {
    ours: `${plan.path} (yours)`,
    base: `${DEFAULT_UI_PACKAGE} ${from}`,
    theirs: `${DEFAULT_UI_PACKAGE} ${to}`,
  });
}

/** Markers of an unresolved merge left in the engine's ejected files. */
function markersLeft(root: string, manifest: UiManifest): string[] {
  const left: string[] = [];
  for (const entry of Object.values(manifest.screens)) {
    for (const path of Object.keys(entry.files)) {
      const text = readText(root, path);
      if (text === undefined) continue;
      for (const line of conflictLines(text)) {
        left.push(
          `  ${path}:${String(line)} has an unresolved merge from cc:ui-update; resolve it`,
        );
      }
    }
  }
  return left.sort();
}

export interface UiDrift {
  /** Ejected screens with upstream changes. */
  readonly changed: number;
  /** Lines describing them, and the markers of an unresolved merge. */
  readonly lines: readonly string[];
  /** Something needs a person: an unresolved merge, or the manifest cannot be read. */
  readonly problems: number;
}

/**
 * The upstream changes to the engine's ejected screens, against the installed `@cc/ui`
 * (`cc-upgrade --check`). Writes nothing.
 */
export function uiDrift(root: string, foundation: Foundation): UiDrift {
  const manifest = readUiManifest(root);
  if ('error' in manifest) return { changed: 0, lines: [`  ${manifest.error}`], problems: 1 };
  const names = Object.keys(manifest.screens).sort();
  if (names.length === 0) return { changed: 0, lines: [], problems: 0 };
  const ui = findDefaultUi(root);
  if ('error' in ui) return { changed: 0, lines: [`  ${ui.error}`], problems: 1 };
  const lines: string[] = [];
  let changed = 0;
  for (const name of names) {
    const entry = manifest.screens[name];
    if (entry === undefined) continue;
    const plan = planScreen(root, ui, name, entry, foundation.api);
    if (plan.sources === undefined) {
      changed += 1;
      lines.push(
        `  ejected screen ${name}: no longer a default screen of ${DEFAULT_UI_PACKAGE} ${ui.version}; pnpm cc:ui-update stops tracking it`,
      );
      continue;
    }
    if (plan.files.length === 0) continue;
    changed += 1;
    lines.push(
      `  ejected screen ${name} changed upstream (${DEFAULT_UI_PACKAGE} ${entry.version} -> ${ui.version}):`,
    );
    for (const file of plan.files) {
      if (file.kind === 'removed') {
        lines.push(`    ${file.path}: removed upstream; your copy stays`);
        continue;
      }
      const { added, removed } = lineChanges(file.base ?? '', file.theirs ?? '');
      const yours =
        file.ours === undefined
          ? file.kind === 'added'
            ? 'new here, so taken as it is'
            : 'deleted here, so not restored'
          : file.ours === file.base
            ? 'unchanged here, so taken as it is'
            : `changed here too, ${(() => {
                const { conflicts } = mergeOf(file, entry.version, ui.version);
                return conflicts === 0
                  ? 'merges cleanly'
                  : `merges with ${plural(conflicts, 'conflict')} for a person`;
              })()}`;
      const what = file.kind === 'added' ? 'added upstream' : 'changed upstream';
      lines.push(
        `    ${file.path}: ${what} (+${String(added)} -${String(removed)} lines); ${yours}${file.base === undefined ? ` (no base copy in ${UI_BASE_DIR})` : ''}`,
      );
    }
  }
  const left = markersLeft(root, manifest);
  return { changed, lines: [...lines, ...left], problems: left.length };
}

export interface UiUpdateOptions {
  readonly root: string;
  /** The screens to merge; every ejected screen when empty. */
  readonly screens?: readonly string[];
  readonly foundation?: Foundation;
}

/** `cc-ui-update [<screen>...]`: merges upstream changes into the ejected screens. */
export function runUiUpdate(options: UiUpdateOptions): CommandResult {
  const { root } = options;
  const api = (options.foundation ?? currentFoundation()).api;
  const name = 'cc-ui-update';
  const manifest = readUiManifest(root);
  if ('error' in manifest) return { exitCode: 1, lines: [`${name}: ${manifest.error}`] };
  const ejected = Object.keys(manifest.screens).sort();
  const asked = options.screens ?? [];
  const unknown = asked.filter((screen) => !ejected.includes(screen));
  if (unknown.length > 0) {
    return {
      exitCode: 2,
      lines: [
        `${name}: not ejected: ${unknown.join(', ')} (ejected: ${ejected.length === 0 ? 'none' : ejected.join(', ')})`,
      ],
    };
  }
  if (ejected.length === 0) {
    return {
      exitCode: 0,
      lines: [`${name}: ok  no screen is ejected (${UI_MANIFEST}); nothing to do`],
    };
  }
  const ui = findDefaultUi(root);
  if ('error' in ui) return { exitCode: 1, lines: [`${name}: ${ui.error}`] };

  const screens = { ...manifest.screens };
  const lines: string[] = [];
  let merged = 0;
  let conflicted = 0;
  let dirty = false;
  for (const screen of asked.length === 0 ? ejected : [...asked].sort()) {
    const entry = screens[screen];
    if (entry === undefined) continue;
    const plan = planScreen(root, ui, screen, entry, api);
    if (plan.sources === undefined) {
      dirty = true;
      delete screens[screen];
      for (const path of Object.keys(entry.files)) {
        rmSync(full(root, basePath(path.replace(/^ui\//, ''))), { force: true });
      }
      lines.push(
        `  ${screen}: no longer a default screen of ${DEFAULT_UI_PACKAGE} ${ui.version}; its copy is yours alone and no longer tracked`,
      );
      continue;
    }
    if (plan.files.length === 0) continue;
    dirty = true;
    lines.push(`  ${screen}: ${DEFAULT_UI_PACKAGE} ${entry.version} -> ${ui.version}`);
    const files: Record<string, string> = { ...entry.files };
    for (const file of plan.files) {
      if (file.kind === 'removed') {
        delete files[file.path];
        rmSync(full(root, basePath(file.source)), { force: true });
        lines.push(`    ${file.path}: removed upstream; your copy stays and is no longer tracked`);
        continue;
      }
      const upstream = plan.sources.get(file.source) ?? '';
      files[file.path] = file.theirsHash ?? sha256(upstream);
      writeText(root, basePath(file.source), upstream);
      if (file.ours === undefined && file.kind === 'changed') {
        lines.push(`    ${file.path}: deleted here; not restored`);
        continue;
      }
      const result =
        file.ours === undefined
          ? { text: file.theirs ?? '', conflicts: 0 }
          : mergeOf(file, entry.version, ui.version);
      writeText(root, file.path, result.text);
      if (result.conflicts > 0) {
        conflicted += 1;
        lines.push(
          `    ${file.path}: ${plural(result.conflicts, 'conflict')} at line ${conflictLines(result.text).join(', ')}; resolve the <<<<<<< marks`,
        );
      } else {
        merged += 1;
        lines.push(
          `    ${file.path}: ${file.kind === 'added' ? 'added' : file.ours === file.base ? 'updated (unchanged here)' : 'merged'}`,
        );
      }
    }
    screens[screen] = { version: ui.version, api, files };
  }
  if (dirty) writeUiManifest(root, { screens });
  const left = markersLeft(root, { screens });
  if (lines.length === 0 && left.length === 0) {
    return {
      exitCode: 0,
      lines: [
        `${name}: ok  ${plural(ejected.length, 'ejected screen')} match ${DEFAULT_UI_PACKAGE} ${ui.version}; nothing to do`,
      ],
    };
  }
  const summary = `${plural(merged, 'file')} merged, ${String(conflicted)} with conflicts`;
  if (left.length > 0) {
    return {
      exitCode: 1,
      lines: [
        `${name}: ${summary}; ${plural(left.length, 'conflict')} left for a person`,
        ...lines,
        ...left,
        '  resolve them, then run pnpm check',
      ],
    };
  }
  return { exitCode: 0, lines: [`${name}: ${summary}`, ...lines, '  run pnpm check'] };
}
