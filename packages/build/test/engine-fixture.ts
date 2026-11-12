/**
 * A synthetic engine checkout for the @cc/build tests: the 08 §4.1 `cc-engine` shape, cut
 * down, in a fresh profile directory, committed to its own git repository. No real names
 * or data (AGENTS.md rule 5).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { NULL_FILE, sha256, writeInstallStamp } from '@cc/build-runtime';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';

export const ENGINE_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify(
    {
      name: 'fixture-engine',
      version: '0.1.0',
      private: true,
      scripts: { postinstall: 'cc-build install-stamp', build: 'cc-build build' },
    },
    null,
    2,
  )}\n`,
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n",
  '.gitignore': 'node_modules/\ndist/\n',
  'cc.config.ts':
    'export default {\n  extensionApi: 1,\n  vocabulary: { actionItem: "Action" },\n};\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": true, "noEmit": true } }\n',
  'theme/tokens.json': '{ "color": { "accent": { "$value": "#0b6e4f" } } }\n',
  'ui/header.ts': 'export const title = "Header";\n',
  'connectors.lock': '{ "entries": [] }\n',
};

/** Runs git in a fixture repository, isolated from the machine's global and system config. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: NULL_FILE,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export interface EngineFixture extends ProfileDir {
  /** The engine checkout. */
  readonly root: string;
  commit(message: string): string;
}

/** A committed fixture engine with its install stamp written, as after pnpm install. */
export function createEngine(
  files: Readonly<Record<string, string>> = ENGINE_FILES,
): EngineFixture {
  const dir = createProfileDir();
  const root = join(dir.path, 'engine');
  mkdirSync(root);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: fixture engine');
  writeInstallStamp(root);
  return {
    ...dir,
    root,
    commit(message) {
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', message);
      return git(root, 'rev-parse', 'HEAD');
    },
  };
}

/** sha256 of every file under `dir`, `.git` and ignored files included (AC-04-14). */
export function hashTree(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const name = relative(dir, full).split(sep).join('/');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile())
        hashes[name] = `${sha256(readFileSync(full))}:${statSync(full).mode}`;
      else hashes[name] = 'other';
    }
  };
  visit(dir);
  return hashes;
}
