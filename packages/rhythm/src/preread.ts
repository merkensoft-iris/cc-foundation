/**
 * The pre-read (02 §6.2, §4.7). At `start − prereadLeadMinutes`, or on demand, the instance's
 * agenda is composed (02 §4.3, §4.4, with pack sections in their slots) and every section's
 * inputs are resolved (02 §6.1). The result is a snapshot: canonical JSON of all input results
 * plus a rendered Markdown view. The core stores both in the blob store and records their
 * hashes on the instance, which becomes `prepared`.
 *
 * 1. It is rebuilt on demand until the meeting starts, and is immutable afterwards (C-02-03).
 *    A rebuild whose inputs hash is unchanged writes nothing.
 * 2. No AI summary (P1-08 builds none; 02 §6.2 rule 3 arrives with the AI layer in P3).
 * 3. Items with no update since the previous held instance form an "Update needed" list, and
 *    the first pre-read of an instance that has one asks for one notification (02 §4.7).
 * 4. While the backup state is `not_configured`, a merged weekly review shows the standing
 *    line "No off-machine backup destination" under `headlines` (02 §5.1, owner decision Q8).
 *
 * Hashing is passed in (`sha256`): this package does no I/O and uses no Node built-ins (D4).
 */
import {
  type Caller,
  type DomainContext,
  type Outcome,
  forbidden,
  invariantError,
  isSystem,
  isUser,
  touched,
} from '@cc/domain';
import type {
  AgendaSectionInstance,
  AgendaSectionTemplate,
  AgendaTemplate,
  MeetingInstance,
  MeetingSeries,
} from '@cc/schemas';

import { composeAgenda, withPackSections, type PackSectionSpec } from './agenda.js';
import { resolveInput, type InputRow, type MeetingData, type ResolvedInput } from './inputs.js';
import { canTransition, instanceChange } from './state.js';
import { addMinutes, compareInstants, localDateTime, zoned } from './time.js';

export const PREREAD_FORMAT = 'cc.preread@1';
export const BACKUP_STANDING_LINE = 'No off-machine backup destination';

/** A pack section to add, with its section template (01 §4 `Pack.agendaSections`). */
export interface PackSection extends PackSectionSpec {
  readonly section: AgendaSectionTemplate;
}

/** A meeting this instance absorbs (02 §4.3). */
export interface AbsorbedMeeting {
  readonly instance: MeetingInstance;
  readonly series: MeetingSeries;
  readonly template: AgendaTemplate;
  readonly packSections?: readonly PackSection[];
}

export interface PrereadInput {
  readonly series: MeetingSeries;
  readonly instance: MeetingInstance;
  readonly template: AgendaTemplate;
  readonly packSections?: readonly PackSection[];
  readonly absorbed?: readonly AbsorbedMeeting[];
  readonly data: MeetingData;
  /** 04 §9.1; undefined until backups exist (P1-17). */
  readonly backupState?: 'not_configured' | 'healthy' | 'warning' | 'failing';
  /** The build time, a UTC timestamp. */
  readonly now: string;
  /** Lower-case hex SHA-256 of a UTF-8 string. */
  readonly sha256: (text: string) => string;
}

export interface PrereadSection {
  readonly sectionId: string;
  readonly type: AgendaSectionTemplate['type'];
  readonly title: string;
  readonly workstreamId?: string;
  readonly absorbedFrom?: string;
  readonly timeboxMinutes: number;
  readonly allowedOutputs: readonly string[];
  readonly rules: readonly string[];
  readonly inputs: readonly ResolvedInput[];
  readonly standingLines: readonly string[];
}

export interface PrereadSnapshot {
  readonly format: typeof PREREAD_FORMAT;
  readonly instance: {
    readonly id: string;
    readonly ref: string;
    readonly seriesId: string;
    readonly seriesName: string;
    readonly scheduledStart: string;
    readonly scheduledEnd: string;
    readonly timeZone: string;
  };
  readonly builtAt: string;
  readonly sections: readonly PrereadSection[];
  readonly updateNeeded: readonly InputRow[];
}

export interface BuiltPreread {
  readonly agenda: AgendaSectionInstance[];
  readonly snapshot: PrereadSnapshot;
  /** The snapshot as stored: canonical JSON. */
  readonly json: string;
  readonly markdown: string;
  readonly snapshotSha256: string;
  readonly renderedSha256: string;
  /** SHA-256 of the canonical JSON of the agenda and its inputs, without the build time. */
  readonly inputsHash: string;
}

/** JSON with object keys sorted at every level, so equal data hashes equally. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, sort(inner)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** The states a pre-read may still be built in (02 §4.2, C-02-03). */
export function canBuildPreread(
  series: Pick<MeetingSeries, 'calendars'>,
  instance: Pick<MeetingInstance, 'state' | 'actualStart'>,
): boolean {
  if (instance.actualStart !== undefined) return false;
  if (instance.state === 'prepared' || instance.state === 'scheduled') return true;
  return instance.state === 'planned' && series.calendars.length === 0;
}

function requireBuildable(series: MeetingSeries, instance: MeetingInstance): void {
  if (instance.actualStart !== undefined || instance.state === 'in_progress') {
    throw invariantError({
      rule: 'C-02-03',
      message: `${instance.ref} has started; its pre-read is immutable`,
    });
  }
  if (!canBuildPreread(series, instance)) {
    throw invariantError({
      rule: '02 §4.2',
      message:
        instance.state === 'planned'
          ? `${instance.ref} is not on its calendar yet; only a series with no calendar binding is prepared from planned`
          : `${instance.ref} is ${instance.state}; it gets no pre-read`,
    });
  }
}

function templateWithPacks(
  template: AgendaTemplate,
  packs: readonly PackSection[] | undefined,
): AgendaTemplate {
  const composed = withPackSections(template, packs ?? []);
  return { ...template, sections: composed.sections as AgendaSectionTemplate[] };
}

/** Builds the pre-read of an instance (pure; the core stores it). */
export function buildPreread(input: PrereadInput): BuiltPreread {
  const { series, instance, data } = input;
  requireBuildable(series, instance);
  const own = templateWithPacks(input.template, input.packSections);
  const absorbed = (input.absorbed ?? []).map((meeting) => ({
    ...meeting,
    template: templateWithPacks(meeting.template, meeting.packSections),
  }));
  const agenda = composeAgenda({
    template: own,
    series,
    absorbed: absorbed.map((meeting) => ({
      instanceId: meeting.instance.id,
      template: meeting.template,
      series: meeting.series,
      absorbedMinutes:
        series.absorbs.find((entry) => entry.cadence === meeting.series.cadence)?.absorbedMinutes ??
        0,
    })),
  });
  const sections: PrereadSection[] = [];
  const filled = agenda.map((row): AgendaSectionInstance => {
    const source = absorbed.find((meeting) => meeting.instance.id === row.absorbedFrom);
    const template = source?.template ?? own;
    const owner = source?.series ?? series;
    const section = template.sections.find((s) => s.id === row.sectionId);
    if (section === undefined) {
      throw invariantError({ rule: '02 §5', message: `${template.id} has no ${row.sectionId}` });
    }
    const workstreamIds = row.workstreamId === undefined ? owner.workstreamIds : [row.workstreamId];
    const inputs = section.inputs.map((query) =>
      resolveInput(query, { series, instance, workstreamIds, data }),
    );
    const standingLines =
      input.backupState === 'not_configured' &&
      section.type === 'headlines' &&
      template.id === 'agenda.eos-lite.weekly@1' &&
      owner.workstreamIds.length > 1
        ? [BACKUP_STANDING_LINE]
        : [];
    sections.push({
      sectionId: row.sectionId,
      type: section.type,
      title: section.title,
      ...(row.workstreamId === undefined ? {} : { workstreamId: row.workstreamId }),
      ...(row.absorbedFrom === undefined ? {} : { absorbedFrom: row.absorbedFrom }),
      timeboxMinutes: row.timeboxMinutes,
      allowedOutputs: section.allowedOutputs,
      rules: section.rules,
      inputs,
      standingLines,
    });
    return {
      ...row,
      inputResults: inputs.map((resolved) => ({
        queryId: resolved.queryId,
        count: resolved.count,
        itemRefs: resolved.rows.map((r) => r.ref),
        flags: [...resolved.flags],
      })),
    };
  });
  const seen = new Set<string>();
  const updateNeeded: InputRow[] = [];
  for (const section of sections) {
    for (const resolved of section.inputs) {
      for (const row of resolved.rows) {
        if (!row.flags.includes('update_needed') || seen.has(row.ref)) continue;
        seen.add(row.ref);
        updateNeeded.push(row);
      }
    }
  }
  updateNeeded.sort((a, b) => a.ref.localeCompare(b.ref));
  const snapshot: PrereadSnapshot = {
    format: PREREAD_FORMAT,
    instance: {
      id: instance.id,
      ref: instance.ref,
      seriesId: series.id,
      seriesName: series.name,
      scheduledStart: instance.scheduledStart,
      scheduledEnd: instance.scheduledEnd,
      timeZone: series.timeZone,
    },
    builtAt: input.now,
    sections,
    updateNeeded,
  };
  const json = canonicalJson(snapshot);
  const markdown = renderPreread(snapshot, data);
  return {
    agenda: filled,
    snapshot,
    json,
    markdown,
    snapshotSha256: input.sha256(json),
    renderedSha256: input.sha256(markdown),
    inputsHash: input.sha256(canonicalJson({ sections, updateNeeded })),
  };
}

function cell(text: string | number | undefined): string {
  if (text === undefined || text === '') return '';
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function detailText(row: InputRow): string {
  const detail = row.detail;
  if (detail === undefined) return '';
  const values = detail['values'];
  if (Array.isArray(values)) {
    return (values as { periodStart: string; value: unknown; normal: boolean | null }[])
      .map((v) => {
        const shown = v.value === null ? '—' : String(v.value);
        const read = v.normal === false ? ' (not normal)' : '';
        return `${v.periodStart}: ${shown}${read}`;
      })
      .join('; ');
  }
  return Object.entries(detail)
    .filter(([, value]) => typeof value !== 'object')
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(', ');
}

/** The Markdown view of a snapshot (02 §6.2 rule 1). Deterministic for the same snapshot. */
export function renderPreread(
  snapshot: PrereadSnapshot,
  data: Pick<MeetingData, 'workstreams'>,
): string {
  const names = new Map(data.workstreams.map((w) => [w.id as string, w.name]));
  const { instance } = snapshot;
  const start = localDateTime(instance.scheduledStart, instance.timeZone);
  const end = zoned(instance.scheduledEnd, instance.timeZone)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' });
  const lines: string[] = [
    `# Pre-read: ${instance.seriesName}`,
    '',
    `${instance.ref} · ${start.replace('T', ' ')}-${end} (${instance.timeZone}) · built ${snapshot.builtAt}`,
    '',
    'Status lives in this pre-read; meeting time is for decisions.',
  ];
  if (snapshot.updateNeeded.length > 0) {
    lines.push('', '## Update needed', '');
    for (const row of snapshot.updateNeeded) {
      lines.push(`- ${row.ref} ${row.title}${row.due === undefined ? '' : ` (due ${row.due})`}`);
    }
  }
  snapshot.sections.forEach((section, index) => {
    const where =
      section.workstreamId === undefined
        ? ''
        : ` · ${names.get(section.workstreamId) ?? section.workstreamId}`;
    const from = section.absorbedFrom === undefined ? '' : ' · absorbed';
    lines.push(
      '',
      `## ${String(index + 1)}. ${section.title}${where}${from} · ${String(section.timeboxMinutes)} min`,
    );
    for (const line of section.standingLines) lines.push('', `> ${line}`);
    for (const resolved of section.inputs) {
      const flags = resolved.flags.length === 0 ? '' : ` [${resolved.flags.join(', ')}]`;
      lines.push('', `### ${resolved.queryId} (${String(resolved.count)})${flags}`, '');
      if (resolved.rows.length === 0) {
        lines.push('None.');
        continue;
      }
      lines.push(
        '| Ref | Title | Workstream | Owner | Due | State | Health | Carried | Evidence | Flags | Detail |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
      );
      for (const row of resolved.rows) {
        lines.push(
          `| ${[
            cell(row.ref),
            cell(row.title),
            cell(row.workstreamIds.map((id) => names.get(id) ?? id).join(', ')),
            cell(row.ownerId),
            cell(row.due),
            cell(row.lifecycle),
            cell(row.health),
            cell(row.carryCount),
            cell(row.evidence),
            cell(row.flags.join(', ')),
            cell(detailText(row)),
          ].join(' | ')} |`,
        );
      }
    }
  });
  return `${lines.join('\n')}\n`;
}

export interface PrereadOutcome extends Outcome<MeetingInstance> {
  /** True when this pre-read should notify the user once about its "Update needed" list. */
  readonly notify: boolean;
}

/**
 * Records a built pre-read on the instance and sets it `prepared` (02 §4.2). The rhythm engine
 * builds it at its time; the user rebuilds it on demand. A rebuild with the same inputs hash
 * writes nothing.
 */
export function applyPreread(
  ctx: DomainContext,
  caller: Caller,
  series: MeetingSeries,
  instance: MeetingInstance,
  built: BuiltPreread,
): PrereadOutcome {
  if (!isUser(caller) && !isSystem(caller)) {
    throw forbidden('02 §6.2', 'pre-reads are built by the rhythm engine or rebuilt by the user');
  }
  requireBuildable(series, instance);
  if (instance.state === 'prepared' && instance.preread?.inputsHash === built.inputsHash) {
    return { status: 'no-op', record: instance, changes: [], notify: false };
  }
  if (instance.state !== 'prepared' && !canTransition(instance.state, 'prepared')) {
    throw invariantError({ rule: '02 §4.2', message: `${instance.ref} cannot be prepared` });
  }
  const next: MeetingInstance = {
    ...touched(ctx, instance, caller.actor),
    agenda: built.agenda,
    preread: {
      builtAt: built.snapshot.builtAt,
      snapshotSha256: built.snapshotSha256,
      renderedSha256: built.renderedSha256,
      inputsHash: built.inputsHash,
    },
    state: 'prepared',
  };
  const verb = instance.state === 'prepared' ? 'preread_rebuilt' : 'prepared';
  const write = instanceChange(ctx, caller, instance, next, verb);
  return {
    status: 'ok',
    record: next,
    changes: [write],
    notify: instance.preread === undefined && built.snapshot.updateNeeded.length > 0,
  };
}

/** Whether the scheduler should build an instance's pre-read at `now` (02 §4.7). */
export function isDuePreread(
  series: Pick<MeetingSeries, 'prereadLeadMinutes' | 'calendars' | 'status'>,
  instance: MeetingInstance,
  now: string,
): boolean {
  if (series.status !== 'active' || instance.preread !== undefined) return false;
  if (!canBuildPreread(series, instance)) return false;
  const at = addMinutes(instance.scheduledStart, -series.prereadLeadMinutes);
  return compareInstants(now, at) >= 0 && compareInstants(now, instance.scheduledEnd) < 0;
}

/**
 * The live data next to the snapshot (02 §6.2 rule 2): for each section's input, the refs added
 * and removed since the pre-read, and the count then and now.
 */
export function diffInputs(
  snapshot: readonly AgendaSectionInstance[],
  live: readonly AgendaSectionInstance[],
): {
  readonly sectionId: string;
  readonly workstreamId?: string;
  readonly absorbedFrom?: string;
  readonly queryId: string;
  readonly before: number;
  readonly after: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}[] {
  const out = [];
  for (const [index, section] of snapshot.entries()) {
    const now = live[index];
    for (const result of section.inputResults) {
      const current = now?.inputResults.find((r) => r.queryId === result.queryId);
      const before = new Set(result.itemRefs);
      const after = new Set(current?.itemRefs ?? []);
      const added = [...after].filter((ref) => !before.has(ref));
      const removed = [...before].filter((ref) => !after.has(ref));
      if (added.length === 0 && removed.length === 0 && result.count === (current?.count ?? 0)) {
        continue;
      }
      out.push({
        sectionId: section.sectionId,
        ...(section.workstreamId === undefined ? {} : { workstreamId: section.workstreamId }),
        ...(section.absorbedFrom === undefined ? {} : { absorbedFrom: section.absorbedFrom }),
        queryId: result.queryId,
        before: result.count,
        after: current?.count ?? 0,
        added,
        removed,
      });
    }
  }
  return out;
}
