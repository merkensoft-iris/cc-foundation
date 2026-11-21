/**
 * ADR 0003 decision 9, the renderer has no network (rule D3, 04 §3): hostile code in the app
 * window reaches nothing, WebRTC included, and `window.cc` passes only the methods marked `ui`.
 *
 * This is the hostile-widget runtime test ADR 0003 proposed (Consequences, item 1), run on the
 * real app rather than the prototype. A loopback probe inside the test counts every TCP
 * connection and every UDP datagram. Code evaluated in the page's main world, where engine UI
 * code runs, then tries the prototype's escapes at that probe: fetch, WebSocket, EventSource,
 * a beacon, images, styles, scripts, frames, a worker, window.open and a navigation, and
 * WebRTC with STUN and TURN servers on the probe, from the page and from a fresh
 * `about:blank` frame. The CSP stops most of them; WebRTC is outside the CSP and `webRequest`,
 * and only the WebRTC IP handling policy and the no-network proxy of the renderer session
 * stop it (ADR 0003: 9 UDP STUN packets and 2 TCP TURN connections without them). The probe
 * must see nothing.
 *
 * The probe proves itself first: the test reaches it over TCP and UDP and sees both.
 */
import dgram from 'node:dgram';
import net from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { launchApp, type RunningApp } from './electron.ts';

interface Probe {
  readonly tcpPort: number;
  readonly udpPort: number;
  readonly hits: string[];
  close(): Promise<void>;
}

/** A TCP listener and a UDP socket on 127.0.0.1 that record every connection and datagram. */
async function startProbe(): Promise<Probe> {
  const hits: string[] = [];
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    hits.push('tcp connection');
    socket.once('data', (data) => hits.push(`tcp ${String(data.length)}B`));
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const udp = dgram.createSocket('udp4');
  udp.on('message', (message) => hits.push(`udp ${String(message.length)}B`));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  return {
    tcpPort: (tcp.address() as net.AddressInfo).port,
    udpPort: udp.address().port,
    hits,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    },
  };
}

/** What the hostile code saw in the page. */
interface HostileReport {
  readonly attempts: number;
  readonly candidates: readonly string[];
  readonly invoke: Record<string, string>;
}

/**
 * The hostile code, evaluated in the page's main world. It must be self-contained: Playwright
 * sends its source to the page.
 */
async function hostile(ports: { tcp: number; udp: number }): Promise<HostileReport> {
  const http = `http://127.0.0.1:${String(ports.tcp)}`;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let attempts = 0;
  const attempt = (run: () => unknown) => {
    attempts += 1;
    try {
      const result = run();
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Refused synchronously: that is the point.
    }
  };

  attempt(() => fetch(`${http}/fetch`));
  attempt(() => fetch(`${http}/no-cors`, { mode: 'no-cors' }));
  attempt(() => new WebSocket(`ws://127.0.0.1:${String(ports.tcp)}/ws`));
  attempt(() => new EventSource(`${http}/events`));
  attempt(() => navigator.sendBeacon(`${http}/beacon`, 'x'));
  attempt(() => {
    const request = new XMLHttpRequest();
    request.open('GET', `${http}/xhr`);
    request.send();
  });
  attempt(() => {
    const image = new Image();
    image.src = `${http}/image.png`;
  });
  for (const [tag, attribute] of [
    ['script', 'src'],
    ['iframe', 'src'],
    ['img', 'src'],
    ['audio', 'src'],
    ['video', 'src'],
    ['object', 'data'],
  ] as const) {
    attempt(() => {
      const element = document.createElement(tag);
      element.setAttribute(attribute, `${http}/${tag}`);
      document.body.append(element);
    });
  }
  attempt(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${http}/style.css`;
    document.head.append(link);
  });
  attempt(() => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = `${http}/prefetch`;
    document.head.append(link);
  });
  attempt(() => {
    const style = document.createElement('style');
    style.textContent = `body { background: url(${http}/bg.png); }`;
    document.head.append(style);
  });
  attempt(() => new Worker(`${http}/worker.js`));
  attempt(() => window.open(`${http}/popup`));

  // WebRTC: STUN over UDP, TURN over UDP and TCP, all at the probe.
  const candidates: string[] = [];
  const peer = async (Peer: typeof RTCPeerConnection, label: string) => {
    attempts += 1;
    try {
      const connection = new Peer({
        iceServers: [
          { urls: `stun:127.0.0.1:${String(ports.udp)}` },
          {
            urls: [
              `turn:127.0.0.1:${String(ports.udp)}?transport=udp`,
              `turn:127.0.0.1:${String(ports.tcp)}?transport=tcp`,
            ],
            username: 'probe',
            credential: 'probe',
          },
        ],
        iceCandidatePoolSize: 1,
      });
      connection.onicecandidate = (event) => {
        if (event.candidate !== null) candidates.push(`${label} ${event.candidate.type ?? '?'}`);
      };
      connection.createDataChannel('x');
      await connection.setLocalDescription(await connection.createOffer());
      await Promise.race([
        new Promise<void>((resolve) => {
          connection.onicegatheringstatechange = () => {
            if (connection.iceGatheringState === 'complete') resolve();
          };
        }),
        wait(5_000),
      ]);
      connection.close();
    } catch {
      // No WebRTC at all is fine too.
    }
  };
  await peer(RTCPeerConnection, 'page');
  // A fresh about:blank frame has its own RTCPeerConnection (ADR 0003: removing it from the
  // main world adds nothing); it must be stopped the same way.
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const framePeer = (frame.contentWindow as (Window & typeof globalThis) | null)?.RTCPeerConnection;
  if (framePeer !== undefined) await peer(framePeer, 'frame');

  // window.cc: an agent-only method, an unknown one and an allowed one.
  const invoke: Record<string, string> = {};
  const cc = (window as unknown as { cc: { invoke(m: string, p?: unknown): Promise<unknown> } }).cc;
  for (const [method, params] of [
    ['auth.hello', { principal: 'cli-default', nonce: 'A'.repeat(22) }],
    ['confirmations.wait', { id: 'cnf_01JZ0000000000000000000000', timeoutSeconds: 1 }],
    ['fs.readFile', { path: '/etc/hosts' }],
    ['onboarding.status', {}],
  ] as const) {
    try {
      await cc.invoke(method, params);
      invoke[method] = 'ok';
    } catch (error) {
      invoke[method] = (error as { code?: string }).code ?? 'thrown';
    }
  }

  // Last, a navigation: main prevents it and the page stays.
  attempt(() => {
    location.href = `${http}/navigate`;
  });
  return { attempts, candidates, invoke };
}

let profile: ProfileDir;
let probe: Probe;
let running: RunningApp | undefined;

beforeAll(async () => {
  probe = await startProbe();
  profile = createProfileDir();
});

afterAll(async () => {
  await running?.close();
  await probe?.close();
  profile?.cleanup();
});

describe('ADR 0003 decision 9 a hostile renderer', { timeout: 120_000 }, () => {
  it('the loopback probe sees TCP and UDP from the test itself', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(probe.tcpPort, '127.0.0.1', () => {
        socket.end('ping', () => resolve());
      });
      socket.on('error', reject);
    });
    const udp = dgram.createSocket('udp4');
    // Bound to loopback first: an unbound socket binds to 0.0.0.0, which the test guard refuses.
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve, reject) =>
      udp.send('ping', probe.udpPort, '127.0.0.1', (error) => (error ? reject(error) : resolve())),
    );
    udp.close();
    await expect
      .poll(() => probe.hits.filter((hit) => hit.startsWith('tcp connection')).length)
      .toBe(1);
    await expect.poll(() => probe.hits.filter((hit) => hit.startsWith('udp')).length).toBe(1);
    probe.hits.length = 0;
  });

  it('reaches nothing from the app window, WebRTC included, and window.cc refuses methods not marked ui', async () => {
    running = await launchApp(profile.path);
    // A fresh profile opens the onboarding wizard: the page and its bridge are up.
    await running.byTest('workspace-zone').waitFor();

    const report = await running.page.evaluate(hostile, {
      tcp: probe.tcpPort,
      udp: probe.udpPort,
    });
    expect(report.attempts).toBeGreaterThanOrEqual(20);
    expect(report.invoke).toEqual({
      'auth.hello': 'E_FORBIDDEN',
      'confirmations.wait': 'E_FORBIDDEN',
      'fs.readFile': 'E_USAGE',
      'onboarding.status': 'ok',
    });
    // Without the policy, WebRTC gathers server-reflexive and relay candidates at the probe.
    expect(report.candidates.filter((c) => /srflx|relay/.test(c))).toEqual([]);

    // Late packets (ICE retries, the dead proxy's refusals) have time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(probe.hits).toEqual([]);
    // The navigation was prevented: the app page is still the one loaded.
    expect(running.page.url()).toMatch(/^cc-app:\/\/app\//);
  });
});
