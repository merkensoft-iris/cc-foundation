#!/usr/bin/env node
/**
 * The `cc-axi` bin entry (ADR 0002 decision 5, 07 §4.1 rule 10): `-v`, `-V` and `--version`
 * are answered by `tryFastPath()` from the leaf version module before the command graph
 * loads (AC-07-02); everything else loads cli.js.
 */
import { tryFastPath } from 'axi-sdk-js/fast-path';

import { VERSION } from './version.js';

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import('./cli.js');
  await main();
}
