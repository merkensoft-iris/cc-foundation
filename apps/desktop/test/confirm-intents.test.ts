/**
 * Tier H confirmations in the shell (04 §4.3 rule 4, C-04-12, AC-04-15): main approves a
 * core intent with `approve-intent` on the core-host channel, never on the UI port; the core
 * host runs it on the real core; and main's temporary prompt page (`confirm-prompt.ts`) shows
 * the core's preview and answers only in its own window.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { silentLogger } from '@cc/core';
import { createProfileDir } from '@cc/test-kit';
import { describe, expect, it } from 'vitest';

import {
  runCoreHost,
  type CoreLike,
  type HostPort,
  type ParentPort,
} from '../src/core-host/host.js';
import { realCore } from '../src/core-host/real-core.js';
import { resolveAppRequest } from '../src/main/app-protocol.js';
import {
  confirmChoice,
  confirmPage,
  confirmPromptOf,
  CONFIRM_PATH,
} from '../src/main/confirm-prompt.js';
import {
  CoreSupervisor,
  UiCallError,
  type CoreLauncher,
  type CoreProcess,
  type MainPort,
} from '../src/main/core-supervisor.js';
import {
  isNeedsConfirmation,
  parseHostMessage,
  type HostToMain,
  type MainToHost,
  type NeedsConfirmation,
} from '../src/shared/protocol.js';
import { fakeChannel, settle, timerClock, type FakePort } from './fakes.js';

const INTENT = {
  id: 'cfi_01KA0000000000000000000000',
  method: 'backups.restore',
  preview: 'Restore your workspace from the backup bkp_01KA0000000000000000000000.',
  payloadHash: `sha256:${'b'.repeat(64)}`,
  expiresAt: '2026-11-13T05:35:00.000Z',
};

class FakeCore extends EventEmitter implements CoreProcess {
  readonly received: MainToHost[] = [];
  port: FakePort | undefined;
  /** Every message the UI port carried to the core. */
  readonly uiMessages: unknown[] = [];
  postMessage(message: MainToHost, transfer: MainPort[] = []): void {
    this.received.push(message);
    if (message.type === 'init') {
      this.port = transfer[0] as FakePort;
      this.port.on('message', ({ data }: { data: unknown }) => this.uiMessages.push(data));
      this.port.start();
    }
    if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0));
  }
  say(message: HostToMain): void {
    this.emit('message', message);
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 9));
    return true;
  }
}

function supervised() {
  const cores: FakeCore[] = [];
  const launcher: CoreLauncher = {
    fork: () => {
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    channel: fakeChannel,
  };
  const supervisor = new CoreSupervisor({
    launcher,
    userData: '/tmp/cc-test-profile',
    clock: timerClock('2026-11-13T05:30:00Z'),
  });
  supervisor.start({ kind: 'normal' });
  const core = cores[0] as FakeCore;
  core.say({ type: 'ready' });
  const approvals = () =>
    core.received.filter(
      (message): message is Extract<MainToHost, { type: 'approve-intent' }> =>
        message.type === 'approve-intent',
    );
  return { supervisor, cores, core, approvals };
}

async function refusal(promise: Promise<unknown>): Promise<UiCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiCallError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('approve-intent between main and the core host (C-04-12)', () => {
  it('C-04-12 main approves on the core-host channel, never on the UI port, and gets the result or the refusal', async () => {
    const { supervisor, core, approvals } = supervised();
    const approved = supervisor.approveIntent(INTENT.id, INTENT.payloadHash);
    const [sent] = approvals();
    expect(sent).toEqual({
      type: 'approve-intent',
      id: expect.any(Number) as number,
      intentId: INTENT.id,
      payloadHash: INTENT.payloadHash,
    });
    core.say({ type: 'intent-result', id: sent?.id ?? 0, result: { status: 'ok' } });
    await expect(approved).resolves.toEqual({ status: 'ok' });

    const refused = supervisor.approveIntent(INTENT.id, INTENT.payloadHash);
    const error = { code: 'E_NOT_FOUND', message: 'no pending confirmation', help: [] };
    core.say({ type: 'intent-result', id: approvals()[1]?.id ?? 0, error });
    expect((await refusal(refused)).data).toEqual(error);

    supervisor.denyIntent(INTENT.id);
    expect(core.received.at(-1)).toEqual({ type: 'deny-intent', intentId: INTENT.id });
    await settle();
    expect(core.uiMessages).toEqual([]);
  });

  it('04 §9.1 rule 9: a restart waits for the confirmed restore to answer', async () => {
    const { supervisor, cores, core, approvals } = supervised();
    const approved = supervisor.approveIntent(INTENT.id, INTENT.payloadHash);
    // The restore asks for the restart before its answer reaches main.
    core.say({ type: 'restart', reason: 'restore' });
    supervisor.restart();
    await settle();
    expect(core.received.map((message) => message.type)).not.toContain('stop');
    core.say({ type: 'intent-result', id: approvals()[0]?.id ?? 0, result: { status: 'ok' } });
    await expect(approved).resolves.toEqual({ status: 'ok' });
    await settle(20);
    expect(core.received.at(-1)).toEqual({ type: 'stop' });
    expect(cores).toHaveLength(2);
  });

  it('a core that crashes fails the approval waiting on it with E_CRASH', async () => {
    const { supervisor, core } = supervised();
    const approved = supervisor.approveIntent(INTENT.id, INTENT.payloadHash);
    core.emit('exit', 1);
    expect((await refusal(approved)).data.code).toBe('E_CRASH');
  });

  it('checks intent results like every host message', () => {
    expect(parseHostMessage({ type: 'intent-result', id: 1, result: null })).toBeDefined();
    expect(parseHostMessage({ type: 'intent-result', id: 'x', result: 1 })).toBeUndefined();
    expect(parseHostMessage({ type: 'intent-result', id: 1, error: { code: 1 } })).toBeUndefined();
    const answer: NeedsConfirmation = { status: 'needs_confirmation', intent: INTENT };
    expect(isNeedsConfirmation(answer)).toBe(true);
    expect(isNeedsConfirmation({ status: 'needs_confirmation', intent: { id: 'x' } })).toBe(false);
  });
});

class FakeParent extends EventEmitter implements ParentPort {
  readonly sent: HostToMain[] = [];
  postMessage(message: HostToMain): void {
    this.sent.push(message);
  }
  deliver(data: unknown, ports: HostPort[] = []): void {
    this.emit('message', { data, ports });
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the core host runs approved intents (C-04-12)', () => {
  it('passes approve-intent and deny-intent to the core, and answers with intent-result', async () => {
    const seen: string[] = [];
    const core: CoreLike = {
      serveUi: () => undefined,
      approveIntent: (intentId, payloadHash) => {
        seen.push(`approve ${intentId} ${payloadHash}`);
        if (payloadHash !== INTENT.payloadHash) {
          return Promise.reject(
            Object.assign(new Error('another payload'), {
              code: 'E_PAYLOAD_CHANGED',
              help: ['again'],
            }),
          );
        }
        return Promise.resolve({ status: 'ok' });
      },
      denyIntent: (intentId) => void seen.push(`deny ${intentId}`),
      stop: () => Promise.resolve(),
    };
    const parent = new FakeParent();
    runCoreHost({
      parentPort: parent,
      startCore: () => Promise.resolve(core),
      exit: () => undefined,
    });
    parent.deliver({ type: 'init', userData: '/tmp/cc-test-x', mode: { kind: 'normal' } }, [
      fakeChannel().port2,
    ]);
    await settle();
    parent.deliver({
      type: 'approve-intent',
      id: 3,
      intentId: INTENT.id,
      payloadHash: INTENT.payloadHash,
    });
    parent.deliver({ type: 'approve-intent', id: 4, intentId: INTENT.id, payloadHash: 'sha256:0' });
    parent.deliver({ type: 'approve-intent', id: 5, intentId: 7 });
    parent.deliver({ type: 'deny-intent', intentId: INTENT.id });
    await settle(20);
    expect(seen).toEqual([
      `approve ${INTENT.id} ${INTENT.payloadHash}`,
      `approve ${INTENT.id} sha256:0`,
      `deny ${INTENT.id}`,
    ]);
    expect(parent.sent.filter((message) => message.type === 'intent-result')).toEqual([
      { type: 'intent-result', id: 3, result: { status: 'ok' } },
      {
        type: 'intent-result',
        id: 4,
        error: { code: 'E_PAYLOAD_CHANGED', message: 'another payload', help: ['again'] },
      },
    ]);
  });

  it('AC-04-15 C-04-12 on the real core, a revoke from the UI port changes nothing until main approves it over the host channel', async () => {
    const profile = createProfileDir();
    try {
      const parent = new FakeParent();
      const exits: number[] = [];
      runCoreHost({
        parentPort: parent,
        startCore: realCore({ tmpRoot: profile.path, logger: silentLogger }),
        exit: (code) => exits.push(code),
      });
      const { port1, port2 } = fakeChannel();
      const answers: { id: number; result?: unknown; error?: unknown }[] = [];
      port1.on('message', ({ data }: { data: (typeof answers)[number] }) => answers.push(data));
      port1.start();
      parent.deliver({ type: 'init', userData: profile.path, mode: { kind: 'normal' } }, [port2]);
      await waitFor(() => parent.sent.length > 0);
      const token = path.join(profile.path, 'run', 'tokens', 'cli-default.token');
      expect(fs.existsSync(token)).toBe(true);

      port1.postMessage({ id: 1, method: 'principals.revoke', params: { name: 'cli-default' } });
      await waitFor(() => answers.length > 0);
      const answer = answers[0]?.result;
      if (!isNeedsConfirmation(answer)) throw new Error(`no intent: ${JSON.stringify(answers)}`);
      expect(answer.intent.preview).toContain('Remove access for "cli-default"');
      expect(fs.existsSync(token)).toBe(true);

      parent.deliver({
        type: 'approve-intent',
        id: 2,
        intentId: answer.intent.id,
        payloadHash: answer.intent.payloadHash,
      });
      await waitFor(() => parent.sent.some((message) => message.type === 'intent-result'));
      expect(parent.sent.find((message) => message.type === 'intent-result')).toMatchObject({
        id: 2,
        result: { principal: { name: 'cli-default', revokedAt: expect.any(String) as string } },
      });
      expect(fs.existsSync(token)).toBe(false);

      parent.deliver({ type: 'stop' });
      await waitFor(() => exits.length > 0);
    } finally {
      profile.cleanup();
    }
  });
});

describe("main's temporary confirmation prompt (C-04-12)", () => {
  const token = 'f'.repeat(32);
  const prompt = confirmPromptOf({
    ...INTENT,
    preview: 'Remove access for "<b>x</b>" & more',
    method: 'principals.revoke',
  });

  it('shows the core preview escaped, with no script, and only while it is open', () => {
    const page = confirmPage(prompt, token);
    expect(prompt.title).toBe('Remove access');
    expect(page).toContain('Remove access for &quot;&lt;b&gt;x&lt;/b&gt;&quot; &amp; more');
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain(`href="${CONFIRM_PATH}${token}/confirm"`);
    const root = path.resolve('/opt/cc/dist/renderer');
    const pages = new Map([[token, page]]);
    expect(
      resolveAppRequest(`cc-app://app/confirm/${token}`, root, undefined, (t) => pages.get(t)),
    ).toEqual({ kind: 'inline', body: page, contentType: 'text/html; charset=utf-8' });
    expect(
      resolveAppRequest(`cc-app://app/confirm/${'0'.repeat(32)}`, root, undefined, (t) =>
        pages.get(t),
      ),
    ).toEqual({ kind: 'not-found' });
    expect(resolveAppRequest(`cc-app://app/confirm/${token}`, root)).toEqual({
      kind: 'not-found',
    });
    expect(resolveAppRequest('cc-app://app/confirm.css', root)).toMatchObject({ kind: 'inline' });
  });

  it('reads a choice only from the two links of its own token', () => {
    expect(confirmChoice(`cc-app://app/confirm/${token}/confirm`, token)).toBe('confirm');
    expect(confirmChoice(`cc-app://app/confirm/${token}/cancel`, token)).toBe('cancel');
    for (const url of [
      `cc-app://app/confirm/${'0'.repeat(32)}/confirm`,
      `cc-app://app/confirm/${token}/confirm?x=1`,
      `cc-app://app/confirm/${token}/confirm#x`,
      `cc-app://app/confirm/${token}`,
      'not a url',
    ]) {
      expect(confirmChoice(url, token), url).toBeUndefined();
    }
  });
});
