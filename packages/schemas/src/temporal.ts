/**
 * The one Temporal of the process (ADR 0001 decision 1). Every package that needs dates,
 * instants or time zones imports `Temporal` from `@cc/schemas`, never from `temporal-polyfill`
 * directly, because objects from two Temporal implementations do not interoperate. Only this
 * module may later switch to native Temporal, and it then switches for the whole process.
 * ESLint enforces the single import (ADR 0001 follow-up 1).
 */
export { Temporal } from 'temporal-polyfill';
