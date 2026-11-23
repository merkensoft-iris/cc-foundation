/**
 * The engine's UI (ADR 0008 decision 1; 08 §4.2 rule D3, §4.3 item 3): `cc-build` bundles the
 * composition root `ui/app.ts` with esbuild into `cc-ui/index.js` and `cc-ui/app.css` at the
 * packaged app's root, which main serves as `/ui/index.js` and `/ui/app.css`. An engine with
 * no `ui/app.ts` (an empty `ui/`) runs the default UI.
 *
 * The D3 check reads esbuild's metafile (ADR 0003 decision 8, extended by ADR 0008):
 *
 * - A file of the engine's `ui/` may import other files of `ui/`, the versioned entry points of
 *   the UI contract and the default UI (`@cc/ui-sdk/v<N>`, `@cc/ui/v<N>` and the default UI's
 *   stylesheet `@cc/ui/v<N>/app.css`, for each extension API `N` the foundation builds), and
 *   the UI libraries the engine names in `cc.config.ts`
 *   (`ui: { libraries: [...] }`, any subpath). `@cc/schemas` is types only (`import type`,
 *   which esbuild erases), and nothing else is allowed.
 * - A package file may import its own files and other packages (a UI library's own
 *   dependencies), except a foundation runtime package other than `@cc/ui-sdk` and `@cc/ui`.
 * - Nothing anywhere may import a Node built-in (`node:*`; esbuild resolves a bare `fs` only
 *   to an npm package, for the browser) or leave an import outside the bundle.
 *
 * The check walks the import graph from the entry and fails closed: every file esbuild put
 * into the bundle must be one it reached and checked. The window enforces the rest at run
 * time (the CSP, no network, the `window.cc` allowlist; 04 §10 rule 5).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ENGINE_UI_DIR, ENGINE_UI_SCRIPT, ENGINE_UI_STYLES } from '@cc/build-runtime';
import { build, type Message, type Metafile } from 'esbuild';

export { ENGINE_UI_DIR, ENGINE_UI_SCRIPT, ENGINE_UI_STYLES };

/** The composition root, in the order they are looked for. */
export const UI_ENTRIES = ['ui/app.ts', 'ui/app.tsx'] as const;

/** The packages a UI imports by versioned entry point only (ADR 0003 decision 2). */
export const UI_CONTRACT_PACKAGES = ['@cc/ui-sdk', '@cc/ui'] as const;

/** A versioned entry point: `@cc/ui-sdk/v<N>`, `@cc/ui/v<N>` or `@cc/ui/v<N>/app.css`. */
const VERSIONED_ENTRY = /^@cc\/(?:ui-sdk\/v(\d+)|ui\/v(\d+)(?:\/app\.css)?)$/;

/** An npm package name, optionally scoped. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export interface UiAllowlist {
  /** The extension API versions the foundation builds: `@cc/ui-sdk/v<N>`, `@cc/ui/v<N>`. */
  readonly supported: readonly number[];
  /** The UI libraries the engine names in `cc.config.ts` `ui.libraries`. */
  readonly libraries: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Problems with the `ui` setting of a loaded `cc.config.ts`; empty when it is valid. */
export function uiConfigProblems(config: Record<string, unknown>): string[] {
  const ui = config['ui'];
  if (ui === undefined) return [];
  if (!isRecord(ui)) return ['cc.config.ts: ui must be an object, such as { libraries: [] }'];
  const problems = Object.keys(ui)
    .filter((key) => key !== 'libraries')
    .map((key) => `cc.config.ts: ui.${key} is not a setting (the UI settings are: libraries)`);
  const libraries = ui['libraries'];
  if (libraries === undefined) return problems;
  if (!Array.isArray(libraries) || !libraries.every((name) => typeof name === 'string')) {
    return [...problems, 'cc.config.ts: ui.libraries must be a list of package names'];
  }
  for (const name of libraries as string[]) {
    if (!PACKAGE_NAME.test(name)) {
      problems.push(`cc.config.ts: ui.libraries: ${name} is not an npm package name`);
    } else if (name.startsWith('@cc/')) {
      problems.push(
        `cc.config.ts: ui.libraries: ${name} is a foundation package; a UI imports @cc/ui-sdk/v<N> and @cc/ui/v<N> without listing them, and nothing else of the foundation (D3)`,
      );
    }
  }
  return problems;
}

/** The UI libraries a valid config names. */
export function uiLibraries(config: unknown): readonly string[] {
  const ui = isRecord(config) ? config['ui'] : undefined;
  const libraries = isRecord(ui) ? ui['libraries'] : undefined;
  return Array.isArray(libraries) ? libraries.filter((name) => typeof name === 'string') : [];
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Why a file of the engine's `ui/` may not import `specifier`, or undefined when it may. */
export function engineImportProblem(specifier: string, allow: UiAllowlist): string | undefined {
  const name = packageOf(specifier);
  if ((UI_CONTRACT_PACKAGES as readonly string[]).includes(name)) {
    const match = VERSIONED_ENTRY.exec(specifier);
    const version = match?.[1] ?? match?.[2];
    if (version !== undefined && allow.supported.includes(Number(version))) return undefined;
    const entries = allow.supported
      .flatMap((n) =>
        name === '@cc/ui'
          ? [`${name}/v${String(n)}`, `${name}/v${String(n)}/app.css`]
          : [`${name}/v${String(n)}`],
      )
      .join(', ');
    return `${specifier} is not a versioned entry point this foundation builds (${entries})`;
  }
  if (allow.libraries.includes(name)) return undefined;
  if (name === '@cc/schemas') {
    return `${specifier} is imported at run time; import its types with \`import type\` (D3)`;
  }
  if (name.startsWith('@cc/')) {
    return `${specifier} is a foundation runtime package; the UI reaches the app only through window.cc (D3)`;
  }
  return `${specifier} is not on the UI import allowlist; name it in cc.config.ts ui.libraries if it is a UI library (D3)`;
}

type Owner = { readonly kind: 'engine' } | { readonly kind: 'package'; readonly name: string };

const ENGINE: Owner = { kind: 'engine' };

/** A bundled file of the engine's own `ui/`, as a metafile path (relative, forward slashes). */
function isEngineFile(path: string): boolean {
  return path.startsWith('ui/') && !path.split('/').includes('node_modules');
}

const isPathSpecifier = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier);

export interface UiCheck {
  readonly problems: readonly string[];
  /** The engine's own files in the bundle. */
  readonly engineFiles: readonly string[];
  /** Files from packages in the bundle. */
  readonly packageFiles: number;
}

/** The D3 check over esbuild's metafile, walking the import graph from `entry`. */
export function checkUiMetafile(metafile: Metafile, entry: string, allow: UiAllowlist): UiCheck {
  const problems: string[] = [];
  const owners = new Map<string, Owner>([[entry, ENGINE]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const owner = owners.get(file) ?? ENGINE;
    const input = metafile.inputs[file];
    if (input === undefined) {
      problems.push(`${file} is imported but not in the bundle's metafile`);
      continue;
    }
    for (const { path, original, external } of input.imports) {
      const specifier = original ?? path;
      const where = owner.kind === 'engine' ? file : `${file} (in ${owner.name})`;
      if (external === true) {
        problems.push(`${where} imports ${specifier}, which is left outside the bundle`);
        continue;
      }
      // A bare name such as `events` that esbuild resolved is the npm package of that name
      // (platform browser); `node:` always means Node's own.
      if (specifier.startsWith('node:')) {
        problems.push(
          `${where} imports the Node built-in ${specifier}; the window has no Node (D3)`,
        );
        continue;
      }
      let target: Owner;
      if (isPathSpecifier(specifier)) {
        if (owner.kind === 'engine' && !isEngineFile(path)) {
          problems.push(`${where} imports ${specifier}, a file outside ui/ (D3)`);
          continue;
        }
        target = owner;
      } else {
        const name = packageOf(specifier);
        const problem =
          owner.kind === 'engine'
            ? engineImportProblem(specifier, allow)
            : name.startsWith('@cc/') && !(UI_CONTRACT_PACKAGES as readonly string[]).includes(name)
              ? `${specifier} is a foundation runtime package (D3)`
              : undefined;
        if (problem !== undefined) {
          problems.push(`${where}: ${problem}`);
          continue;
        }
        target = { kind: 'package', name };
      }
      if (!owners.has(path)) {
        owners.set(path, target);
        queue.push(path);
      }
    }
  }
  // Fail closed: every bundled file must be one the walk reached and checked.
  const bundled = new Set([
    ...Object.keys(metafile.inputs),
    ...Object.values(metafile.outputs).flatMap((output) => Object.keys(output.inputs)),
  ]);
  const missed = [...bundled].filter((file) => !owners.has(file));
  if (missed.length > 0) {
    problems.push(
      `the D3 check reached ${String(bundled.size - missed.length)} of the ${String(bundled.size)} bundled files (not ${missed[0] ?? ''}); it fails closed`,
    );
  }
  const engineFiles = [...owners].filter(([, o]) => o.kind === 'engine').map(([f]) => f);
  return {
    problems,
    engineFiles: engineFiles.sort(),
    packageFiles: owners.size - engineFiles.length,
  };
}

export type UiBundle =
  /** No `ui/app.ts`: the app runs the default UI. */
  | { readonly kind: 'default'; readonly line: string }
  | {
      readonly kind: 'engine';
      readonly entry: string;
      /** `cc-ui/index.js` and `cc-ui/app.css`. */
      readonly script: string;
      readonly styles: string;
      readonly engineFiles: readonly string[];
      readonly line: string;
    }
  | { readonly kind: 'failed'; readonly problems: readonly string[] };

export interface BundleUiOptions extends UiAllowlist {
  /**
   * The files the build packs (git's view of the tree, ADR 0004 decision 4). Every file of
   * `ui/` in the bundle must be one of them, so an ignored file never reaches the app. Absent
   * for `cc-build check`, which packs nothing.
   */
  readonly packed?: ReadonlySet<string>;
}

/** Source files in the engine's `ui/` (its README and styles aside). */
function uiSourceFiles(root: string): string[] {
  const dir = join(root, 'ui');
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
        files.push(`ui/${relative(dir, path).split(sep).join('/')}`);
      }
    }
  };
  visit(dir);
  return files.sort();
}

function formatMessage(message: Message): string {
  const at = message.location;
  return at === null
    ? message.text
    : `${at.file}:${String(at.line)}:${String(at.column)}: ${message.text}`;
}

const kilobytes = (text: string): string => `${(Buffer.byteLength(text) / 1024).toFixed(1)} kB`;

/** Bundles and checks the engine's `ui/app.ts`, or says that the default UI runs. */
export async function bundleEngineUi(root: string, options: BundleUiOptions): Promise<UiBundle> {
  const entry = UI_ENTRIES.find((file) => existsSync(join(root, file)));
  if (entry === undefined) {
    const sources = uiSourceFiles(root);
    return {
      kind: 'default',
      line:
        sources.length === 0
          ? 'cc-build: ui/ has no app.ts; the app runs the default UI'
          : `cc-build: ui/ has ${String(sources.length)} source file(s) (${sources[0] ?? ''}) but no app.ts, the composition root; nothing in ui/ is built and the app runs the default UI`,
    };
  }
  const outdir = join(root, ENGINE_UI_DIR);
  let result;
  try {
    result = await build({
      absWorkingDir: root,
      entryPoints: { index: entry },
      outdir,
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      charset: 'utf8',
      logLevel: 'silent',
      // UI libraries read it to drop their development checks.
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  } catch (error) {
    const errors = (error as { errors?: Message[] }).errors;
    return {
      kind: 'failed',
      problems:
        errors === undefined || errors.length === 0
          ? [`${entry} did not bundle: ${error instanceof Error ? error.message : String(error)}`]
          : errors.map((message) => `${entry} did not bundle: ${formatMessage(message)}`),
    };
  }
  const check = checkUiMetafile(result.metafile, entry, options);
  const problems = [...check.problems];
  if (options.packed !== undefined) {
    for (const file of check.engineFiles) {
      if (!options.packed.has(file)) {
        problems.push(
          `${file} is ignored by git, and the build packs only git's view of the tree (ADR 0004 decision 4)`,
        );
      }
    }
  }
  let script: string | undefined;
  let styles = '';
  for (const output of result.outputFiles) {
    const name = relative(outdir, output.path).split(sep).join('/');
    if (name === ENGINE_UI_SCRIPT) script = output.text;
    else if (name === 'index.css') styles = output.text;
    else
      problems.push(
        `${entry} bundled to an unexpected file, ${name}; the UI is one script and one stylesheet`,
      );
  }
  if (script === undefined) problems.push(`${entry} bundled to no ${ENGINE_UI_SCRIPT}`);
  if (problems.length > 0 || script === undefined) {
    return { kind: 'failed', problems: problems.map((p) => `ui: ${p}`) };
  }
  return {
    kind: 'engine',
    entry,
    script,
    styles,
    engineFiles: check.engineFiles,
    line: `cc-build: ${entry} bundled (${String(check.engineFiles.length)} ui/ file(s), ${String(check.packageFiles)} package file(s); ${ENGINE_UI_SCRIPT} ${kilobytes(script)}, ${ENGINE_UI_STYLES} ${kilobytes(styles)}); the app runs the engine's UI`,
  };
}
