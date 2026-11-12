/**
 * Agenda composition for merged and absorbing meetings (02 §4.3, §4.4), and pack sections in
 * extension slots. The agenda templates themselves (02 §5) are in templates.ts, their inputs in
 * inputs.ts and the pre-read that snapshots the composed agenda in preread.ts; this module takes
 * a template's sections as data and decides their order and timeboxes. The default timebox is
 * the 02 §5.1 column for the series: team, solo merged (more than one workstream) or solo.
 *
 * Merged meetings (02 §4.4):
 * 1. Sections before the first `perWorkstream` section appear once.
 * 2. Each run of consecutive `perWorkstream` sections repeats once per workstream, in the order of
 *    `workstreamIds`, so each workstream's backbone order holds (E-1).
 * 3. The remaining sections appear once.
 * 4. Timeboxes are fitted to the duration: shrink non-backbone sections towards `minMinutes`, then
 *    backbone sections towards `minMinutes`. If the minimums still do not fit, `E_AGENDA_FIT`
 *    names the smallest duration that fits.
 *
 * Absorption (02 §4.3): the absorbing instance's agenda starts with the absorbed meeting's
 * backbone sections, composed the same way for its workstreams and fitted to `absorbedMinutes`
 * by rule 4 (this is how "compressed" is read), followed by its own sections fitted to its own
 * `durationMinutes`.
 *
 * Shrinking takes one minute at a time from the section with the most room above its minimum
 * (on a tie, the later section), so the result is deterministic and spreads the cut. A template
 * that is already shorter than the duration keeps its timeboxes.
 */
import { DomainError } from '@cc/domain';
import type { AgendaSectionInstance, MeetingInstance, MeetingSeries } from '@cc/schemas';

type WorkstreamId = MeetingSeries['workstreamIds'][number];

/** The parts of an agenda section template (02 §3 `AgendaSectionTemplate`) composition reads. */
export interface AgendaSectionSpec {
  readonly id: string;
  readonly type: string;
  /** Solo mode, one workstream (02 §5.1). */
  readonly timeboxMinutes: number;
  /** The team and solo-merged columns of 02 §5.1, where they differ (02 §3). */
  readonly variants?:
    { readonly team?: number | undefined; readonly soloMerged?: number | undefined } | undefined;
  readonly minMinutes: number;
  readonly maxMinutes: number;
  readonly backbone: boolean;
  readonly perWorkstream: boolean;
}

export interface AgendaTemplateSpec {
  readonly id: string;
  readonly sections: readonly AgendaSectionSpec[];
  /** Extension slots for pack sections, e.g. "after:headlines". */
  readonly slots?: readonly string[];
}

type Mode = MeetingSeries['mode'];

/**
 * The default timebox of a section for a series (02 §5.1 columns): the team column in team mode,
 * the solo-merged column in a solo meeting of more than one workstream, otherwise the solo one.
 */
export function defaultTimebox(
  section: AgendaSectionSpec,
  mode: Mode | undefined,
  workstreamCount: number,
): number {
  if (mode === 'team') return section.variants?.team ?? section.timeboxMinutes;
  if (workstreamCount > 1) return section.variants?.soloMerged ?? section.timeboxMinutes;
  return section.timeboxMinutes;
}

/** One pack section to add into a slot (01 §4 `Pack.agendaSections`). */
export interface PackSectionSpec {
  readonly slot: string;
  readonly section: AgendaSectionSpec;
}

/**
 * The template with pack sections added into its extension slots. A section's minutes come first
 * from the section that follows it, down to that section's minimum, in every column: 02 §5.1
 * ("taken from `issues` first", the section after `headlines`) and §5.5 (without the pack,
 * `pipeline_review`'s minutes "go to `plan_commitments`", the section it precedes). The §4.4
 * fit then handles the rest. A pack section for a slot the template does not have is left out.
 */
export function withPackSections(
  template: AgendaTemplateSpec,
  additions: readonly PackSectionSpec[],
): AgendaTemplateSpec {
  const sections = [...template.sections];
  for (const { slot, section } of additions) {
    if (!(template.slots ?? []).includes(slot)) continue;
    if (sections.some((existing) => existing.id === section.id)) continue;
    const [where, anchor] = slot.split(':') as ['before' | 'after', string];
    const at = sections.findIndex((existing) => existing.id === anchor);
    if (at < 0) continue;
    const index = where === 'before' ? at : at + 1;
    sections.splice(index, 0, section);
    const donor = sections[index + 1];
    if (donor === undefined) continue;
    const take = (column: number | undefined) =>
      column === undefined
        ? undefined
        : Math.max(donor.minMinutes, column - section.timeboxMinutes);
    const team = take(donor.variants?.team);
    const soloMerged = take(donor.variants?.soloMerged);
    sections[index + 1] = {
      ...donor,
      timeboxMinutes: take(donor.timeboxMinutes) ?? donor.timeboxMinutes,
      ...(donor.variants === undefined
        ? {}
        : {
            variants: {
              ...(team === undefined ? {} : { team }),
              ...(soloMerged === undefined ? {} : { soloMerged }),
            },
          }),
    };
  }
  return { ...template, sections };
}

interface Row {
  readonly section: AgendaSectionSpec;
  readonly workstreamId?: WorkstreamId;
  readonly absorbedFrom?: MeetingInstance['id'];
  timebox: number;
}

/** The section order of 02 §4.4 rules 1 to 3. */
function expandSections(
  sections: readonly AgendaSectionSpec[],
  workstreamIds: readonly WorkstreamId[],
): { section: AgendaSectionSpec; workstreamId?: WorkstreamId }[] {
  const out: { section: AgendaSectionSpec; workstreamId?: WorkstreamId }[] = [];
  let index = 0;
  while (index < sections.length) {
    const section = sections[index];
    if (section === undefined) break;
    if (!section.perWorkstream) {
      out.push({ section });
      index++;
      continue;
    }
    const run: AgendaSectionSpec[] = [];
    while (sections[index]?.perWorkstream === true) {
      const next = sections[index];
      if (next !== undefined) run.push(next);
      index++;
    }
    for (const workstreamId of workstreamIds) {
      for (const s of run) out.push({ section: s, workstreamId });
    }
  }
  return out;
}

/** Rule 4: fits the rows' timeboxes to `minutes`; throws `E_AGENDA_FIT` when they cannot fit. */
function fit(rows: Row[], minutes: number, what: string): void {
  const minimum = rows.reduce((sum, row) => sum + row.section.minMinutes, 0);
  if (minimum > minutes) {
    throw new DomainError(
      'E_AGENDA_FIT',
      '02 §4.4',
      `${what}: the section minimums need ${minimum} minutes, more than ${minutes}`,
      [`smallest duration that fits: ${minimum} minutes`],
    );
  }
  let total = rows.reduce((sum, row) => sum + row.timebox, 0);
  for (const backbone of [false, true]) {
    while (total > minutes) {
      let pick: Row | undefined;
      for (const row of rows) {
        if (row.section.backbone !== backbone) continue;
        const room = row.timebox - row.section.minMinutes;
        if (room <= 0) continue;
        if (pick === undefined || room >= pick.timebox - pick.section.minMinutes) pick = row;
      }
      if (pick === undefined) break;
      pick.timebox--;
      total--;
    }
  }
}

function rows(
  template: AgendaTemplateSpec,
  workstreamIds: readonly WorkstreamId[],
  overrides: MeetingSeries['agendaOverrides'],
  mode: Mode | undefined,
  filter: (section: AgendaSectionSpec) => boolean,
  absorbedFrom?: MeetingInstance['id'],
): Row[] {
  return expandSections(template.sections.filter(filter), workstreamIds).map(
    ({ section, workstreamId }) => {
      const override = overrides.find((o) => o.sectionId === section.id)?.timeboxMinutes;
      const timebox =
        override === undefined
          ? defaultTimebox(section, mode, workstreamIds.length)
          : Math.min(section.maxMinutes, Math.max(section.minMinutes, override));
      return {
        section,
        timebox,
        ...(section.perWorkstream && workstreamId !== undefined ? { workstreamId } : {}),
        ...(absorbedFrom === undefined ? {} : { absorbedFrom }),
      };
    },
  );
}

/**
 * The composed agenda of one instance: its sections in order with fitted timeboxes, as the
 * `AgendaSectionInstance` rows the pre-read fills (inputs empty, status pending).
 */
export function composeAgenda(input: {
  readonly template: AgendaTemplateSpec;
  readonly series: Pick<MeetingSeries, 'workstreamIds' | 'durationMinutes' | 'agendaOverrides'> &
    Partial<Pick<MeetingSeries, 'mode'>>;
  /** The meetings this instance absorbs (02 §4.3), in order. */
  readonly absorbed?: readonly {
    readonly instanceId: MeetingInstance['id'];
    readonly template: AgendaTemplateSpec;
    readonly series: Pick<MeetingSeries, 'workstreamIds' | 'agendaOverrides'> &
      Partial<Pick<MeetingSeries, 'mode'>>;
    readonly absorbedMinutes: number;
  }[];
}): AgendaSectionInstance[] {
  const out: Row[] = [];
  for (const absorbed of input.absorbed ?? []) {
    const part = rows(
      absorbed.template,
      absorbed.series.workstreamIds,
      absorbed.series.agendaOverrides,
      absorbed.series.mode,
      (section) => section.backbone,
      absorbed.instanceId,
    );
    fit(part, absorbed.absorbedMinutes, `${absorbed.template.id} absorbed`);
    out.push(...part);
  }
  const own = rows(
    input.template,
    input.series.workstreamIds,
    input.series.agendaOverrides,
    input.series.mode,
    () => true,
  );
  fit(own, input.series.durationMinutes, input.template.id);
  out.push(...own);
  return out.map((row) => ({
    sectionId: row.section.id,
    ...(row.workstreamId === undefined ? {} : { workstreamId: row.workstreamId }),
    ...(row.absorbedFrom === undefined ? {} : { absorbedFrom: row.absorbedFrom }),
    timeboxMinutes: row.timebox,
    inputResults: [],
    status: 'pending' as const,
  }));
}
