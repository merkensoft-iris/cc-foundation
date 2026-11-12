/**
 * Test harness for the P1-08 meeting logic (02 §5, §6): the reference records of
 * fixtures/records, a domain context whose registry knows the scenario's people and
 * workstreams, hand-built meeting instances of the 02 §8.1 series, and the data a pre-read
 * resolves against.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Caller, DomainContext, Registry } from '@cc/domain';
import { wallClockInstant, type MeetingData } from '@cc/rhythm';
import type {
  ActionItem,
  Decision,
  Evidence,
  Goal,
  HumanRefKind,
  Issue,
  Measure,
  MeasureValue,
  MeetingInstance,
  MeetingSeries,
  Person,
  Risk,
  Workstream,
} from '@cc/schemas';
import { createFakeClock, type FakeClock } from '@cc/test-kit';

import { seriesById } from './harness.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));

export function fixtures<T>(type: string): T[] {
  const dir = join(root, 'fixtures', 'records', `${type}@1`);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T);
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const AUDIT = {
  createdAt: '2026-11-04T04:10:00Z',
  createdBy: { kind: 'user' as const },
  updatedAt: '2026-11-04T04:10:00Z',
  updatedBy: { kind: 'user' as const },
  version: 1,
};

function workstream(id: string, name: string, timeZone = 'Asia/Kolkata'): Workstream {
  return {
    id: id as Workstream['id'],
    slug: name.toLowerCase().replace(/[^a-z]+/g, '-'),
    name,
    kind: 'company',
    principalId: 'per_self',
    stewardId: 'per_self',
    timeZone,
    status: 'active',
    privacy: 'normal',
    aiDataPolicy: 'allow',
    repoPaths: [],
    groundingRefs: [],
    ...AUDIT,
  };
}

export const WORKSTREAMS: readonly Workstream[] = [
  workstream('ws_ald', 'Alderwick'),
  workstream('ws_qlm', 'Quillmarsh'),
  workstream('ws_goal', 'Goal area'),
  workstream('ws_us', 'A US-zoned workstream (not in the scenario)', 'America/New_York'),
  workstream('ws_workspace', 'Workspace'),
];

export interface MeetingHarness {
  readonly ctx: DomainContext;
  readonly clock: FakeClock;
}

export function meetingHarness(start = '2026-11-13T09:30:00Z'): MeetingHarness {
  const clock = createFakeClock(start);
  let next = 0;
  const counters: Record<HumanRefKind, number> = {
    A: 300,
    D: 30,
    I: 40,
    R: 10,
    M: 90,
    G: 20,
    K: 40,
  };
  const persons = new Map(fixtures<Person>('person').map((p) => [p.id as string, p]));
  const workstreams = new Map(WORKSTREAMS.map((w) => [w.id as string, w]));
  const registry: Registry = {
    selfPersonId: 'per_self',
    person: (id) => persons.get(id),
    workstream: (id) => workstreams.get(id),
    connectorHasAction: () => false,
    validators: () => [],
  };
  return {
    clock,
    ctx: {
      clock,
      ids: {
        id: (prefix) => `${prefix}_t${String(++next).padStart(5, '0')}`,
        ref: (kind) => `${kind}-${String(counters[kind]++).padStart(4, '0')}`,
      },
      registry,
    },
  };
}

export const user: Caller = { actor: { kind: 'user' } };
export const rhythmCaller: Caller = { actor: { kind: 'system', component: 'rhythm' } };
export const agent: Caller = {
  actor: { kind: 'agent', principalId: 'agt_cli_default' },
  scopes: ['read', 'meetings:capture'],
};

let instanceCounter = 0;

/** An instance of a scenario series at a local start ("2026-11-13T15:00"). */
export function instanceOf(
  seriesId: string,
  localStart: string,
  fields: Partial<MeetingInstance> = {},
): MeetingInstance {
  const series = seriesById(seriesId);
  const start = wallClockInstant(localStart, series.timeZone);
  if (start === undefined) throw new Error(`no instant for ${localStart}`);
  const end = new Date(Date.parse(start) + series.durationMinutes * 60_000)
    .toISOString()
    .replace('.000Z', 'Z');
  instanceCounter++;
  return {
    id: `mtg_${seriesId.slice(4)}_${localStart.slice(0, 10).replace(/-/g, '')}` as MeetingInstance['id'],
    ref: `M-${String(instanceCounter).padStart(4, '0')}`,
    seriesId: series.id,
    occurrenceStart: start,
    scheduledStart: start,
    scheduledEnd: end,
    state: 'planned',
    agenda: [],
    outputs: {
      decisionIds: [],
      actionItemIds: [],
      issueIds: [],
      riskIds: [],
      measureValueIds: [],
      goalIds: [],
      statusUpdates: [],
      verifications: [],
    },
    calendarEvents: [],
    carriedFrom: [],
    absorbedInstanceIds: [],
    notes: '',
    ...AUDIT,
    ...fields,
  };
}

export { seriesById };

export interface DataOverrides {
  readonly actionItems?: readonly ActionItem[];
  readonly measures?: readonly Measure[];
  readonly measureValues?: readonly MeasureValue[];
  readonly goals?: readonly Goal[];
  readonly decisions?: readonly Decision[];
  readonly issues?: readonly Issue[];
  readonly risks?: readonly Risk[];
  readonly evidence?: readonly Evidence[];
  readonly instances?: readonly MeetingInstance[];
  readonly series?: readonly MeetingSeries[];
}

/** The reference records as the data a pre-read resolves against. */
export function meetingData(overrides: DataOverrides = {}): MeetingData {
  return {
    workspaceTimeZone: 'Asia/Kolkata',
    workstreams: WORKSTREAMS,
    actionItems: overrides.actionItems ?? fixtures<ActionItem>('action_item'),
    evidence: overrides.evidence ?? [],
    measures: overrides.measures ?? fixtures<Measure>('measure'),
    measureValues: overrides.measureValues ?? fixtures<MeasureValue>('measure_value'),
    goals: overrides.goals ?? fixtures<Goal>('goal'),
    decisions: overrides.decisions ?? fixtures<Decision>('decision'),
    issues: overrides.issues ?? fixtures<Issue>('issue'),
    risks: overrides.risks ?? fixtures<Risk>('risk'),
    series: overrides.series ?? fixtures<MeetingSeries>('meeting_series'),
    instances: overrides.instances ?? [],
  };
}

/** A fixture action item with fields changed. */
export function item(ref: string, fields: Partial<ActionItem> = {}): ActionItem {
  const found = fixtures<ActionItem>('action_item').find((candidate) => candidate.ref === ref);
  if (found === undefined) throw new Error(`no fixture item ${ref}`);
  return { ...found, ...fields };
}
