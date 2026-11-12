/**
 * Runs `cc-axi` in-process against a headless core (support/core.ts), for fast tests. pnpm cc:axi-conformance runs
 * the built bin as a separate process instead.
 */
import { decode } from '@toon-format/toon';

import { runCli } from '../../src/cli.ts';
import { testEnv } from './core.ts';

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  /** The stdout decoded from TOON. */
  readonly output: Record<string, unknown>;
}

export async function cli(
  profileDir: string,
  argv: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  let stdout = '';
  const code = await runCli({
    argv,
    env: testEnv(profileDir, extraEnv),
    stdout: { write: (chunk: string) => (stdout += chunk) },
    bin: '/usr/local/bin/cc-axi',
  });
  let output: Record<string, unknown> = {};
  try {
    output = decode(stdout) as Record<string, unknown>;
  } catch {
    // Left empty: a test that needs TOON fails on its own assertion.
  }
  return { code, stdout, output };
}
