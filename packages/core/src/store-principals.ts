/**
 * Agent principals in the store's `agent_principals` table (03 §12, 07 §5). Each save is one
 * store command that writes the row and its `agent_principal.<verb>` event together; the
 * event carries the changed fields only (03 §5.10), never a token (tokens are files).
 */
import { changedFields } from '@cc/domain';
import type { AgentPrincipal } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { PrincipalDirectory, PrincipalWrite } from './principals.js';

export class StorePrincipalDirectory implements PrincipalDirectory {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  get(name: string): Promise<AgentPrincipal | undefined> {
    return Promise.resolve(
      this.#store.read((tx) => tx.list('agent_principals').find((p) => p.name === name)),
    );
  }

  list(): Promise<AgentPrincipal[]> {
    return Promise.resolve(this.#store.read((tx) => tx.list('agent_principals')));
  }

  save(principal: AgentPrincipal, write: PrincipalWrite): Promise<void> {
    this.#store.command({ actor: write.actor }, (tx) => {
      if (write.before === undefined) tx.insert('agent_principals', principal);
      else tx.update('agent_principals', principal, write.before.version);
      const fields = changedFields(write.before, principal);
      tx.event({
        type: `agent_principal.${write.verb}`,
        entity: { kind: 'agent_principal', id: principal.id },
        ...(fields.before === undefined ? {} : { before: fields.before }),
        after: fields.after,
      });
    });
    return Promise.resolve();
  }
}
