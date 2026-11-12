/**
 * Meetings on the workspace store (P1-08; 02 §6): the pre-read job writes both blobs and
 * records their hashes, a meeting runs from start through capture and read-back to close, each
 * step one transaction with one event per write, C-02-03 and C-02-04 hold on SQLite, and export
 * carries the pre-read blobs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extendHorizon } from '@cc/rhythm';
import type { ActionItem, MeetingInstance, MeetingSeries } from '@cc/schemas';
import { blobPath, exportWorkspace, openStore, type Store } from '@cc/store';
import { createProfileDir, FakeTimerClock } from '@cc/test-kit';

import { Meetings, sha256 } from '../src/meetings.js';
import { storeRhythmStore } from '../src/rhythm-store.js';
import { harness, scenarioPlacement, seriesById } from '../../rhythm/test/harness.ts';
import { seedWorkspace } from './helpers.js';

const opened: (() => void)[] = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

const user = { actor: { kind: 'user' as const } };
const agent = {
  actor: { kind: 'agent' as const, principalId: 'agt_cli_default' as const },
  scopes: ['read' as const, 'meetings:capture' as const],
};

interface World {
  readonly db: Store;
  readonly clock: FakeTimerClock;
  readonly meetings: Meetings;
  readonly profile: string;
  instance(local: string, seriesId?: string): MeetingInstance;
}

/** The reference records, the CEO review series and their instances, on a fresh store. */
function world(now: string): World {
  const profile = createProfileDir();
  let tick = 0;
  const db = openStore({
    userDataDir: profile.path,
    now: () => new Date(Date.parse('2026-11-04T04:10:00Z') + tick++ * 1000).toISOString(),
    random: (size) => Uint8Array.from({ length: size }, (_, index) => (tick + index) % 251),
    env: {},
  });
  opened.push(() => {
    db.close();
    profile.cleanup();
  });
  seedWorkspace(db);
  const series: MeetingSeries[] = [seriesById('ser_ceo_weekly'), seriesById('ser_ceo_monthly')];
  db.command({ actor: { kind: 'user' } }, (tx) => {
    for (const record of series) {
      tx.insert('meeting_series', record);
      tx.event({
        type: 'meeting_series.created',
        entity: { kind: 'meeting_series', id: record.id },
      });
    }
  });
  extendHorizon(storeRhythmStore(db), harness('2026-11-04T04:10:00Z').ctx, scenarioPlacement());
  const clock = new FakeTimerClock(now);
  const meetings = new Meetings(db, { clock });
  return {
    db,
    clock,
    meetings,
    profile: profile.path,
    instance(local, seriesId = 'ser_ceo_weekly') {
      const zone = 'Asia/Kolkata';
      const found = db
        .read((tx) => tx.list('meeting_instances'))
        .find(
          (i) =>
            i.seriesId === seriesId &&
            new Date(i.scheduledStart)
              .toLocaleString('sv-SE', { timeZone: zone })
              .slice(0, 16)
              .replace(' ', 'T') === local,
        );
      if (found === undefined) throw new Error(`no instance ${seriesId} ${local}`);
      return found;
    },
  };
}

function rejection(run: () => unknown): {
  code?: string;
  message: string;
  help?: readonly string[];
} {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a rejection');
}

describe('pre-reads on the workspace store (02 §6.2)', () => {
  it('the job prepares the instances due, stores both blobs and records their hashes', () => {
    const w = world('2026-11-12T09:30:00Z');
    const events = w.db.read((tx) => tx.count('events'));
    const result = w.meetings.runPrereads();
    const weekly = w.instance('2026-11-13T15:00');
    expect(result).toEqual({ prepared: [weekly.ref], notify: [] });
    expect(weekly.state).toBe('prepared');
    const preread = weekly.preread;
    if (preread === undefined) throw new Error('no pre-read');
    const blobs = join(w.profile, 'blobs');
    const json = readFileSync(blobPath(blobs, preread.snapshotSha256), 'utf8');
    const markdown = readFileSync(blobPath(blobs, preread.renderedSha256), 'utf8');
    expect(sha256(json)).toBe(preread.snapshotSha256);
    expect(sha256(markdown)).toBe(preread.renderedSha256);
    expect(markdown.startsWith('# Pre-read: Weekly CEO review\n')).toBe(true);
    expect(JSON.parse(json).instance.id).toBe(weekly.id);
    expect(weekly.agenda.map((row) => row.sectionId)).toContain('content_review');
    expect(w.db.read((tx) => tx.count('events'))).toBe(events + 1);
    expect(w.db.read((tx) => tx.history('meeting_instance', weekly.id)).map((e) => e.type)).toEqual(
      ['meeting_instance.materialised', 'meeting_instance.prepared'],
    );
    // Nothing else is due, and a prepared instance is not prepared again by the job.
    expect(w.meetings.runPrereads()).toEqual({ prepared: [], notify: [] });
    expect(w.meetings.prepare(user, weekly.ref).status).toBe('no-op');
  });

  it('C-02-03 after start the pre-read is immutable on the store too', async () => {
    const w = world('2026-11-12T09:30:00Z');
    w.meetings.runPrereads();
    const weekly = w.instance('2026-11-13T15:00');
    await w.clock.advance(24 * 60 * 60 * 1000);
    expect(w.meetings.start(user, weekly.ref).state).toBe('in_progress');
    const refused = rejection(() => w.meetings.prepare(user, weekly.ref));
    expect([refused.code, refused.message]).toEqual([
      'E_INVARIANT',
      `${weekly.ref} has started; its pre-read is immutable`,
    ]);
    expect(w.instance('2026-11-13T15:00').preread).toEqual(weekly.preread);
  });

  it('export carries the pre-read blobs (03 §12 point 6)', () => {
    const w = world('2026-11-12T09:30:00Z');
    w.meetings.runPrereads();
    const preread = w.instance('2026-11-13T15:00').preread;
    const out = createProfileDir();
    opened.push(() => out.cleanup());
    const result = exportWorkspace(w.db, { outDir: out.path });
    const exported = result.manifest.blobs.map((b) => b.sha256);
    expect(exported).toContain(preread?.snapshotSha256);
    expect(exported).toContain(preread?.renderedSha256);
    expect(result.manifest.missingBlobs).toEqual([]);
  });
});

describe('a meeting from start to close (02 §6.3, §6.4)', () => {
  it('starting before the pre-read time builds the snapshot in the same transaction', () => {
    const w = world('2026-11-27T09:00:00Z');
    const monthly = w.instance('2026-11-27T15:00', 'ser_ceo_monthly');
    expect(monthly.absorbedInstanceIds).toHaveLength(1);
    const events = w.db.read((tx) => tx.count('events'));
    const started = w.meetings.start(user, monthly.ref);
    expect(started.state).toBe('in_progress');
    expect(started.preread).toBeDefined();
    expect(
      started.agenda
        .filter((row) => row.absorbedFrom !== undefined)
        .reduce((s, r) => s + r.timeboxMinutes, 0),
    ).toBe(30);
    expect(w.db.read((tx) => tx.count('events'))).toBe(events + 2);
    const agentStart = rejection(() => w.meetings.start(agent, w.instance('2026-11-20T15:00').ref));
    expect(agentStart.code).toBe('E_FORBIDDEN');
  });

  it('captures, reads back and closes, each step one transaction; C-02-04 refuses an early close', async () => {
    const w = world('2026-11-12T09:30:00Z');
    w.meetings.runPrereads();
    await w.clock.advance(24 * 60 * 60 * 1000);
    const ref = w.instance('2026-11-13T15:00').ref;
    w.meetings.start(user, ref);

    const captured = w.meetings.capture(
      user,
      ref,
      { sectionId: 'issues' },
      {
        kind: 'action_item',
        item: {
          workstreamId: 'ws_ald',
          title: 'Send the consulting lead the phased plan',
          doneMeans: 'The consulting lead has the phased plan in their inbox.',
          due: { date: '2026-11-20', timeZone: 'Asia/Kolkata' },
        },
      },
    );
    const draft = captured.record as ActionItem;
    expect(draft.lifecycle).toBe('draft');
    expect(draft.ref).toMatch(/^A-\d{4}$/);
    const byAgent = w.meetings.capture(
      agent,
      ref,
      { sectionId: 'headlines' },
      { kind: 'note', text: 'Pilot signed' },
    );
    expect(byAgent.instance.notes).toBe('[headlines] Pilot signed');
    const reading = w.meetings.capture(
      user,
      ref,
      { sectionId: 'scorecard', workstreamId: 'ws_ald' },
      {
        kind: 'measure_value',
        measureRef: 'K-0003',
        periodStart: '2026-11-09',
        normal: false,
        note: 'One lead; the second meeting moved to next week.',
      },
    );
    expect(reading.status).toBe('no-op');
    const newValue = w.meetings.capture(
      user,
      ref,
      { sectionId: 'scorecard', workstreamId: 'ws_ald' },
      {
        kind: 'measure_value',
        measureRef: 'K-0003',
        periodStart: '2026-11-02',
        value: 2,
        normal: true,
      },
    );
    expect(newValue.status).toBe('ok');
    expect(
      w.db
        .read((tx) => tx.list('measure_values'))
        .map((v) => v.periodStart)
        .sort(),
    ).toEqual(['2026-11-02', '2026-11-09']);

    expect(w.meetings.readBack(ref).map((line) => [line.ref, line.state])).toEqual([
      [draft.ref, 'draft'],
    ]);
    const early = rejection(() => w.meetings.close(user, ref));
    expect(early.code).toBe('E_INVARIANT');
    expect(early.message).toContain('read-back is not confirmed');

    const agentReadBack = rejection(() => w.meetings.confirmReadBack(agent, ref));
    expect(agentReadBack.code).toBe('E_HUMAN_REQUIRED');

    const events = w.db.read((tx) => tx.count('events'));
    const readBack = w.meetings.confirmReadBack(user, ref);
    expect(readBack.accepted).toEqual([draft.ref]);
    expect(w.db.read((tx) => tx.count('events'))).toBe(events + 2);
    expect(w.db.read((tx) => tx.get('action_items', draft.id))?.lifecycle).toBe('open');

    const closed = w.meetings.close(user, ref);
    expect(closed.record.state).toBe('completed');
    const stored = w.instance('2026-11-13T15:00');
    expect([stored.state, stored.readBackConfirmedAt, stored.outputs.actionItemIds]).toEqual([
      'completed',
      '2026-11-13T09:30:00.000Z',
      [draft.id],
    ]);
    expect(w.db.read((tx) => tx.history('meeting_instance', stored.id)).map((e) => e.type)).toEqual(
      [
        'meeting_instance.materialised',
        'meeting_instance.prepared',
        'meeting_instance.started',
        'meeting_instance.output_captured',
        'meeting_instance.output_captured',
        'meeting_instance.output_captured',
        'meeting_instance.read_back_confirmed',
        'meeting_instance.completed',
      ],
    );
    expect(existsSync(join(w.profile, 'blobs'))).toBe(true);
  });
});
