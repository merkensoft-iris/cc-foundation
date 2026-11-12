/**
 * @cc/domain: lifecycle, invariants, health, review loop, metrics (pure, D4).
 *
 * P1-03 (docs/design/09-build-plan.md §6.1): the rules of docs/design/03-decisions-and-action-
 * items.md §6 to §11 as pure commands and checks. A command takes the current records, a
 * caller and a context (an injected clock, ID source and read-only registry) and returns the
 * next records with one domain event each (INV-03-09); the core service (P1-04) loads the
 * records, runs the command and commits its changes in one transaction through the store
 * (P1-02). Nothing here does I/O, reads the clock or draws random numbers (08 §4.2, D4).
 */
export const PACKAGE_NAME = '@cc/domain';

export * from './agenda-inputs.js';
export * from './context.js';
export * from './decisions.js';
export * from './errors.js';
export * from './events.js';
export * from './health.js';
export * from './invariants.js';
export * from './issues.js';
export * from './items.js';
export * from './metrics.js';
export * from './privacy.js';
export * from './review.js';
export * from './steps.js';
export * from './time.js';
export * from './types.js';
