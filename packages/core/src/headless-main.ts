/**
 * `node packages/core/dist/headless-main.js --profile-dir <dir>`: runs the headless core
 * until it is told to stop. Prints one JSON line `{"ready":true,"endpoint":…,"pid":…}` on
 * stdout once it listens. `cc-axi serve --headless` (P1-05) wraps the same `startHeadless`.
 *
 * Graceful stop: SIGINT or SIGTERM on POSIX (and Ctrl+C in a Windows console); or, on every
 * platform, a `"stop"` message over the Node IPC channel when the parent started it with one
 * (Windows cannot deliver a catchable SIGTERM from another process), or the parent closing
 * that channel.
 */
import { systemClock } from './clock.js';
import { isCoreError } from './errors.js';
import { startHeadless } from './headless.js';
import { stderrLogger } from './logger.js';

function profileDirFrom(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--profile-dir');
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const profileDir = profileDirFrom(process.argv.slice(2));
  if (profileDir === undefined || profileDir.startsWith('--')) {
    process.stderr.write('usage: headless-main --profile-dir <dir>\n');
    process.exitCode = 2;
    return;
  }
  const core = await startHeadless({ profileDir, logger: stderrLogger(systemClock) });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    core.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.send !== undefined) {
    process.on('message', (message) => {
      if (message === 'stop') shutdown();
    });
    process.once('disconnect', shutdown);
  }
  // Announce readiness only once the stop handlers are in place: a parent that signals as
  // soon as it reads this line must find them installed.
  process.stdout.write(
    `${JSON.stringify({ ready: true, endpoint: core.endpoint, pid: process.pid })}\n`,
  );
}

main().catch((error: unknown) => {
  const message = isCoreError(error)
    ? `${error.code}: ${error.message}\n${error.help.join('\n')}`
    : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
