/**
 * `cc-build build`: the engine's `pnpm build` (04 §10 rule 1, 08 §6, ADR 0003 decision 7,
 * ADR 0004 decisions 1 and 4).
 *
 * 1. Checks `extensionApi` against the foundation (ADR 0003 decision 1) and loads
 *    `cc.config.ts` into JSON.
 * 2. Runs the engine's type-check.
 * 3. Inspects the tree and writes the build stamp: the commit, checkout, git path, lockfile
 *    hashes, install and whether the tree was clean.
 * 4. Packages git's view of the tree plus the generated files with electron-builder, with
 *    the asar and fuses of `builder-config.ts`.
 *
 * A dirty tree still builds (the user may be previewing a change), but its stamp says so and
 * the app then starts in developer mode. With `--rebuild-of <checkout>@<commit>` the build
 * runs in Rebuild now's copy of a commit (`rebuild.ts`): the copy is not a git checkout, so
 * the stamp names the user's checkout and commit, and the install is the copy's frozen one.
 *
 * The engine's `theme/tokens.json` is compiled to `cc-theme.css` in the app (`theme.ts`), which
 * the shell serves to the renderer.
 *
 * TODO(P1-18): bundle the engine's `ui/` widgets into the renderer once `@cc/ui-sdk/v1`
 * (`defineWidget`, `token`, the slot host) exists; it is a stub today and the renderer is
 * the shell's placeholder page (P1-11 brings the screens). Until then a widget file in `ui/`
 * is reported, not silently dropped.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  currentToolchain,
  findOnPath,
  gitViewFiles,
  hashLockfiles,
  inspectTree,
  installDrift,
  readInstallStamp,
  writeBuildStamp,
  type BuildInstall,
  type BuildStamp,
} from '@cc/build-runtime';

import { builderConfig, type BuilderConfigOptions } from './builder-config.js';
import {
  CONFIG_FILE,
  loadEngineConfig,
  readEngineExtensionApi,
  validateEngineConfig,
} from './engine-config.js';
import { currentFoundation, judgeExtensionApi, type Foundation } from './foundation.js';
import { THEME_CSS } from './theme.js';
import { engineTypecheck, type Typecheck } from './typecheck.js';

export interface CommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

export type Packager = (
  config: ReturnType<typeof builderConfig>,
  projectDir: string,
) => Promise<void>;

/** Packages with electron-builder, loaded only when a build actually packages. */
export const electronBuilderPackager: Packager = async (config, projectDir) => {
  const { build } = await import('electron-builder');
  await build({ projectDir, config });
};

export interface BuildOptions {
  /** The engine root: the checkout, or Rebuild now's copy. */
  readonly root: string;
  /** Output directory; default `dist` in the root. */
  readonly outDir?: string;
  /** False writes the stamp and stage only (`--no-package`), for CI on any OS and tests. */
  readonly package?: boolean;
  readonly installer?: boolean;
  /** Stop after the config and type-check (`cc-build check`, for the engine's CI). */
  readonly checkOnly?: boolean;
  /** Rebuild now: the user's checkout and the commit this copy holds. */
  readonly rebuildOf?: { readonly checkout: string; readonly commit: string };
  readonly foundation?: Foundation;
  /** Absolute path of git; default: found on PATH. */
  readonly git?: string | null;
  readonly typecheck?: Typecheck;
  readonly packager?: Packager;
  readonly now?: () => Date;
}

/** The stage directory: generated files added at the app root. */
export const STAGE_DIR = '.stage';

/** Source files in the engine's `ui/` (its README aside). */
function widgetFiles(root: string): string[] {
  const dir = join(root, 'ui');
  if (!existsSync(dir)) return [];
  return walkFiles(dir, join(dir, 'node_modules'))
    .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file))
    .map((file) => `ui/${file}`);
}

/** Every file under `root` except `.git`, `node_modules` and `skip`, as relative paths. */
function walkFiles(root: string, skip: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === skip || entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

export async function runBuild(options: BuildOptions): Promise<CommandResult> {
  const root = resolve(options.root);
  const lines: string[] = [];
  const fail = (message: string): CommandResult => ({
    exitCode: 1,
    lines: [...lines, `cc-build: ${message}`],
  });
  const foundation = options.foundation ?? currentFoundation();
  const outDir = resolve(root, options.outDir ?? 'dist');

  // 1. Extension API and config (ADR 0003 decisions 1 and 3).
  const declared = readEngineExtensionApi(root);
  if ('error' in declared) return fail(declared.error);
  const verdict = judgeExtensionApi(declared.api, foundation);
  if (verdict.kind === 'unsupported') return fail(verdict.message);
  if (verdict.kind === 'deprecated') lines.push(`cc-build: deprecated: ${verdict.message}`);
  let config: unknown;
  try {
    config = await loadEngineConfig(root);
  } catch (error) {
    return fail(
      `${CONFIG_FILE} did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const problems = validateEngineConfig(config, declared.api);
  const theme = foundation.theme?.(root) ?? null;
  if (theme !== null && !theme.ok) problems.push(...theme.problems);
  if (problems.length > 0)
    return { exitCode: 1, lines: [...lines, ...problems.map((p) => `cc-build: ${p}`)] };
  const widgets = widgetFiles(root);
  if (widgets.length > 0) {
    lines.push(
      `cc-build: ui/ has ${widgets.length} widget file(s) (${widgets[0] ?? ''}); widgets are not built into the app until @cc/ui-sdk/v1 ships (P1-18)`,
    );
  }

  // 2. Type-check (ADR 0003 decision 7).
  const typecheck = await (options.typecheck ?? engineTypecheck)(root);
  if (!typecheck.ok)
    return { exitCode: 1, lines: [...lines, 'cc-build: type-check failed', typecheck.output] };
  lines.push(`cc-build: type-check passed (${typecheck.ms} ms)`);
  if (options.checkOnly === true) {
    lines.push(
      `cc-build: ok  ${CONFIG_FILE} valid, extension API ${declared.api}, foundation ${foundation.version}`,
    );
    return { exitCode: 0, lines };
  }

  // 3. Tree inspection and the build stamp (ADR 0004 decisions 1 and 4).
  const insideOut = (file: string) => {
    const path = relative(outDir, join(root, file));
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  let stampFields: Pick<
    BuildStamp,
    'commit' | 'checkout' | 'git' | 'install' | 'clean' | 'dirtyReasons'
  >;
  let files: string[];
  if (options.rebuildOf !== undefined) {
    const git = options.git === undefined ? findOnPath('git') : options.git;
    const drift = installDrift(root);
    stampFields = {
      commit: options.rebuildOf.commit,
      checkout: resolve(options.rebuildOf.checkout),
      git,
      install: { kind: 'rebuild' },
      clean: drift === null,
      dirtyReasons: drift === null ? [] : [drift],
    };
    files = walkFiles(root, outDir);
  } else {
    const git = options.git === undefined ? findOnPath('git') : options.git;
    const tree = await inspectTree(root, git);
    const drift = installDrift(root);
    const dirty = [...tree.dirty, ...(drift === null ? [] : [drift])];
    const install: BuildInstall = {
      kind: 'checkout',
      digest: readInstallStamp(root)?.digest ?? null,
    };
    stampFields = {
      commit: tree.head,
      checkout: root,
      git,
      install,
      clean: dirty.length === 0,
      dirtyReasons: dirty,
    };
    files =
      git !== null && tree.layout !== null
        ? await gitViewFiles(git, tree.layout)
        : walkFiles(root, outDir);
    if (dirty.length > 0) {
      lines.push(
        `cc-build: the tree is not clean (${dirty[0] ?? ''}); this build will start in developer mode`,
      );
    }
  }
  files = files.filter((file) => !insideOut(file));

  const stamp: BuildStamp = {
    stampVersion: 1,
    ...stampFields,
    lockfiles: hashLockfiles(root),
    builtAt: (options.now ?? (() => new Date()))().toISOString(),
    foundation: foundation.version,
    extensionApi: declared.api,
    toolchain: currentToolchain(),
  };
  const stageDir = join(outDir, STAGE_DIR);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeBuildStamp(stageDir, stamp);
  writeFileSync(join(stageDir, 'cc.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  if (theme?.ok === true) writeFileSync(join(stageDir, THEME_CSS), theme.css);
  lines.push(
    `cc-build: stamp ${stamp.commit?.slice(0, 12) ?? 'no commit'}, ${stamp.clean ? 'clean' : 'not clean'}, ${files.length} engine files, foundation ${foundation.version}, extension API ${declared.api}`,
  );

  // 4. Package.
  if (options.package === false) {
    lines.push(`cc-build: ok (not packaged) ${relative(root, stageDir) || stageDir}`);
    return { exitCode: 0, lines };
  }
  const configOptions: BuilderConfigOptions = {
    projectDir: root,
    outDir,
    stageDir,
    files,
    ...(options.installer === undefined ? {} : { installer: options.installer }),
  };
  try {
    await (options.packager ?? electronBuilderPackager)(builderConfig(configOptions), root);
  } catch (error) {
    return fail(`packaging failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  lines.push(`cc-build: ok packaged into ${existsSync(outDir) ? outDir : 'nothing'}`);
  return { exitCode: 0, lines };
}
