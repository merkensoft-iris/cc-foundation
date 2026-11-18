/**
 * Connector actions and confirmations for the MCP relay (07 §7): `cc_connector_actions`,
 * `cc_connector_invoke` and `cc_confirmation_status`. They follow the `cc-axi connectors
 * actions | invoke` and `cc-axi confirmations view | wait` lines of 07 §4.2 and the output of
 * 07 §4.3, but those CLI commands arrive with the connector platform (P2), so only the relay
 * runs these handlers (apps/cli/src/mcp/routes.ts).
 *
 * Until P2-02 no connector is installed: the actions list is the definitive empty message,
 * and an invoke is `E_NOT_FOUND` from the core. No handler here approves or denies anything:
 * that is human-only (04 §4.3).
 */
import { positiveInt, single } from '../args.js';
import { usageError } from '../errors.js';
import { countLine, table, truncate, type Output } from '../render.js';
import {
  defined,
  type ConfirmationResult,
  type ConfirmationWaitResult,
  type ConnectorActionsResult,
  type ConnectorInvokeResult,
  type Handler,
} from './common.js';

/** The deep link of a confirmation (04 §4.3 rule 3). */
export function confirmationLink(id: string): string {
  return `commandcenter://confirmations/${id}`;
}

export const connectorsActions: Handler = async (parsed, session) => {
  const binding = single(parsed, '--binding');
  const api = await session.api();
  const result = await api.call<ConnectorActionsResult>('connectors.actions', defined({ binding }));
  const noun = `connector actions${binding === undefined ? '' : ` for binding ${binding}`}`;
  if (result.actions.length === 0) {
    return {
      actions: `0 ${noun}`,
      help: ['No connector is installed until phase 2 (P2-02)'],
    };
  }
  return {
    actions: table(result.actions, ['binding', 'action', 'risk']),
    count: countLine(result.actions.length, result.total, noun),
    help: [
      'Call cc_connector_invoke with a binding and action; an outward action waits for the user',
    ],
  };
};

export const connectorsInvoke: Handler = async (parsed, session) => {
  const [binding = '', action = ''] = parsed.positionals;
  const raw = single(parsed, '--input');
  let input: Record<string, unknown> | undefined;
  if (raw !== undefined) {
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      input = undefined;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw usageError('input must be a JSON object', ['input takes an object such as {"q": "x"}']);
    }
  }
  const api = await session.api();
  const result = await api.call<ConnectorInvokeResult>(
    'connectors.invoke',
    defined({ binding, action, input, waitSeconds: positiveInt(parsed, '--wait') }),
  );
  const view: Output = { binding: result.binding, action: result.action, status: result.status };
  if (result.runId !== undefined) view['run'] = result.runId;
  if (result.confirmation !== undefined) view['confirmation'] = result.confirmation;
  if (result.expires !== undefined) view['expires'] = result.expires;
  if (result.output !== undefined) view['output'] = result.output as Output;
  const output: Output = { invoke: view };
  if (result.status === 'pending_confirmation' && result.confirmation !== undefined) {
    output['help'] = [
      `Approve or deny it in the app: ${confirmationLink(result.confirmation)}`,
      `Call cc_confirmation_status with id ${result.confirmation} and wait 600 to wait for the decision`,
    ];
  }
  return output;
};

function confirmationView(confirmation: ConfirmationResult['confirmation']): {
  view: Output;
  truncated: boolean;
} {
  const subject = confirmation.subject;
  const view: Output = {
    id: confirmation.id,
    status: confirmation.status,
    subject:
      subject.kind === 'connector_action'
        ? `${subject.action} on ${subject.bindingId} (${subject.risk})`
        : subject.kind === 'discovery_step'
          ? `${subject.description} (${subject.risk})`
          : subject.kind === 'calendar_batch'
            ? `${String(subject.eventCount)} calendar events in ${subject.calendarId}`
            : `a browser session for ${subject.service}`,
    expires: confirmation.expiresAt,
  };
  if (confirmation.actionItemId !== undefined) view['action_item'] = confirmation.actionItemId;
  const preview = truncate(confirmation.payloadPreview, false);
  view['preview'] = preview.text;
  if (confirmation.decidedAt !== undefined) view['decided_at'] = confirmation.decidedAt;
  if (confirmation.decisionNote !== undefined) view['note'] = confirmation.decisionNote;
  return { view, truncated: preview.truncated };
}

function confirmationHelp(id: string, status: string, truncated: boolean): string[] | undefined {
  const help: string[] = [];
  if (status === 'pending') help.push(`Approve or deny it in the app: ${confirmationLink(id)}`);
  else if (truncated) help.push(`The full preview is in the app: ${confirmationLink(id)}`);
  return help.length === 0 ? undefined : help;
}

export const confirmationsView: Handler = async (parsed, session) => {
  const id = parsed.positionals[0] ?? '';
  const api = await session.api();
  const { confirmation } = await api.call<ConfirmationResult>('confirmations.get', { id });
  const { view, truncated } = confirmationView(confirmation);
  const help = confirmationHelp(confirmation.id, confirmation.status, truncated);
  return help === undefined ? { confirmation: view } : { confirmation: view, help };
};

export const confirmationsWait: Handler = async (parsed, session) => {
  const id = parsed.positionals[0] ?? '';
  const timeoutSeconds = positiveInt(parsed, '--timeout') ?? 0;
  if (timeoutSeconds > 600) {
    throw usageError(`invalid value "${String(timeoutSeconds)}" for --timeout`, [
      '--timeout takes seconds from 1 to 600',
    ]);
  }
  const api = await session.api();
  const result = await api.call<ConfirmationWaitResult>(
    'confirmations.wait',
    { id, timeoutSeconds },
    { timeoutMs: (timeoutSeconds + 30) * 1000 },
  );
  const { view, truncated } = confirmationView(result.confirmation);
  view['timed_out'] = result.timedOut;
  const help = confirmationHelp(result.confirmation.id, result.confirmation.status, truncated);
  return help === undefined ? { confirmation: view } : { confirmation: view, help };
};
