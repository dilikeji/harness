/**
 * JSON storage backend: one human-readable document per unit under a
 * configured root — a whole-unit file (`single` layout) or one document per
 * record (`per-record` layout), published by atomic rewrite. Registers as
 * backend `json` on the storage hub.
 * @module @deepseek-ai/dsh-storage-json
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Activates the `ctx.tenantPaths` Context merge read below.
import type {} from '@deepseek-ai/dsh-tenant'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openSingleUnit } from './single-unit.ts'
import { openPerRecordUnit } from './per-record-unit.ts'

/** Cordis plugin name. */
export const name = 'storage-json'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
  root: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** JSON backend: owns the file-tree root and serves the `kv` facet. */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // Reserved synchronously at open() entry so a concurrent open of the same
  // unit fails, and close() can await opens still in flight.
  private readonly opening = new Map<string, Promise<KvUnit>>()
  private closed = false

  private readonly rootOf: () => string

  /**
   * @param root - a fixed root path, or a resolver read at every open.
   *
   * The resolver form is what multi-tenancy needs: `ctx.tenantPaths` is an
   * ambient lookup, so this one backend serves every tenant by resolving a
   * different directory, and the storage hub above it never learns that tenants
   * exist. A plain string keeps working unchanged — that is what a single-root
   * deployment and every existing test constructs.
   */
  constructor(root: string | (() => string)) {
    this.rootOf = typeof root === 'function' ? root : () => root
  }

  /**
   * The live-handle slot one unit occupies.
   *
   * Scoped by root, never by name alone. Under multi-tenancy the same unit name
   * resolves to a different directory per tenant, so a cache keyed by name
   * would hand tenant B the handle tenant A opened — pointing at A's files.
   * Keying on the resolved root makes that structural rather than a rule
   * somebody has to remember.
   */
  private unitKey(descriptor: KvUnitDescriptor): string {
    return `${this.rootOf()}\u0000${descriptor.name}`
  }

  readonly kv: KvFacet = {
    // The body up to the first await runs synchronously, so the opening-slot
    // reservation below still excludes a concurrent open of the same unit.
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      const key = this.unitKey(descriptor)
      if (this.open.has(key) || this.opening.has(key)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor, key)
      this.opening.set(key, opening)
      return opening.finally(() => this.opening.delete(key))
    },
  }

  private async openUnit(descriptor: KvUnitDescriptor, key: string): Promise<KvUnit> {
    const root = this.rootOf()
    await mkdir(root, { recursive: true, mode: 0o700 })
    // The two layouts differ in medium shape only; each opener owns its own
    // path convention under the shared root.
    const onClose = () => this.open.delete(key)
    const unit = descriptor.layout === 'per-record'
      ? await openPerRecordUnit(descriptor, root, onClose)
      : await openSingleUnit(descriptor, root, onClose)
    if (this.closed) {
      // The backend closed while this open was in flight: do not hand out a
      // live unit past close().
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(key, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
    }
    await Promise.allSettled([...this.opening.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `json` backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  // Resolved per open, not once: `ctx.tenantPaths` is an ambient lookup, so one
  // backend serves every tenant by resolving a different directory, and the
  // storage hub above it never learns that tenants exist.
  const backend = new JsonStorageBackend(
    () => ctx.get('tenantPaths')?.root('storages', config.root) ?? config.root,
  )
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('json', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('json'), backend)
}
