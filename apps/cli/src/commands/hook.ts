/**
 * `cc-axi hook session-start` (07 §8 item 2): the ambient context an installed SessionStart
 * hook prints at the start of every agent session. At most 20 lines (C-07-05): the workspace,
 * today's meetings, the attention counts, and the top 3 items of the workstream mapped to the
 * current directory, then one help line.
 *
 * What the principal may not see is never fetched: the core leaves sensitive workstreams out
 * of every list and count unless the principal has `sensitiveAccess` (07 §5), so such a
 * workstream cannot be mapped and none of its items can appear.
 *
 * A hook must not break the agent's session: every outcome exits 0, and an error (the app
 * not running, most often) prints as the usual `error:`, `code:` and `help:` lines.
 */
import { describeError } from '../errors.js';
import { homeDirOf } from '../hooks.js';
import { countLine, table, type Output } from '../render.js';
import { workstreamForDirectory, type RepoMatch } from '../repo-map.js';
import type {
  Handler,
  HomeResult,
  ItemsListResult,
  Session,
  WorkstreamResult,
  WorkstreamsListResult,
} from './common.js';

/** The most lines the hook prints (07 §8 item 2, C-07-05). */
export const MAX_HOOK_LINES = 20;

/** Meetings listed before the rest are counted, so the output stays within its lines. */
export const MAX_HOOK_MEETINGS = 8;

/** Items shown for the mapped workstream (07 §8 item 2). */
export const HOOK_ITEMS = 3;

type ItemRow = ItemsListResult['items'][number];

/** What the hook shows; built from local API results, rendered by `sessionStartView`. */
export interface SessionStartData {
  readonly home: HomeResult;
  /** The workstream mapped to the directory, with its top items and its total. */
  readonly mapped?: { match: RepoMatch; items: readonly ItemRow[]; total: number };
}

/** The hook output, laid out to stay within MAX_HOOK_LINES whatever the data. */
export function sessionStartView(data: SessionStartData): Output {
  const { home, mapped } = data;
  const output: Output = { workspace: home.workspace };
  const meetings = home.today.slice(0, MAX_HOOK_MEETINGS);
  output['today'] =
    meetings.length === 0
      ? '0 meetings today'
      : table(
          meetings.map((meeting) => ({
            ref: meeting.ref,
            time: meeting.time,
            meeting: meeting.title,
          })),
          ['ref', 'time', 'meeting'],
        );
  if (home.today.length > meetings.length) {
    output['meetings'] = `${meetings.length} of ${home.today.length} meetings today`;
  }
  const attention = home.attention;
  output['attention'] =
    `${attention.overdue} overdue, ${attention.atRisk} at risk, ` +
    `${attention.awaitingReview} awaiting review, ${attention.confirmationsPending} confirmations pending`;

  if (mapped === undefined) {
    output['workstream'] = 'none mapped to this directory';
    const noun = 'items overdue or due within 7 days';
    if (home.items.length === 0) {
      output['items'] = `0 ${noun}`;
    } else {
      output['items'] = table(home.items, ['ref', 'title', 'due', 'state']);
      output['count'] = countLine(home.items.length, home.counts.dueSoon, noun);
    }
    output['help'] = [
      'Command Center: run `cc-axi` for the home view, or `cc-axi items list` for every active item',
    ];
    return output;
  }

  const slug = mapped.match.slug;
  output['workstream'] = slug;
  const noun = `active items in workstream ${slug}`;
  if (mapped.items.length === 0) {
    output['items'] = `0 ${noun}`;
  } else {
    output['items'] = table(mapped.items, ['ref', 'title', 'due', 'state']);
    output['count'] = countLine(mapped.items.length, mapped.total, noun);
  }
  output['help'] = [
    `Command Center: run \`cc-axi items list --workstream ${slug}\` for all of them, or \`cc-axi\` for the home view`,
  ];
  return output;
}

async function gather(session: Session): Promise<SessionStartData> {
  const api = await session.api();
  const [home, listed] = await Promise.all([
    api.call<HomeResult>('home.get', {}),
    api.call<WorkstreamsListResult>('workstreams.list', { limit: 10_000 }),
  ]);
  const workstreams = await Promise.all(
    listed.workstreams.map(async (entry) => {
      const result = await api.call<WorkstreamResult>('workstreams.get', {
        workstream: entry.slug,
      });
      return { slug: result.workstream.slug, repoPaths: result.workstream.repoPaths };
    }),
  );
  const match = workstreamForDirectory(session.cwd, workstreams, homeDirOf(session.env));
  if (match === undefined) return { home };
  const items = await api.call<ItemsListResult>('items.list', {
    workstream: match.slug,
    state: 'active',
    limit: HOOK_ITEMS,
  });
  return { home, mapped: { match, items: items.items, total: items.total } };
}

export const hookSessionStart: Handler = async (_parsed, session) => {
  try {
    return sessionStartView(await gather(session));
  } catch (error) {
    const { code, message, help } = describeError(error);
    if (code === 'E_APP_NOT_RUNNING') {
      return {
        command_center: 'not running',
        help: ['Open Command Center, then run `cc-axi` for the home view'],
      };
    }
    return { error: message, code, help };
  }
};
