/**
 * Headless mode (04 §3 rule 2): the core under plain Node, without Electron, the browser
 * host or `safeStorage`, for development and tests (`cc-axi serve --headless --profile-dir
 * <dir>`, P1-05). It refuses to start when `NODE_ENV=production` (D7).
 *
 * Secrets: no P1-04 code reads a secret, so there is no keyring here yet. The test keyring of
 * 04 §3 rule 2 arrives with the first consumer (backups P1-17, connectors P2), injected by
 * the caller, never imported by production code (D7).
 *
 * Imported as `@cc/core/headless`, so the desktop build, which imports only `@cc/core`,
 * never contains it.
 */
import { CoreError } from './errors.js';
import { startCore, type CoreOptions, type CoreService } from './service.js';

export interface HeadlessOptions extends Omit<CoreOptions, 'userData'> {
  /** The profile directory; it plays the part of `<userData>`. */
  readonly profileDir: string;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export function assertHeadlessAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env['NODE_ENV'] === 'production') {
    throw new CoreError(
      'E_USAGE',
      'headless mode is for development and tests; it refuses to start when NODE_ENV=production',
      ['Run the Command Center app instead (04 §3 rule 2, 08 §4.2 D7)'],
    );
  }
}

export async function startHeadless(options: HeadlessOptions): Promise<CoreService> {
  assertHeadlessAllowed(options.env);
  const { profileDir, ...core } = options;
  return startCore({ ...core, userData: profileDir });
}
