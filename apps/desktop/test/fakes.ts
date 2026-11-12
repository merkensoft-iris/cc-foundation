/**
 * Test doubles for the shell: a clock whose timers fire only when the test advances it, and
 * an in-memory `MessageChannelMain`.
 */
import { EventEmitter } from 'node:events';

import type { Clock } from '../src/main/clock.js';
import type { MainPort } from '../src/main/core-supervisor.js';

export interface TimerClock extends Clock {
  /** Moves time to `instant` (ISO or epoch ms), firing due timers in order. */
  advanceTo(instant: string | number): void;
  advance(ms: number): void;
  readonly pending: number;
}

export function timerClock(start: string): TimerClock {
  let now = Date.parse(start);
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const advanceTo = (target: number): void => {
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
    }
    now = Math.max(now, target);
  };

  return {
    now: () => new Date(now),
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advanceTo: (instant) => advanceTo(typeof instant === 'number' ? instant : Date.parse(instant)),
    advance: (ms) => advanceTo(now + ms),
    get pending() {
      return timers.size;
    },
  };
}

/** One end of an in-memory channel, shaped like Electron's `MessagePortMain`. */
export class FakePort extends EventEmitter implements MainPort {
  peer: FakePort | undefined;
  started = false;
  closed = false;
  readonly sent: unknown[] = [];
  readonly #inbox: unknown[] = [];

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.sent.push(message);
    const peer = this.peer;
    if (peer === undefined || peer.closed) return;
    const copy = structuredClone(message);
    queueMicrotask(() => peer.#receive(copy));
  }

  #receive(data: unknown): void {
    if (this.closed) return;
    if (!this.started) {
      this.#inbox.push(data);
      return;
    }
    this.emit('message', { data });
  }

  start(): void {
    this.started = true;
    for (const data of this.#inbox.splice(0)) this.emit('message', { data });
  }

  close(): void {
    this.closed = true;
  }
}

export function fakeChannel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

/** Lets queued microtasks (port messages, promise callbacks) run. */
export async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}
