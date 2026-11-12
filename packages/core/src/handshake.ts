/**
 * The mutual-proof `auth.hello` of ADR 0002 decision 6. The server proves it knows the
 * principal's token before the client sends anything derived from it, so a process that
 * squats the endpoint (a pre-created pipe, a planted fallback socket) learns nothing usable.
 *
 * 1. Client → `auth.hello { principal, nonce: Nc }`.
 * 2. Server → `{ serverNonce: Ns, serverProof: HMAC(token, "server", principal, Nc, Ns) }`.
 * 3. The client checks the server proof; on a mismatch it closes without answering.
 * 4. Client → `auth.prove { proof: HMAC(token, "client", principal, Nc, Ns) }`.
 * 5. The server checks the proof and binds the connection to the principal.
 *
 * The role labels keep a server proof from ever serving as a client proof, and the fresh
 * nonces on both sides keep any proof from being replayed on another connection.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const LABEL = 'cc-auth-v1';

/** A fresh 256-bit nonce, base64url. */
export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

function proof(
  role: 'server' | 'client',
  token: string,
  principal: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return createHmac('sha256', token)
    .update([LABEL, role, principal, clientNonce, serverNonce].join('\n'))
    .digest('base64url');
}

export function serverProof(
  token: string,
  principal: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return proof('server', token, principal, clientNonce, serverNonce);
}

export function clientProof(
  token: string,
  principal: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return proof('client', token, principal, clientNonce, serverNonce);
}

/** Constant-time comparison of two proofs. */
export function proofsMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
