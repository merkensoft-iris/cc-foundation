/**
 * The calendar mapping check of docs/design/02-rhythm-and-calendar.md §9.6 rule 4 (P1-20,
 * AC-02-12): every route's binding must implement `calendar@1`, and every series that the
 * mapping routes anywhere has exactly one primary target. Pure: it reads the mapping, the S7
 * tool answers and the planned series, and returns the violations; the caller refuses the
 * write (`E_INVARIANT`, nothing written).
 *
 * Before P2 there is no binding record and no installed connector manifest, so a binding label
 * implements `calendar@1` when it names an S7 tool answer (by account label, else tool name) of
 * category `calendar` whose choice is a connector listed in the mapping's `providers`. Once
 * bindings exist (P2), the label resolves to a binding and the check reads its connector's
 * declared contracts instead. The third clause of rule 4 (a sensitive workstream never routes
 * to a calendar whose binding is shared with another account owner) needs binding ownership,
 * which P2 brings; it is not checked here.
 */
import type { CalendarMapping, ToolAnswer } from '@cc/schemas';

/** The route key of the portfolio series (02 §4.5). */
export const PORTFOLIO_ROUTE_KEY = 'portfolio';

export interface MappedSeries {
  readonly name: string;
  /** Workstream keys; ignored for a portfolio series, which routes as "portfolio". */
  readonly workstreamKeys: readonly string[];
  /** `backboneMeetingKey`, e.g. "weekly" or "portfolio.daily-start". */
  readonly backboneMeetingKey: string;
}

export interface CalendarMappingViolation {
  readonly kind: 'binding_not_calendar' | 'primary_count';
  readonly text: string;
}

function routeKeys(series: MappedSeries): readonly string[] {
  return series.backboneMeetingKey.startsWith(`${PORTFOLIO_ROUTE_KEY}.`)
    ? [PORTFOLIO_ROUTE_KEY]
    : series.workstreamKeys;
}

/** The violations of 02 §9.6 rule 4; empty when the mapping is valid. */
export function checkCalendarMapping(
  mapping: CalendarMapping,
  tools: readonly ToolAnswer[],
  series: readonly MappedSeries[],
): CalendarMappingViolation[] {
  const out: CalendarMappingViolation[] = [];
  const providers = new Set(mapping.providers);
  const implementsCalendar = (binding: string): boolean =>
    tools.some(
      (tool) =>
        (tool.accountLabel ?? tool.toolName) === binding &&
        tool.category === 'calendar' &&
        tool.choice.kind === 'connector' &&
        providers.has(tool.choice.connectorId),
    );

  const reported = new Set<string>();
  for (const route of mapping.routes) {
    for (const target of route.targets) {
      if (reported.has(target.binding) || implementsCalendar(target.binding)) continue;
      reported.add(target.binding);
      out.push({
        kind: 'binding_not_calendar',
        text: `The binding "${target.binding}" does not implement calendar@1: no S7 calendar tool with that label uses a connector listed in the mapping's providers (${mapping.providers.join(', ') || 'none'}).`,
      });
    }
  }

  for (const one of series) {
    const keys = routeKeys(one);
    const targets = new Map<string, 'primary' | 'mirror'>();
    for (const route of mapping.routes) {
      if (route.workstreams !== 'all' && !keys.some((key) => route.workstreams.includes(key))) {
        continue;
      }
      for (const target of route.targets) {
        const id = `${target.binding}\u0000${target.calendar}`;
        if (targets.get(id) !== 'primary') targets.set(id, target.role);
      }
    }
    if (targets.size === 0) continue; // not routed: .ics export only (02 §9.1)
    const primaries = [...targets.values()].filter((role) => role === 'primary').length;
    if (primaries !== 1) {
      out.push({
        kind: 'primary_count',
        text: `${one.name} has ${primaries === 0 ? 'no primary calendar target' : `${String(primaries)} primary calendar targets`}; a series has exactly one primary (02 §9.4).`,
      });
    }
  }
  return out;
}
