/**
 * @cc/cli: `cc-axi`, the AXI command line (07 §4). The bin entry is dist/bin.js. This module
 * exports the catalogue and runner for `pnpm cc:axi-conformance`, the generated CLI
 * reference and product skill, and tests.
 */
export { HANDLERS, runCli, type RunOptions } from './cli.js';
export { CliError, exitCodeOf } from './errors.js';
export { commandHelp, DESCRIPTION, HUMAN_ONLY_VERBS, topLevelHelp } from './help.js';
export { renderReference } from './reference.js';
export { renderSkill, SKILL_DESCRIPTION, SKILL_NAME } from './skill.js';
export { TRUNCATE_AT } from './render.js';
export * from './spec.js';
export { VERSION } from './version.js';
