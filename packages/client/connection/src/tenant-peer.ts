/**
 * The tenant Peer: one admitted person's session on this Host.
 *
 * Upstream, Connection owned a single `OperatorPeer` and admitted every request
 * as it — sound while the process had exactly one party. With tenants there are
 * many parties, and they must not share a scope: `peer.ctx` is what event
 * dispatch, answerers, watchers, and stream subscribers register through, so
 * one scope for everyone would let one tenant's approval reach another's
 * listener.
 *
 * Each tenant therefore gets its own scope, created on first sight and held for
 * as long as Connection lives. The Peer also carries the `Tenant`, which is how
 * `Connection.runWithPeer` recovers the ambient tenant for a call: the peer is
 * already threaded through every invocation, so nothing else has to be.
 * @module @deepseek-ai/dsh-client-connection/src/tenant-peer
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Tenant } from '@deepseek-ai/dsh-tenant'

/**
 * One tenant's scope. The instance is its own scope key, so `scopeOf(peer.ctx)`
 * returns it and events dispatched with `scopeTarget(subject, peer)` reach
 * listeners registered through `peer.ctx` and nobody else.
 */
export class TenantPeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx: Context
  private readonly scope: Scope

  /**
   * @param owner - Connection plugin context the scope fiber hangs under.
   * @param tenant - the tenant this Peer speaks for.
   */
  constructor(owner: Context, readonly tenant: Tenant) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  /** Tear down every registration made through `ctx`; racing calls share one completion. */
  dispose(): Promise<void> {
    return this.scope.dispose()
  }
}
