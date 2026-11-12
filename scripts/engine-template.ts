/**
 * pnpm cc:engine-template (09 P1-16, AC-08-11): runs a fresh copy of the cc-engine template
 * on this checkout's `@cc/*` packages without a registry, so CI proves "clone, install,
 * build, start" on macOS, Windows and Linux before any release exists.
 *
 * 1. `pack --out <dir>`: `pnpm pack` every `@cc/*` package (built first, `pnpm build`) into
 *    `<dir>`, and write `<dir>/tarballs.json` naming each tarball.
 * 2. `pin --engine <dir> --tarballs <dir>`: in a scratch copy of the template, do what its
 *    `extension-api/README.md` "Pinning the foundation" says a release PR does, with the
 *    tarballs in place of a published version: pin `@cc/desktop` (the app) and `@cc/build`
 *    (the build tooling, a development dependency), point every other `@cc/*` package at its
 *    tarball (`overrides`), list the install scripts the foundation's dependencies bring
 *    (`ENGINE_ALLOW_BUILDS`; pnpm 12 fails an install with an unlisted one), and turn on the
 *    `build`, `upgrade` and `start` build flags.
 *
 * It only ever writes `<dir>` and the scratch copy; it never pushes, publishes or touches the
 * template repository. Exit codes follow 08 §6: 0 done, 1 failed, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseDocument } from 'yaml';

import { ccManifests } from './release.ts';

export const USAGE = [
  'usage: pnpm cc:engine-template pack --out <dir>',
  '       pnpm cc:engine-template pin --engine <dir> --tarballs <dir>',
].join('\n');

/** The engine pins these directly; every other @cc/* package comes in through them. */
export const ENGINE_PINS = {
  dependencies: ['@cc/desktop'],
  devDependencies: ['@cc/build'],
} as const;

/**
 * Install scripts of the foundation's dependencies, as an engine must list them in its
 * `pnpm-workspace.yaml` `allowBuilds` (the same choice as the foundation's own):
 * electron-winstaller comes with electron-builder for Squirrel.Windows, which CC does not use.
 */
export const ENGINE_ALLOW_BUILDS: Readonly<Record<string, boolean>> = {
  'electron-winstaller': false,
};

/** The build flags a release that ships the shell turns on (cc-engine tools/build-flags.ts). */
export const FLAGS_ON = ['build', 'upgrade', 'start'] as const;

export interface Result {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

/** `file:` spec for a tarball, with forward slashes so it reads the same on Windows. */
export function fileSpec(path: string): string {
  return `file:${resolve(path).split('\\').join('/')}`;
}

function pnpm(args: readonly string[], cwd: string): string {
  const execPath = process.env['npm_execpath'];
  const [command, prefix] =
    execPath !== undefined && /\.[cm]?js$/.test(execPath)
      ? [process.execPath, [execPath]]
      : [process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', []];
  return execFileSync(command, [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
}

export function pack(root: string, out: string): Result {
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const tarballs: Record<string, string> = {};
  for (const manifest of ccManifests(root)) {
    const pkgDir = join(manifest.path, '..');
    const before = new Set(readdirSync(dir));
    pnpm(['pack', '--pack-destination', dir], pkgDir);
    const made = readdirSync(dir).filter((file) => file.endsWith('.tgz') && !before.has(file));
    if (made.length !== 1) {
      return {
        exitCode: 1,
        lines: [
          `cc:engine-template: pnpm pack of ${manifest.json.name} made ${made.length} tarballs`,
        ],
      };
    }
    tarballs[manifest.json.name] = made[0] ?? '';
  }
  writeFileSync(join(dir, 'tarballs.json'), `${JSON.stringify(tarballs, null, 2)}\n`);
  return {
    exitCode: 0,
    lines: [
      `cc:engine-template: packed ${Object.keys(tarballs).length} @cc/* packages into ${dir}`,
    ],
  };
}

/** Turns the named flags on in the template's tools/build-flags.ts; returns the ones changed. */
export function flagsOn(
  source: string,
  names: readonly string[],
): { source: string; changed: string[] } {
  const changed: string[] = [];
  let next = source;
  for (const name of names) {
    const pattern = new RegExp(`(\\n\\s*${name}: \\{\\s*\\n\\s*on: )false`);
    if (pattern.test(next)) {
      next = next.replace(pattern, '$1true');
      changed.push(name);
    } else if (!new RegExp(`\\n\\s*${name}: \\{\\s*\\n\\s*on: true`).test(next)) {
      throw new Error(`tools/build-flags.ts has no ${name} flag`);
    }
  }
  return { source: next, changed };
}

export function pin(engine: string, tarballsDir: string): Result {
  const root = resolve(engine);
  const dir = resolve(tarballsDir);
  const index = join(dir, 'tarballs.json');
  if (!existsSync(index))
    return { exitCode: 1, lines: [`cc:engine-template: no ${index}; run pack first`] };
  const tarballs = JSON.parse(readFileSync(index, 'utf8')) as Record<string, string>;
  const spec = (name: string): string => {
    const file = tarballs[name];
    if (file === undefined) throw new Error(`no tarball for ${name}`);
    return fileSpec(join(dir, file));
  };

  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  for (const [field, names] of Object.entries(ENGINE_PINS)) {
    const deps = { ...(manifest[field] ?? {}) };
    for (const name of names) deps[name] = spec(name);
    manifest[field] = deps;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // pnpm-workspace.yaml, keeping the template's comments.
  const workspacePath = join(root, 'pnpm-workspace.yaml');
  const workspace = parseDocument(
    existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : '{}',
  );
  for (const [name, allowed] of Object.entries(ENGINE_ALLOW_BUILDS)) {
    workspace.setIn(['allowBuilds', name], allowed);
  }
  for (const name of Object.keys(tarballs).sort()) workspace.setIn(['overrides', name], spec(name));
  writeFileSync(workspacePath, workspace.toString());

  const flagsPath = join(root, 'tools', 'build-flags.ts');
  const flags = flagsOn(readFileSync(flagsPath, 'utf8'), FLAGS_ON);
  writeFileSync(flagsPath, flags.source);

  return {
    exitCode: 0,
    lines: [
      `cc:engine-template: ${basename(root)} pins ${[...ENGINE_PINS.dependencies, ...ENGINE_PINS.devDependencies].join(' and ')} from ${dir}, overrides ${Object.keys(tarballs).length} @cc/* packages, flags on: ${flags.changed.join(', ') || 'already'}`,
    ],
  };
}

export function main(argv: readonly string[], root: string): Result {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        out: { type: 'string' },
        engine: { type: 'string' },
        tarballs: { type: 'string' },
      },
    }));
  } catch (error) {
    return { exitCode: 2, lines: [error instanceof Error ? error.message : String(error), USAGE] };
  }
  try {
    if (command === 'pack' && values.out !== undefined) return pack(root, values.out);
    if (command === 'pin' && values.engine !== undefined && values.tarballs !== undefined) {
      return pin(values.engine, values.tarballs);
    }
  } catch (error) {
    return {
      exitCode: 1,
      lines: [`cc:engine-template: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return { exitCode: 2, lines: [USAGE] };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = main(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)));
  const text = result.lines.join('\n');
  if (text !== '') (result.exitCode === 0 ? console.log : console.error)(text);
  process.exitCode = result.exitCode;
}
