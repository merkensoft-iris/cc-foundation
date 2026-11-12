/**
 * Entry of the core's `utilityProcess` (04 §3), forked by main's `CoreSupervisor`.
 */
import type { ParentPort } from './host.js';
import { runCoreHost } from './host.js';
import { realCore } from './real-core.js';

interface UtilityProcessGlobals {
  readonly parentPort?: ParentPort;
}

const parentPort = (process as unknown as UtilityProcessGlobals).parentPort;
if (parentPort === undefined) {
  process.stderr.write('the core host runs only as an Electron utility process\n');
  process.exitCode = 2;
} else {
  runCoreHost({
    parentPort,
    startCore: realCore(),
    exit: (code) => process.exit(code),
  });
}
