/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
// Activates the `ctx.tenantPaths` Context merge read for per-tenant scopes.
import type {} from '@deepseek-ai/dsh-tenant'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * One tenant's observation state.
 *
 * Everything here is per-tenant. The follower set matters most: domain changes
 * are emitted on the writer's stack, so without a tenant on the frames every
 * subscriber would be told about every other person's deletions. The observed
 * sets matter too — a shared `knownIds` would make one tenant's new Workspace
 * look "already known" and silently drop its own upsert.
 */
interface FeedScope {
  readonly followers: Set<WorkspaceFollower>
  knownIds: Set<string>
  order: readonly string[]
  archived: readonly string[]
  pinned: readonly string[]
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly scopes = new Map<string, FeedScope>()

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const scope of this.scopes.values()) {
        for (const follower of scope.followers) follower.close()
        scope.followers.clear()
      }
      this.scopes.clear()
    }, 'workspace-controller.feed')
  }

  /** The ambient tenant's discriminator; empty outside a tenant chain. */
  private scopeKey(): string {
    return this.ctx.get('tenantPaths')?.current()?.home ?? ''
  }

  /**
   * The ambient tenant's observation state, built from the registry on first use.
   *
   * Built lazily for the same reason it is keyed: the constructor runs at
   * startup, before any tenant exists, so a snapshot taken there can only ever
   * describe the untenanted registry.
   */
  private scope(): FeedScope {
    const key = this.scopeKey()
    const existing = this.scopes.get(key)
    if (existing !== undefined) return existing
    const registry = this.ctx.workspaceRegistry
    const baseline = registry.list()
    const created: FeedScope = {
      followers: new Set(),
      knownIds: new Set(baseline.map(workspace => String(workspace.id))),
      order: baseline.map(workspace => String(workspace.id)),
      archived: registry.archivedSessionIds.map(String),
      pinned: registry.pinnedSessionIds.map(String),
    }
    this.scopes.set(key, created)
    return created
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all active Workspaces plus archived and pinned Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspaceView),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    signal.throwIfAborted()
    const scope = this.scope()
    const first = this.baseline()
    // Console, not ctx.logger: the shipped CLI mounts no logger backend, so the
    // Cordis logger discards every line. Opening a Workspace stream happens once
    // per page load, and knowing which Workspace set a browser was handed — and
    // on behalf of whom — is what makes a "no workspace to use" report
    // answerable without guessing.
    console.warn(
      '[workspace] follow baseline: %d workspace(s) for %s',
      first.items.length,
      first.items.map(item => item.title).join(', ') || '(none)',
    )
    const follower = new WorkspaceFollower()
    scope.followers.add(follower)
    try {
      yield { type: 'baseline', value: first }
      yield* follower.read(signal)
    } finally {
      scope.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') return
    // The event is emitted on the writer's stack, so the ambient tenant here is
    // the one whose state actually moved. Broadcasting to every follower would
    // hand one person's deletions to everybody.
    const scope = this.scope()
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(scope.order, nextOrder)
      for (const id of state.workspaceIds) {
        if (scope.knownIds.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        scope.knownIds.add(id)
        this.publish(scope, { type: 'upsert', workspace: workspaceView(workspace) })
      }
      scope.order = nextOrder
      if (orderChanged) this.publish(scope, { type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(scope.archived, nextArchived)) {
        scope.archived = nextArchived
        this.publish(scope, { type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(scope.pinned, nextPinned)) {
        scope.pinned = nextPinned
        this.publish(scope, { type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!scope.knownIds.delete(change.key)) return
      this.publish(scope, { type: 'remove', workspaceId: WorkspaceId(change.key) })
      return
    }
    if (!scope.knownIds.has(change.key)) return
    this.publish(scope, {
      type: 'upsert',
      workspace: changedWorkspaceView(change.key, change.value),
    })
  }

  private publish(scope: FeedScope, frame: Exclude<WorkspaceFollowFrame, { readonly type: 'baseline' }>): void {
    for (const follower of scope.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFollowFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFollowFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
