/**
 * Test harness for @cc/rhythm: the 02 §8.1 scenario series (fixtures/records/meeting_series@1),
 * the scenario's working hours and protected blocks (fixtures/onboarding/scenario.json), a fake
 * clock, a counting ID source, an in-memory `RhythmStore`, and a check that every write is valid
 * against its record schema with one event for its own record (INV-03-09).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect } from 'vitest';

import type { Caller, Change, DomainContext, Registry } from '@cc/domain';
import type { PlacementContext, RhythmStore } from '@cc/rhythm';
import {
  OnboardingProfile,
  recordTypes,
  validateRecord,
  type HumanRefKind,
  type Issue,
  type MeetingInstance,
  type MeetingSeries,
  type Workstream,
} from '@cc/schemas';
import { createFakeClock, type FakeClock } from '@cc/test-kit';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** The host time zones every fixture runs under (ADR 0001 follow-up 3). */
export const HOST_ZONES = ['UTC', 'Asia/Kolkata', 'America/New_York'] as const;

/** Sets `process.env.TZ` for the enclosing describe block and restores it after. */
export function onHost(zone: string): void {
  const saved = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = zone;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  });
}

export function scenarioSeries(): MeetingSeries[] {
  const dir = join(root, 'fixtures', 'records', 'meeting_series@1');
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as MeetingSeries);
}

export function seriesById(id: string): MeetingSeries {
  if (id === 'ser_goal_wig') return wigSeries();
  const found = scenarioSeries().find((s) => s.id === id);
  if (found === undefined) throw new Error(`no series ${id}`);
  return found;
}

/**
 * A weekly 30-minute 4dx WIG session (Mondays 13:15 IST) of a goal area outside the reference
 * scenario, for tests that need a second weekly series beside the weekly CEO review.
 */
export function wigSeries(): MeetingSeries {
  return {
    ...seriesById('ser_ceo_weekly'),
    id: 'ser_goal_wig',
    name: 'WIG session',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=13;BYMINUTE=15',
    dtstart: '2026-11-09T13:15',
    durationMinutes: 30,
    workstreamIds: ['ws_goal'],
    frameworkInstanceIds: ['fwi_goal'],
    backboneMeetingKey: 'weekly',
    agendaTemplateId: 'agenda.4dx.wig-session@1',
    agendaOverrides: [],
    absorbs: [],
    calendars: [],
  };
}

export function scenarioProfile(): OnboardingProfile {
  return OnboardingProfile.parse(
    JSON.parse(readFileSync(join(root, 'fixtures', 'onboarding', 'scenario.json'), 'utf8')),
  );
}

/**
 * The scenario's placement context: 01 §7.1 working hours and blocks, and the S6 confirmations
 * of 02 §8.1 (quarterly and yearly sessions inside the soft "Deep block A").
 */
export function scenarioPlacement(): PlacementContext {
  const { workspace } = scenarioProfile();
  return {
    timeZone: workspace.timeZone,
    workweek: workspace.workweek,
    workingHours: workspace.workingHours,
    protectedBlocks: workspace.protectedBlocks,
    confirmations: [
      { seriesId: 'ser_ceo_quarterly', reason: 'soft_block', blockId: 'pb_deep_a' },
      { seriesId: 'ser_ceo_yearly', reason: 'soft_block', blockId: 'pb_deep_a' },
    ],
  };
}

export interface Harness {
  readonly ctx: DomainContext;
  readonly clock: FakeClock;
}

function workstream(id: string, slug: string, timeZone = 'Asia/Kolkata'): Workstream {
  return {
    id: id as Workstream['id'],
    slug,
    name: slug,
    kind: 'company',
    principalId: 'per_self',
    stewardId: 'per_self',
    timeZone,
    status: 'active',
    privacy: 'normal',
    aiDataPolicy: 'allow',
    repoPaths: [],
    groundingRefs: [],
    createdAt: '2026-11-04T04:10:00Z',
    createdBy: { kind: 'user' },
    updatedAt: '2026-11-04T04:10:00Z',
    updatedBy: { kind: 'user' },
    version: 1,
  };
}

export function harness(start = '2026-11-04T04:10:00Z'): Harness {
  const clock = createFakeClock(start);
  let next = 0;
  const counters: Record<HumanRefKind, number> = { A: 200, D: 10, I: 20, R: 5, M: 1, G: 10, K: 10 };
  const workstreams = new Map(
    [
      workstream('ws_ald', 'alderwick'),
      workstream('ws_qlm', 'quillmarsh'),
      workstream('ws_us', 'us-zoned', 'America/New_York'),
      workstream('ws_goal', 'goal-area'),
    ].map((w) => [w.id as string, w]),
  );
  const registry: Registry = {
    selfPersonId: 'per_self',
    person: () => undefined,
    workstream: (id) => workstreams.get(id),
    connectorHasAction: () => false,
    validators: () => [],
  };
  const ctx: DomainContext = {
    clock,
    ids: {
      id: (prefix) => `${prefix}_t${String(++next).padStart(5, '0')}`,
      ref: (kind) => `${kind}-${String(counters[kind]++).padStart(4, '0')}`,
    },
    registry,
  };
  return { ctx, clock };
}

export const user: Caller = { actor: { kind: 'user' } };
export const rhythm: Caller = { actor: { kind: 'system', component: 'rhythm' } };
export const scheduler: Caller = { actor: { kind: 'system', component: 'scheduler' } };
export const agentCaller: Caller = {
  actor: { kind: 'agent', principalId: 'agt_cli_default' },
  scopes: ['meetings:capture'],
};

const schemaOf = new Map(recordTypes.map((record) => [record.type, record]));

/** Checks writes: one valid event per record, and every record valid against its schema. */
export function checkChanges(changes: readonly Change[]): void {
  const eventSchema = schemaOf.get('domain_event');
  for (const write of changes) {
    const record = write.record as { id: string };
    expect(write.event.entity.id).toBe(record.id);
    expect(write.event.type.startsWith(`${write.kind}.`)).toBe(true);
    if (eventSchema !== undefined) expect(validateRecord(eventSchema, write.event)).toEqual([]);
    const schema = schemaOf.get(write.kind);
    expect(schema).toBeDefined();
    if (schema !== undefined) expect(validateRecord(schema, write.record)).toEqual([]);
  }
}

/** Runs a command expected to fail and returns its DomainError fields. */
export function failure(run: () => unknown): {
  code: string;
  rule: string;
  message: string;
  help: readonly string[];
} {
  try {
    run();
  } catch (error) {
    const e = error as { code: string; rule: string; message: string; help: readonly string[] };
    return { code: e.code, rule: e.rule, message: e.message, help: e.help };
  }
  throw new Error('expected the command to fail');
}

/**
 * A `RhythmStore` as the acceptance suite inspects it: what it holds, and every commit. The
 * in-memory fake below is one; the core's store-backed one (packages/core/test) is the other.
 */
export type TestRhythmStore = RhythmStore & {
  readonly instances: ReadonlyMap<string, MeetingInstance>;
  readonly issues: ReadonlyMap<string, Issue>;
  readonly commits: readonly (readonly Change[])[];
};

/** The in-memory fake of the store the core implements (D5). */
export function memoryStore(series: readonly MeetingSeries[]): TestRhythmStore & {
  readonly instances: Map<string, MeetingInstance>;
  readonly issues: Map<string, Issue>;
  readonly commits: Change[][];
} {
  const seriesMap = new Map(series.map((s) => [s.id as string, s]));
  const instances = new Map<string, MeetingInstance>();
  const issues = new Map<string, Issue>();
  const commits: Change[][] = [];
  return {
    instances,
    issues,
    commits,
    listSeries: () => [...seriesMap.values()],
    listInstances: (ids) => [...instances.values()].filter((i) => ids.includes(i.seriesId)),
    openRhythmIssues: () =>
      [...issues.values()].filter((i) => i.status === 'open' && i.raisedFrom.kind === 'rhythm'),
    commit(changes) {
      checkChanges(changes);
      commits.push([...changes]);
      for (const write of changes) {
        if (write.kind === 'meeting_instance') {
          const record = write.record as MeetingInstance;
          instances.set(record.id, record);
        } else if (write.kind === 'meeting_series') {
          const record = write.record as MeetingSeries;
          seriesMap.set(record.id, record);
        } else if (write.kind === 'issue') {
          const record = write.record as Issue;
          issues.set(record.id, record);
        }
      }
    },
  };
}
