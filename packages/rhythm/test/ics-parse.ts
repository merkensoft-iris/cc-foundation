/**
 * Reads an .ics export back with ical.js, the test-only parser of ADR 0001 decision 3 (a
 * devDependency of @cc/rhythm, never shipped). The core's tests import it from here.
 */
import ICAL from 'ical.js';

export interface ParsedEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
  readonly description: string;
  readonly alarms: number;
}

const utc = (time: ICAL.Time): string =>
  new Date(time.toUnixTime() * 1000).toISOString().replace('.000Z', 'Z');

/** Parses a VCALENDAR and returns its VEVENTs in file order. */
export function parseIcs(text: string): ParsedEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(text));
  return calendar.getAllSubcomponents('vevent').map((component) => {
    const event = new ICAL.Event(component);
    return {
      uid: event.uid,
      sequence: event.sequence,
      start: utc(event.startDate),
      end: utc(event.endDate),
      summary: event.summary,
      description: event.description,
      alarms: component.getAllSubcomponents('valarm').length,
    };
  });
}
