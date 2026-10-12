/**
 * Domain data form (`ctx.storage.domain`): schema-validated, change-emitting
 * KV domains over storage backends. The single implementation of the domain
 * layer — consumers depend on this package and never touch backends directly.
 * Plugin `Config` is schemastery; record schemas inside domain specs are zod
 * (see `src/spec.ts` for the split rationale).
 * @module @deepseek-ai/dsh-storage-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Activates the `ctx.tenantPaths` Context merge read by instance scoping.
import type {} from '@deepseek-ai/dsh-tenant'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import { descriptorOf } from './spec.ts'
import type { DomainSpec } from './spec.ts'
import { DomainImpl } from './domain.ts'
import type { Domain } from './domain.ts'

export { DomainError } from './error.ts'
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from './error.ts'
export { defineDomain, domainTable, descriptorOf } from './spec.ts'
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from './spec.ts'
export type { DomainChanged } from './events.ts'
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from './domain.ts'

declare module '@deepseek-ai/dsh-storage' {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: DomainFacility
  }
}

/** Cordis plugin name. */
export const name = 'storage-domain'
/** The storage hub must be present before the form can mount. */
export const inject = ['storage']

/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
})

/**
 * The mounted domain facility. Opens declared domains over routed backends;
 * one facility instance owns the open-domain table and enforces single-open
 * per domain name.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()
  /**
   * Every spec this facility has opened, by name.
   *
   * Kept because a later tenant needs the same set opened again for itself, and
   * the only other record of "which domains exist" is the callers who asked —
   * who by then hold handles belonging to whoever was ambient when they asked.
   */
  private readonly specs = new Map<string, DomainSpec>()

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * One domain instance's key: the ambient tenant plus the domain name.
   *
   * Under multi-tenancy a domain name stops identifying a single instance —
   * each tenant owns its own copy of every domain, loaded from its own
   * directory. The tenant home is the discriminator, and it is empty outside a
   * tenant chain, which is exactly the single-user case the facility was built
   * around.
   */
  private scopeKey(name: string): string {
    return `${this.ctx.get('tenantPaths')?.current()?.home ?? ''}\u0000${name}`
  }

  /**
   * Open every domain this facility has opened before, for the ambient tenant.
   *
   * A tenant must be warmed before its requests are served, because domain
   * handles are read **synchronously** (`KvTable.get`, `DomainGlobal.get`) and
   * a synchronous read cannot await a first open. Warming at login is what makes
   * `WorkspaceRegistry.list()` and its peers stay synchronous while still
   * serving per-tenant data.
   *
   * Already-open domains are skipped, so calling this repeatedly is free.
   */
  async warmKnown(): Promise<void> {
    for (const spec of this.specs.values()) {
      if (this.domains.has(this.scopeKey(spec.name))) continue
      await this.open(spec)
    }
  }

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load and validate
   * every stored record against the spec's zod schemas (`invalid-record`
   * with the offending table and key — unless the spec declares
   * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside, in
   * which case the failing record is backed up, logged, and skipped);
   * construct the domain.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
   * facility does not tie the domain to any consumer fiber. Domains still
   * open when the facility unmounts are closed by the plugin disposer.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @returns the opened domain handle, typed by the spec.
   */
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    const key = this.scopeKey(spec.name)
    if (this.reserved.has(key)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(key)
    try {
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend
      const backend = this.ctx.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const snapshot = await unit.loadAll()
        const tables = new Map<string, Map<string, unknown>>()
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>()
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            let parsed: unknown
            try {
              parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
            } catch (error) {
              // Backup-and-skip policy (disposable derived data): move the record's
              // document aside, log the concrete failure, and open without the
              // record. Backends that cannot move a document keep the loud path.
              if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
              const moved = await unit.backupRecord(table, key)
              // parseRecord always wraps the zod failure as the cause.
              this.ctx.logger.error(
                `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
                + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
              )
              continue
            }
            records.set(key, parsed)
          }
          tables.set(table, records)
        }
        // A null stored global means "never written": serve `initial` without
        // materializing it — the first `set` writes.
        const globalSpec = spec.global
        const globalValue = globalSpec === undefined
          ? undefined
          : snapshot.global === null
            ? globalSpec.initial
            : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the name
        // frees up for reopening only once the domain is fully closed.
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
          this.domains.delete(key)
          this.reserved.delete(key)
        })
        this.domains.set(key, domain)
        this.specs.set(spec.name, spec)
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(key)
      throw error
    }
  }

  /**
   * Look up an open domain by name, untyped, for the ambient tenant.
   * Diagnostic surface; typed consumers hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(this.scopeKey(name))
  }

  /**
   * Close every domain still open on this facility. The unmount path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

/** Run one zod parse, translating failure to `invalid-record` with its location. */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}

/**
 * Mount the domain data form on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 * @returns resolution after an already-available backend set activates the form.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([
    config.backend,
    ...Object.values(config.routes ?? {}),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility)
      return async () => {
        // Close leftovers before unmounting: draining writes still emit
        // domain/changed.
        await facility.closeAll()
        unmount()
      }
    })
    domainCtx.provide('storageDomain', facility)
  })
  return Promise.resolve(fiber).then(() => {})
}
