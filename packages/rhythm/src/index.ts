/**
 * @cc/rhythm: RRULE expansion, horizon and materialisation, the instance state machine,
 * absorption, merged agendas, placement and the time-budget check (pure, D4); agenda templates,
 * input resolution, pre-reads, output capture and the conclude step (P1-08).
 *
 * P1-07 (docs/design/09-build-plan.md §6.1): docs/design/02-rhythm-and-calendar.md §4 and
 * 01 §6.4, on ADR 0001 (temporal-polyfill through @cc/schemas, rrule-temporal in floating mode).
 * Every function takes its records, a caller and a context (an injected clock, ID source and
 * registry, as @cc/domain) and returns the next records with one domain event each; the core
 * commits them through the store (engine.ts, `RhythmStore`). Nothing here does I/O, reads the
 * clock or the host time zone, or draws random numbers (08 §4.2, D4).
 *
 * P1-08: docs/design/02-rhythm-and-calendar.md §5 and §6: templates.ts, inputs.ts, preread.ts,
 * capture.ts and conclude.ts.
 *
 * P1-09: docs/design/02-rhythm-and-calendar.md §7 and §9.1: carry.ts (carry-forward),
 * escalation.ts (the escalation job) and ics.ts (the UTC .ics export of ADR 0001 decision 3).
 */
export const PACKAGE_NAME = '@cc/rhythm';

export * from './absorb.js';
export * from './agenda.js';
export * from './budget.js';
export * from './capture.js';
export * from './carry.js';
export * from './conclude.js';
export * from './dst.js';
export * from './engine.js';
export * from './escalation.js';
export * from './expand.js';
export * from './horizon.js';
export * from './ics.js';
export * from './inputs.js';
export * from './materialise.js';
export * from './missed.js';
export * from './placement.js';
export * from './preread.js';
export * from './series.js';
export * from './state.js';
export * from './templates.js';
export * from './time.js';
