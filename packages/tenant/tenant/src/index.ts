/**
 * Multi-tenant identity for a single Harness process.
 *
 * The deployment hands the browser a **token** on its URL. The browser stores
 * it and presents it on every request; this package turns that token into a
 * `Tenant` — one person's home, workspace, credentials document, and session
 * history — and publishes it as the *ambient tenant* of the current
 * asynchronous chain.
 *
 * Two services are provided together because they are two halves of one
 * mechanism and must never disagree about who the caller is:
 *
 * - `ctx.tenantPaths` owns the ambient tenant and resolves data roots from it.
 *   It depends on nothing, so the persistence plugins (which need a root) and
 *   the credentials provider (which needs a file) can both depend on it
 *   without forming a cycle.
 * - `ctx.tenants` owns token resolution against the deployment's auth endpoint
 *   and materializes a tenant's directories. It depends on `tenantPaths`, and
 *   reaches for `credentials` through `ctx.get` rather than `inject` — that
 *   indirection is what keeps `tenantPaths -> credentials -> tenants` from
 *   closing into a cycle, and it is safe because credentials are only touched
 *   while serving a login, long after every service is active.
 * @module @deepseek-ai/dsh-tenant
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  AuthUser,
  Tenant,
  TenantModels,
  TenantResolution,
} from './types.ts'

export type {
  AuthUser,
  Tenant,
  TenantModels,
  TenantResolution,
  TenantResolutionFailure,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'tenant'

/**
 * A tenant folder name the registry will address. Deliberately stricter than
 * any reasonable username: it excludes path separators, `..`, drive letters,
 * whitespace, and every character that could escape the tenant root, so a
 * hostile or merely sloppy auth endpoint cannot make one tenant write into
 * another's directory. The auth contract documents the same grammar.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Plugin config. */
export interface Config {
  /** Directory holding one folder per tenant; defaults to `<DSH_HOME>/tenants`. */
  root?: string
  /**
   * Whether a token is verified against {@link Config.authEndpoint}.
   *
   * Leaving this on is the production posture. Turning it **off** makes the
   * token itself the username, which is a local-development convenience only:
   * it still isolates tenants by folder, but anyone who can reach the port can
   * claim any username. Never disable it on a shared deployment.
   */
  verify?: boolean
  /** Auth endpoint accepting `POST { token }`; defaults to `https://admin.longtongjiyun.com/v1/api/notify/harnessAuth`. */
  authEndpoint?: string
  /** How long a verified token stays cached, in seconds. Default: 300. */
  cacheSeconds?: number
  /** Auth request deadline in milliseconds. Default: 10000. */
  requestTimeoutMs?: number
  /** Credential reference the tenant's model key is stored under. Default: `DEEPSEEK_API_KEY`. */
  apiKeyRef?: string
}

export const Config: z<Config> = z.object({
  root: z.string(),
  verify: z.boolean().default(true),
  authEndpoint: z.string().default('https://admin.longtongjiyun.com/v1/api/notify/harnessAuth'),
  cacheSeconds: z.natural().default(300),
  requestTimeoutMs: z.natural().default(10_000),
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ambient tenant resolution and tenant-scoped data roots. */
    tenantPaths: TenantPathsService
    /** Token-to-tenant registry backed by the deployment auth endpoint. */
    tenants: TenantRegistry
  }
}

/**
 * Owns the ambient tenant of the current asynchronous chain and turns it into
 * filesystem roots.
 *
 * The ambient value is an `AsyncLocalStorage` slot, mirroring how
 * `AgentRegistry` tracks its initiator. A boundary is established wherever
 * identity is known — the HTTP request that carried a token, a WebSocket
 * frame, a resumed background job — and every nested call inherits it, so a
 * consumer that needs a root asks for one instead of receiving a tenant
 * parameter through every layer.
 */
export class TenantPathsService extends Service {
  private readonly rootDirectory: string
  private readonly ambient = new AsyncLocalStorage<Tenant | undefined>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'tenantPaths')
    this.rootDirectory = resolve(config.root ?? join(resolveDshHome(), 'tenants'))
    ctx.effect(() => () => { this.ambient.disable() }, 'tenant: ambient tenant store')
  }

  /** The root holding one directory per tenant. */
  get directory(): string {
    return this.rootDirectory
  }

  /** Absolute home of one tenant, whether or not it exists yet. */
  homeOf(username: string): string {
    return join(this.rootDirectory, username)
  }

  /**
   * Recover the tenant that owns one workspace path.
   *
   * A pure derivation, not a cache lookup: a tenant's workspace is always
   * `<root>/<username>/workspace`, so the username is readable from the path
   * itself. This is what lets a caller without an ambient tenant — a stream
   * resumed long after its request, a process-wide registry holding every
   * person's live sessions — decide which tenant a piece of state belongs to.
   * @param path - an absolute workspace (or any path below one).
   * @returns the owning tenant, or undefined when the path is outside the root.
   */
  tenantOfWorkspace(path: string): Tenant | undefined {
    const below = relative(this.rootDirectory, resolve(path))
    if (below.length === 0 || below.startsWith('..') || isAbsolute(below)) return undefined
    const [username] = below.split(sep)
    if (username === undefined || !USERNAME_PATTERN.test(username)) return undefined
    const home = join(this.rootDirectory, username)
    return {
      username,
      userId: username,
      displayName: username,
      home,
      workspace: join(home, 'workspace'),
    }
  }

  /** The tenant owning the current asynchronous chain, if any. */
  current(): Tenant | undefined {
    return this.ambient.getStore()
  }

  /**
   * Run `operation` with `tenant` as the ambient owner of every nested call.
   * @param tenant - tenant to install, or `undefined` to hide any inherited one
   *   for shared work that belongs to no user.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   */
  run<T>(tenant: Tenant | undefined, operation: () => T): T {
    return this.ambient.run(tenant, operation)
  }

  /**
   * Resolve one directory below the ambient tenant's home.
   * @param segment - directory name (`sessions`, `storages`, `spill`).
   * @param fallback - root a plugin keeps for calls outside any request chain.
   * @returns the tenant-scoped directory, or `fallback` with no tenant ambient.
   */
  root(segment: string, fallback: string): string {
    const tenant = this.ambient.getStore()
    return tenant === undefined ? fallback : join(tenant.home, segment)
  }

  /**
   * Resolve one file directly below the ambient tenant's home.
   * @param filename - file name (`.credentials.yaml`).
   * @param fallback - path used with no tenant ambient.
   * @returns the tenant-scoped file path, or `fallback`.
   */
  file(filename: string, fallback: string): string {
    const tenant = this.ambient.getStore()
    return tenant === undefined ? fallback : join(tenant.home, filename)
  }
}

/** One cached resolution; `expiresAt` already accounts for the endpoint's own expiry. */
interface CachedTenant {
  readonly tenant: Tenant
  readonly models?: TenantModels
  readonly expiresAt: number
}

/** Outcome of one call to the deployment auth endpoint. */
type FetchOutcome =
  | { readonly kind: 'user'; readonly user: AuthUser }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' }

/**
 * Resolves tokens to tenants and prepares their directories.
 *
 * A resolution is cached by token *digest* — the plaintext token is never held
 * beyond the request that carried it, so a heap dump or a log of this service
 * cannot replay anyone's session.
 */
export class TenantRegistry extends Service {
  private readonly paths: TenantPathsService
  private readonly verify: boolean
  private readonly authEndpoint: string
  private readonly cacheSeconds: number
  private readonly requestTimeoutMs: number
  private readonly apiKeyRef: CredentialRef
  private readonly cache = new Map<string, CachedTenant>()

  constructor(ctx: Context, paths: TenantPathsService, config: Config) {
    super(ctx, 'tenants')
    this.paths = paths
    this.verify = config.verify ?? true
    this.authEndpoint = config.authEndpoint ?? 'https://admin.longtongjiyun.com/v1/api/notify/harnessAuth'
    this.cacheSeconds = config.cacheSeconds ?? 300
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000
    this.apiKeyRef = credentialRef(config.apiKeyRef ?? 'DEEPSEEK_API_KEY')
    ctx.effect(() => () => { this.cache.clear() }, 'tenant: resolution cache')
  }

  /** The tenant owning the current asynchronous chain, if any. */
  current(): Tenant | undefined {
    return this.paths.current()
  }

  /**
   * Run `operation` with `tenant` as the ambient owner of every nested call.
   * @param tenant - tenant to install, or `undefined` to hide an inherited one.
   * @param operation - operation to invoke.
   * @returns the exact value returned by `operation`.
   */
  run<T>(tenant: Tenant | undefined, operation: () => T): T {
    return this.paths.run(tenant, operation)
  }

  /** One tenant already admitted in this process, by username. */
  get(username: string): Tenant | undefined {
    for (const entry of this.cache.values()) {
      if (entry.tenant.username === username) return entry.tenant
    }
    return undefined
  }

  /**
   * Synchronously read one already-admitted tenant.
   *
   * Connection's admission path is synchronous — it runs inside an HTTP route
   * handler that cannot await a network call before deciding whether to answer
   * at all — so first contact must go through {@link resolve}. This is the read
   * that path uses, and it never calls out.
   * @param token - token as presented by the browser.
   * @returns the tenant, or undefined when this token is unknown or expired.
   */
  peek(token: string): Tenant | undefined {
    const key = digestToken(token)
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.tenant
  }

  /**
   * Resolve one presented token, consulting the auth endpoint on a cache miss.
   *
   * The caller is expected to have already established the Host/Origin fence;
   * this method answers only "who is this", never "may they enter".
   * @param token - token as presented by the browser.
   * @returns the tenant, or the reason the token could not be honored.
   */
  async resolve(token: string): Promise<TenantResolution> {
    const presented = token.trim()
    if (presented.length === 0) return { ok: false, reason: 'invalid-token' }

    const key = digestToken(presented)
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      if (cached.expiresAt > now) return hit(cached)
      this.cache.delete(key)
    }

    if (!this.verify) {
      return this.admit({ userId: presented, username: presented }, key, now)
    }

    const fetched = await this.fetchUser(presented)
    if (fetched.kind !== 'user') {
      return { ok: false, reason: fetched.kind === 'invalid' ? 'invalid-token' : 'upstream-unavailable' }
    }
    return this.admit(fetched.user, key, now)
  }

  /**
   * Materialize one admitted user: validate the folder name, create the
   * workspace, store the model key, and cache the result.
   */
  private async admit(user: AuthUser, key: string, now: number): Promise<TenantResolution> {
    if (!USERNAME_PATTERN.test(user.username)) return { ok: false, reason: 'bad-username' }
    const home = this.paths.homeOf(user.username)
    const tenant: Tenant = {
      username: user.username,
      userId: user.userId,
      displayName: user.displayName ?? user.username,
      ...user.email === undefined ? {} : { email: user.email },
      ...user.avatar === undefined ? {} : { avatar: user.avatar },
      home,
      workspace: join(home, 'workspace'),
    }
    await mkdir(tenant.workspace, { recursive: true, mode: 0o700 })
    if (user.models?.apiKey !== undefined) await this.storeApiKey(tenant, user.models.apiKey)
    this.cache.set(key, {
      tenant,
      ...user.models === undefined ? {} : { models: user.models },
      expiresAt: Math.min(now + this.cacheSeconds * 1000, user.expiresAt ?? Number.MAX_SAFE_INTEGER),
    })
    return user.models === undefined ? { ok: true, tenant } : { ok: true, tenant, models: user.models }
  }

  /**
   * Write one tenant's provider key into *its* credentials document.
   *
   * The ambient tenant is what routes the write, so this is the whole of "each
   * person gets their own model key": no LLM adapter learns that tenants exist.
   */
  private async storeApiKey(tenant: Tenant, apiKey: string): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      report('tenant: no credentials provider; skipping the model key for %s', tenant.username)
      return
    }
    await this.paths.run(tenant, async () => {
      const current = await credentials.resolve(this.apiKeyRef)
      if (current?.value === apiKey) return
      await credentials.set(this.apiKeyRef, apiKey)
    })
  }

  /** Call the deployment auth endpoint and normalize its envelope. */
  private async fetchUser(token: string): Promise<FetchOutcome> {
    const endpoint = this.authEndpoint
    /*
     * Every branch below logs at `warn`, including the successful ones.
     *
     * Verification runs once per login, so it is not a noisy path, and when it
     * fails the operator's only question is "did the request leave this process,
     * and what came back?" — a question the default log level has to be able to
     * answer without a restart. The plaintext token is never logged.
     */
    report('tenant: verifying a token against %s', endpoint)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error: unknown) {
      // `fetch` reports every transport failure as a bare `TypeError: fetch
      // failed`. The actionable part — DNS, TLS, connection refused, a proxy
      // that would not tunnel — is on `cause`, so it is rendered here rather
      // than collapsed into the string the caller would otherwise see.
      report(
        'tenant: %s is unreachable: %s%s',
        endpoint,
        String(error),
        describeCause(error),
      )
      return { kind: 'unavailable' }
    }
    report('tenant: %s answered HTTP %d', endpoint, response.status)
    if (response.status === 401 || response.status === 403) return { kind: 'invalid' }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      report(
        'tenant: %s answered HTTP %d with %s',
        endpoint,
        response.status,
        detail.length === 0 ? 'an empty body' : detail.slice(0, 400),
      )
      return { kind: 'unavailable' }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      report('tenant: %s answered with a body that is not JSON: %s', endpoint, String(error))
      return { kind: 'unavailable' }
    }
    const envelope = readEnvelope(body)
    if (envelope === undefined) {
      report('tenant: %s answered with an unrecognized envelope: %s', endpoint, preview(body))
      return { kind: 'unavailable' }
    }
    if (envelope.code !== 0) {
      report('tenant: %s rejected the token with code %d', endpoint, envelope.code)
      return envelope.code === 401 ? { kind: 'invalid' } : { kind: 'unavailable' }
    }
    const user = readUser(envelope.data)
    if (user === undefined) {
      report(
        'tenant: %s returned a user record without a usable userId/username: %s',
        endpoint,
        preview(envelope.data),
      )
      return { kind: 'unavailable' }
    }
    report('tenant: %s admitted "%s"', endpoint, user.username)
    return { kind: 'user', user }
  }
}

/**
 * Report one observation from the auth flow.
 *
 * Written to the console rather than through `ctx.logger`, because the shipped
 * CLI mounts no logger backend — the Cordis logger would discard every line.
 * The question these lines exist to answer is "did the request leave this
 * process, and what came back?", and that has to be answerable from the
 * terminal that started the server. Login happens once per person, so the
 * volume is negligible and the level is always on. The plaintext token is
 * never among the arguments.
 */
function report(message: string, ...rest: readonly unknown[]): void {
  console.warn(message, ...rest)
}

/**
 * Render one `fetch` failure together with the cause it hides.
 *
 * undici nests the real reason one or two levels down (`fetch failed` →
 * `connect ECONNREFUSED …` → the proxy's own error), and a code is often the
 * only stable part. Two levels is where the useful detail has always been.
 */
function describeCause(error: unknown): string {
  const parts: string[] = []
  let current: unknown = (error as { readonly cause?: unknown }).cause
  for (let depth = 0; depth < 2 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    parts.push(code === undefined ? String(current) : `${String(current)} [${String(code)}]`)
    current = (current as { readonly cause?: unknown }).cause
  }
  return parts.length === 0 ? '' : ` — cause: ${parts.join(' ← ')}`
}

/** Trim one value for a log line without letting a huge body through. */
function preview(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return (text ?? String(value)).slice(0, 400)
  } catch {
    return String(value)
  }
}

/** Rebuild one successful resolution from its cache entry. */
function hit(cached: CachedTenant): TenantResolution {
  return cached.models === undefined
    ? { ok: true, tenant: cached.tenant }
    : { ok: true, tenant: cached.tenant, models: cached.models }
}

/**
 * The cache key for one presented token.
 *
 * A digest, never the token itself: this map outlives the request that carried
 * the credential, and a heap dump or a debugger attached to the process must
 * not yield anything replayable.
 * @param token - token as presented by the browser.
 * @returns its base64url sha256.
 */
function digestToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the `{ code, msg, data }` envelope the auth contract specifies. */
function readEnvelope(body: unknown): { readonly code: number; readonly data: unknown } | undefined {
  if (!isRecord(body)) return undefined
  const code = body.code
  if (typeof code !== 'number' || !Number.isFinite(code)) return undefined
  return { code, data: body.data }
}

/** Read one user record, ignoring fields that are absent or mistyped. */
function readUser(data: unknown): AuthUser | undefined {
  if (!isRecord(data)) return undefined
  const userId = readIdentifier(data.userId)
  const { username } = data
  if (userId === undefined) return undefined
  if (typeof username !== 'string' || username.length === 0) return undefined
  const models = readModels(data.models)
  return {
    userId,
    username,
    ...typeof data.displayName === 'string' ? { displayName: data.displayName } : {},
    ...typeof data.email === 'string' ? { email: data.email } : {},
    ...typeof data.avatar === 'string' ? { avatar: data.avatar } : {},
    ...typeof data.expiresAt === 'number' ? { expiresAt: data.expiresAt } : {},
    ...models === undefined ? {} : { models },
  }
}

/**
 * Read an identifier the endpoint may send as either a string or a number.
 *
 * Numeric user ids are the common case in JSON APIs, and `userId` never becomes
 * a path — `username` does, and it stays a string. Demanding a string here would
 * refuse an otherwise correct deployment over a representation choice the
 * contract had no reason to pin down.
 */
function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Read the optional per-user model block. */
function readModels(value: unknown): TenantModels | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...typeof value.provider === 'string' ? { provider: value.provider } : {},
    ...typeof value.baseURL === 'string' ? { baseURL: value.baseURL } : {},
    ...typeof value.apiKey === 'string' && value.apiKey.length > 0 ? { apiKey: value.apiKey } : {},
    ...typeof value.model === 'string' ? { model: value.model } : {},
    ...value.thinking === 'enabled' || value.thinking === 'disabled' ? { thinking: value.thinking } : {},
    ...value.reasoningEffort === 'off' || value.reasoningEffort === 'low'
      || value.reasoningEffort === 'high' || value.reasoningEffort === 'max'
      ? { reasoningEffort: value.reasoningEffort }
      : {},
    ...typeof value.maxTokens === 'number' ? { maxTokens: value.maxTokens } : {},
  }
}

/**
 * Install the tenant layer.
 *
 * Both services register themselves through their Service base, which is also
 * what ties their teardown to this plugin's fiber.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved: Config = {
    ...config,
    verify: config?.verify ?? true,
    authEndpoint: config?.authEndpoint ?? 'https://admin.longtongjiyun.com/v1/api/notify/harnessAuth',
    cacheSeconds: config?.cacheSeconds ?? 300,
    requestTimeoutMs: config?.requestTimeoutMs ?? 10_000,
    apiKeyRef: config?.apiKeyRef ?? 'DEEPSEEK_API_KEY',
  }
  const paths = new TenantPathsService(ctx, resolved)
  void new TenantRegistry(ctx, paths, resolved)
}
