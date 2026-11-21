/**
 * Tier H confirmations (04 §4.3 rule 4, C-04-12, AC-04-15): through the UI port alone no
 * Tier H operation changes state. It answers `needs_confirmation`, and the state changes only
 * after the app shell approves the intent with the matching payload hash (`approveIntent`, the
 * core end of main's `approve-intent`). A second approval, an expired one or another payload
 * is refused. Tier R operations still run at once.
 *
 * A real core on a temporary profile serves the UI port over a Node `MessageChannel`, as the
 * desktop core host does with Electron's `MessagePortMain`, and is sent bare
 * `{ id, method, params }` messages: whatever a UI can send.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import type { BackupRecord, OnboardingProfile } from '@cc/schemas';
import { OnboardingProfile as OnboardingProfileSchema } from '@cc/schemas';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { randomBackupKey } from '../src/backups/keys.js';
import type { Clock } from '../src/clock.js';
import {
  DEFAULT_INTENT_TTL_MS,
  MAX_PENDING_INTENTS,
  payloadHashOf,
  type ConfirmationIntent,
} from '../src/confirm-intents.js';
import { HUMAN_ONLY_OPERATIONS, isShellConfirmed } from '../src/human-only.js';
import { tokenPathOf } from '../src/tokens.js';
import type { UiResponse } from '../src/ui-port.js';
import { rejection, repoRoot, startTestCore, type TestCore } from './helpers.js';

const open: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

/** A clock moved by hand; its timers never fire. */
function handClock(start: string): Clock & { advance(ms: number): void } {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A UI client on the core's UI port: bare `{ id, method, params }` messages. */
function uiClient(test: TestCore) {
  const channel = new MessageChannel();
  test.core.serveUi({
    postMessage: (message) => channel.port1.postMessage(message),
    onMessage: (listener) => channel.port1.on('message', listener),
  });
  let next = 0;
  const waiting = new Map<number | string, (response: UiResponse) => void>();
  channel.port2.on('message', (response: UiResponse) => {
    if (response.id !== null) waiting.get(response.id)?.(response);
  });
  open.push({
    dispose: () => {
      channel.port1.close();
      channel.port2.close();
      return Promise.resolve();
    },
  });
  const send = (message: Record<string, unknown>): Promise<UiResponse> =>
    new Promise((resolve) => {
      waiting.set(message['id'] as number, resolve);
      channel.port2.postMessage(message);
    });
  return {
    send,
    call: (method: string, params?: unknown) =>
      send({ id: ++next, method, ...(params === undefined ? {} : { params }) }),
  };
}

/** The intent of a `needs_confirmation` answer; fails the test on any other answer. */
function intentOf(response: UiResponse): ConfirmationIntent {
  expect(response).toMatchObject({ result: { status: 'needs_confirmation' } });
  return (response as { result: { intent: ConfirmationIntent } }).result.intent;
}

async function started(clock?: Clock): Promise<TestCore> {
  const test = await startTestCore({ seed: true, ...(clock === undefined ? {} : { clock }) });
  open.push(test);
  return test;
}

interface PrincipalRow {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly sensitiveAccess: boolean;
  readonly workstreamFilter: 'all' | readonly string[];
  readonly revokedAt?: string;
}

async function principal(test: TestCore, name: string): Promise<PrincipalRow | undefined> {
  const list = (await test.core.callAsUser('principals.list', {})) as {
    principals: PrincipalRow[];
  };
  return list.principals.find((entry) => entry.name === name);
}

function scenario(): OnboardingProfile {
  return OnboardingProfileSchema.parse(
    JSON.parse(fs.readFileSync(path.join(repoRoot(), 'fixtures/onboarding/scenario.json'), 'utf8')),
  );
}

describe('AC-04-15 Tier H operations need the app shell (04 §4.3 rule 4, C-04-12)', () => {
  it('AC-04-15 C-04-12 through the UI port alone, granting, changing and removing agent access changes nothing until the shell approves', async () => {
    const test = await started();
    const ui = uiClient(test);
    const before = await principal(test, 'cli-default');

    // A grant-only scope on a new principal (the scout probe of the UI seam).
    const create = intentOf(
      await ui.call('principals.create', {
        name: 'probe-agent',
        kind: 'mcp_client',
        scopes: ['read', 'connectors:invoke', 'discovery:request'],
      }),
    );
    expect(await principal(test, 'probe-agent')).toBeUndefined();
    expect(fs.existsSync(tokenPathOf(test.core.userData, 'probe-agent'))).toBe(false);
    // Widening an existing principal: a grant-only scope, sensitive access, all workstreams.
    const update = intentOf(
      await ui.call('principals.update', {
        name: 'cli-default',
        scopes: [...(before?.scopes ?? []), 'onboarding:apply'],
      }),
    );
    const sensitive = intentOf(
      await ui.call('principals.update', { name: 'cli-default', sensitiveAccess: true }),
    );
    const revoke = intentOf(await ui.call('principals.revoke', { name: 'cli-default' }));
    expect(await principal(test, 'cli-default')).toEqual(before);
    expect(fs.existsSync(tokenPathOf(test.core.userData, 'cli-default'))).toBe(true);

    // The preview is the core's, written from the payload.
    expect(create).toMatchObject({
      method: 'principals.create',
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(create.id).toMatch(/^cfi_[0-9A-Z]{26}$/);
    expect(create.preview).toContain('Add agent access for "probe-agent"');
    expect(create.preview).toContain('connectors:invoke');
    expect(create.preview).toContain('discovery:request');
    expect(update.preview).toContain('onboarding:apply');
    expect(sensitive.preview).toContain('sensitive');
    expect(revoke.preview).toContain('Remove access for "cli-default"');

    // The shell approves each with its hash: now, and only now, the state changes.
    await test.core.approveIntent(create.id, create.payloadHash);
    expect(await principal(test, 'probe-agent')).toMatchObject({
      scopes: ['read', 'connectors:invoke', 'discovery:request'],
    });
    expect(fs.existsSync(tokenPathOf(test.core.userData, 'probe-agent'))).toBe(true);
    await test.core.approveIntent(update.id, update.payloadHash);
    expect((await principal(test, 'cli-default'))?.scopes).toContain('onboarding:apply');
    await test.core.approveIntent(sensitive.id, sensitive.payloadHash);
    expect((await principal(test, 'cli-default'))?.sensitiveAccess).toBe(true);
    await test.core.approveIntent(revoke.id, revoke.payloadHash);
    expect((await principal(test, 'cli-default'))?.revokedAt).toBeDefined();
    expect(fs.existsSync(tokenPathOf(test.core.userData, 'cli-default'))).toBe(false);
  });

  it('AC-04-15 C-04-12 C-04-10 through the UI port alone, a restore stages nothing and takes no backup until the shell approves', async () => {
    const restarts: string[] = [];
    const folder: ProfileDir = createProfileDir();
    const test = await startTestCore({
      seed: true,
      backupKeys: [randomBackupKey()],
      requestRestart: (reason) => restarts.push(reason),
    });
    open.push({
      dispose: async () => {
        await test.dispose();
        folder.cleanup();
      },
    });
    await test.core.callAsUser('onboarding.save', { profile: scenario(), step: 'workspace' });
    await test.core.callAsUser('backups.destination', {
      destination: { kind: 'folder', label: 'Synced folder', path: folder.path },
    });
    const { backup } = (await test.core.callAsUser('backups.run', {})) as { backup: BackupRecord };
    const history = async () =>
      ((await test.core.callAsUser('backups.list', {})) as { backups: BackupRecord[] }).backups;
    const pendingFile = path.join(test.core.userData, 'restore', 'pending.json');

    const ui = uiClient(test);
    const restore = intentOf(await ui.call('backups.restore', { id: backup.id }));
    expect(restore.preview).toContain(`Restore your workspace from the backup ${backup.id}`);
    expect(restore.preview).toContain(backup.at);
    expect(fs.existsSync(pendingFile)).toBe(false);
    expect((await history()).map((record) => record.trigger)).toEqual(['manual']);
    expect(restarts).toEqual([]);

    expect(await test.core.approveIntent(restore.id, restore.payloadHash)).toMatchObject({
      status: 'ok',
      restored: backup.id,
    });
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect((await history()).map((record) => record.trigger)).toEqual(['pre_restore', 'manual']);
    expect(restarts).toEqual(['restore']);
  });

  it('AC-04-15 C-04-12 a second approval, an expired one and one with another payload are refused, and change nothing', async () => {
    const clock = handClock('2026-11-21T09:00:00Z');
    const test = await started(clock);
    const ui = uiClient(test);
    const grant = (scope: string) =>
      ui.call('principals.create', {
        name: `agent-${scope.split(':')[0] ?? ''}`,
        kind: 'cli',
        scopes: [scope],
      });

    // Used once: the second approval is refused.
    const first = intentOf(await grant('connectors:invoke'));
    await test.core.approveIntent(first.id, first.payloadHash);
    const again = await rejection(test.core.approveIntent(first.id, first.payloadHash));
    expect(again.code).toBe('E_NOT_FOUND');

    // Expired: five minutes by default.
    const late = intentOf(await grant('discovery:request'));
    expect(Date.parse(late.expiresAt) - clock.now().getTime()).toBe(DEFAULT_INTENT_TTL_MS);
    clock.advance(DEFAULT_INTENT_TTL_MS);
    const expired = await rejection(test.core.approveIntent(late.id, late.payloadHash));
    expect(expired.code).toBe('E_CONFLICT');
    expect(await principal(test, 'agent-discovery')).toBeUndefined();

    // Another payload: the hash of a different grant does not approve this one, and the
    // intent is gone afterwards, so the right hash cannot follow.
    const asked = intentOf(await grant('requests:propose'));
    const other = payloadHashOf('principals.create', {
      name: 'agent-requests',
      kind: 'cli',
      scopes: ['requests:propose', 'connectors:invoke'],
    });
    const changed = await rejection(test.core.approveIntent(asked.id, other));
    expect(changed.code).toBe('E_PAYLOAD_CHANGED');
    const after = await rejection(test.core.approveIntent(asked.id, asked.payloadHash));
    expect(after.code).toBe('E_NOT_FOUND');
    expect(await principal(test, 'agent-requests')).toBeUndefined();

    // A denied intent cannot be approved either.
    const denied = intentOf(await grant('onboarding:apply'));
    expect(test.core.denyIntent(denied.id)).toBe(true);
    const gone = await rejection(test.core.approveIntent(denied.id, denied.payloadHash));
    expect(gone.code).toBe('E_NOT_FOUND');
    expect(await principal(test, 'agent-onboarding')).toBeUndefined();
  });

  it('AC-04-15 C-04-12 the UI port has no way to approve: no method and no message member does it', async () => {
    const test = await started();
    const ui = uiClient(test);
    const intent = intentOf(await ui.call('principals.revoke', { name: 'cli-default' }));
    for (const method of ['intents.approve', 'confirmations.approve', 'approve.intent']) {
      const answer = await ui.call(method, { id: intent.id, payloadHash: intent.payloadHash });
      expect(answer, method).toMatchObject({ error: { code: 'E_USAGE' } });
    }
    const smuggled = await ui.send({
      id: 99,
      method: 'principals.revoke',
      params: { name: 'cli-default' },
      approve: { id: intent.id, payloadHash: intent.payloadHash },
    });
    expect(smuggled).toMatchObject({ id: 99, error: { code: 'E_USAGE' } });
    // Asking again only issues another intent.
    intentOf(await ui.call('principals.revoke', { name: 'cli-default' }));
    expect((await principal(test, 'cli-default'))?.revokedAt).toBeUndefined();
    // The original intent is still the shell's to approve.
    await test.core.approveIntent(intent.id, intent.payloadHash);
    expect((await principal(test, 'cli-default'))?.revokedAt).toBeDefined();
  });

  it('C-04-12 Tier R operations and safe payloads of Tier H methods still run at once from the UI', async () => {
    const test = await started();
    const ui = uiClient(test);
    // Removing scopes and narrowing never needs the shell.
    const narrowed = await ui.call('principals.update', { name: 'cli-default', scopes: ['read'] });
    expect(narrowed).toMatchObject({ result: { principal: { scopes: ['read'] } } });
    // A principal without a grant-only scope or sensitive access is added at once.
    const plain = await ui.call('principals.create', {
      name: 'reader',
      kind: 'cli',
      scopes: ['read'],
    });
    expect(plain).toMatchObject({ result: { principal: { name: 'reader' } } });
    // Claims, drafts and drops stay in flow (Tier R).
    const drop = await ui.call('items.drop', {
      ref: 'A-0142',
      reason: 'The lead chose another firm',
    });
    expect(drop).toMatchObject({ result: { status: 'ok' } });
    // A Tier H call is still checked like any call before an intent is kept.
    const bad = await ui.call('principals.revoke', { name: 42 });
    expect(bad).toMatchObject({ error: { code: 'E_USAGE' } });
    const unbuilt = await ui.call('connectors.install', { id: 'x' });
    expect(unbuilt).toMatchObject({ error: { code: 'E_USAGE' } });
  });

  it('C-04-12 at most a bounded number of intents wait; the oldest goes first', async () => {
    const test = await started();
    const ui = uiClient(test);
    const first = intentOf(await ui.call('principals.revoke', { name: 'cli-default' }));
    for (let i = 0; i < MAX_PENDING_INTENTS; i++) {
      intentOf(await ui.call('principals.revoke', { name: 'cli-default' }));
    }
    const evicted = await rejection(test.core.approveIntent(first.id, first.payloadHash));
    expect(evicted.code).toBe('E_NOT_FOUND');
  });

  it('C-04-12 the Tier H operations are the safety-critical ones of the catalogue', () => {
    expect(
      HUMAN_ONLY_OPERATIONS.filter((entry) => isShellConfirmed(entry.method)).map(
        (entry) => entry.method,
      ),
    ).toEqual([
      'confirmations.approve',
      'connectors.install',
      'connectors.update',
      'connectors.uninstall',
      'principals.create',
      'principals.update',
      'principals.revoke',
      'sessions.create',
      'sessions.delete',
      'discovery.start',
      'discovery.choose',
      'connectors.activate',
      'connectors.rollback',
      'approvals.grant',
      'requests.approve',
      'backups.restore',
    ]);
  });
});
