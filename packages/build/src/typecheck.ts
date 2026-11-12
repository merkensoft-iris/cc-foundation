/**
 * The engine's type-check: the engine's own `tsc --noEmit` (ADR 0003 decisions 6 and 7).
 * `cc-build build` runs it before packaging, and `cc:upgrade` after writing its edits.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface TypecheckResult {
  readonly ok: boolean;
  /** tsc's output, or why it could not run. */
  readonly output: string;
  readonly ms: number;
}

export type Typecheck = (root: string) => Promise<TypecheckResult>;

/** Runs the TypeScript installed in the engine (`typescript` in its devDependencies). */
export const engineTypecheck: Typecheck = (root) => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (!existsSync(join(root, 'tsconfig.json'))) {
    return Promise.resolve({ ok: false, output: 'no tsconfig.json in the engine', ms: 0 });
  }
  let tsc: string;
  try {
    tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    return Promise.resolve({
      ok: false,
      output: 'typescript is not installed in the engine (run pnpm install)',
      ms: elapsed(),
    });
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsc, '--noEmit', '-p', 'tsconfig.json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout}${stderr}`.trim(), ms: elapsed() });
      },
    );
  });
};
