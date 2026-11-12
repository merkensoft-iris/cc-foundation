/**
 * The home view (07 §4.3, AXI principle 8): what is live now. `cc-axi` with no arguments and
 * `cc-axi home` (ADR 0002 follow-up 2) print it.
 */
import { addDays, countLine, table, type Output } from '../render.js';
import type { Handler, HomeResult, Session } from './common.js';

export async function homeView(session: Session): Promise<Output> {
  const api = await session.api();
  const home = await api.call<HomeResult>('home.get', {});
  const today = home.now.slice(0, 10);
  const output: Output = { workspace: home.workspace, now: home.now };
  output['today'] =
    home.today.length === 0
      ? '0 meetings today'
      : table(
          home.today.map((meeting) => ({
            ref: meeting.ref,
            time: meeting.time,
            meeting: meeting.title,
          })),
          ['ref', 'time', 'meeting'],
        );
  output['attention'] = {
    overdue: home.attention.overdue,
    at_risk: home.attention.atRisk,
    awaiting_review: home.attention.awaitingReview,
    confirmations_pending: home.attention.confirmationsPending,
    sessions_needing_you: home.attention.sessionsNeedingYou,
  };
  const noun = `items overdue or due within 7 days (${home.counts.open} open in total)`;
  const help: string[] = [];
  if (home.items.length === 0) {
    output['items'] = `0 ${noun}`;
  } else {
    output['items'] = table(home.items, ['ref', 'title', 'due', 'state']);
    output['count'] = countLine(home.items.length, home.counts.dueSoon, noun);
    help.push('Run `cc-axi items view <ref>` for details');
  }
  if (home.counts.dueSoon > home.items.length) {
    help.push(
      `Run \`cc-axi items list --due-before ${addDays(today, 7)}\` for all ${home.counts.dueSoon}`,
    );
  } else if (home.counts.open > home.items.length) {
    help.push(`Run \`cc-axi items list\` for all ${home.counts.open} open items`);
  }
  if (help.length > 0) output['help'] = help;
  return output;
}

/** `cc-axi home`: the same view with the header the SDK adds to the no-argument call. */
export const homeCommand: Handler = async (_parsed, session) => homeView(session);
