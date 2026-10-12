/**
 * Multi-tenant HTTP endpoints.
 *
 * Three routes, each one a question the browser cannot answer alone:
 *
 * - `POST /api/tenant/session` — exchange an entry token for an identity. This
 *   is the route that *creates* the tenant the rest of the API requires, which
 *   is why Connection publishes it before authentication.
 * - `GET /api/tenant/me` — re-read an identity on reload, against a cache that
 *   usually answers without calling the deployment.
 * - `GET /api/tenant/files/download` — stream one workspace file to the
 *   browser, path-checked against the caller's own workspace root.
 *
 * They live in their own package rather than inside the tenant service so that
 * `@deepseek-ai/dsh-tenant` stays a pure identity layer. The HTTP carrier
 * depends on *that* package for its Peer type, so a route layer inside it would
 * have to import the carrier back — a cycle. Here the dependency is one-way.
 *
 * The first two are also the only `/api` paths Connection admits before
 * authentication, by exact path. `DEFAULT_PUBLIC_API_PATHS` in the carrier is
 * the other half of that contract: adding a route below `/api/tenant/` does
 * **not** publish it.
 * @module @deepseek-ai/dsh-api-tenant-controller
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { presentedToken } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Tenant, TenantModels, TenantResolutionFailure } from '@deepseek-ai/dsh-tenant'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** Cordis plugin name. */
export const name = 'tenant-controller'

/** Identity layer, the HTTP carrier it registers routes on, and the workspace registry. */
export const inject = ['tenants', 'connection', 'workspaceRegistry']

/** Route paths; the first two must match the carrier's public-path list. */
export const LOGIN_PATH = '/api/tenant/session'
export const ME_PATH = '/api/tenant/me'
export const DOWNLOAD_PATH = '/api/tenant/files/download'

/** Plugin config. */
export interface Config {
  /** Whether the workspace download route is mounted. Default: true. */
  download?: boolean
}

export const Config: z<Config> = z.object({
  download: z.boolean().default(true),
})

/** How each resolution failure is reported to the browser. */
const FAILURES: Record<TenantResolutionFailure, { readonly status: number; readonly msg: string }> = {
  'invalid-token': { status: 401, msg: 'token 无效或已过期' },
  'upstream-unavailable': { status: 502, msg: '认证服务暂时不可用，请稍后重试' },
  'bad-username': { status: 500, msg: '认证服务返回了无法作为目录名的用户名，请联系管理员' },
}

/** One `{ code, msg, data }` response, the envelope the API contract documents. */
function envelope(status: number, code: number, msg: string, data: unknown): Response {
  return Response.json({ code, msg, data }, { status })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the token a login call presents.
 *
 * Both forms are accepted here, unlike everywhere else: the page reads its
 * token from the URL, so it may arrive in the body (a plain POST) or in the
 * header (a caller that already knows the contract). The query form is not
 * accepted — this route is reachable, and a token in its URL would land in
 * every access log on the way in.
 */
async function presentedLoginToken(request: Request): Promise<string | undefined> {
  const fromHeader = presentedToken({ headers: request.headers })
  if (fromHeader !== undefined) return fromHeader
  if (request.method !== 'POST') return undefined
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  const token = asRecord(body)?.token
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/**
 * The caller's one workspace, created on first sight.
 *
 * A tenant has exactly one workspace and cannot switch: the directory is
 * derived from the username, so "which workspace" is never a choice the client
 * makes. Racing logins resolve to the same record — `create` is serialized
 * inside the registry, and losing that race just means re-reading what the
 * winner wrote.
 */
async function ensureWorkspace(
  ctx: Context,
  tenant: Tenant,
): Promise<{ readonly workspace: Workspace; readonly created: boolean } | undefined> {
  const registry = ctx.workspaceRegistry
  const existing = await registry.resolveByPath(tenant.workspace)
  if (existing !== undefined) return { workspace: existing, created: false }
  try {
    // Titled by `username`, not `displayName`: this is the tenant's own folder
    // name, so the sidebar label matches the directory the person actually
    // owns. A display name is free text and may repeat across tenants.
    return { workspace: await registry.create(tenant.workspace, tenant.username), created: true }
  } catch {
    const raced = await registry.resolveByPath(tenant.workspace)
    return raced === undefined ? undefined : { workspace: raced, created: false }
  }
}

/**
 * Project one tenant into the response the page reads.
 *
 * The model block deliberately omits `apiKey`: the browser never needs it, and
 * a key that never crosses this boundary cannot leak from it.
 */
function sessionPayload(
  tenant: Tenant,
  models: TenantModels | undefined,
  workspace: Workspace,
  created: boolean,
): object {
  return {
    user: {
      userId: tenant.userId,
      username: tenant.username,
      displayName: tenant.displayName,
      ...tenant.email === undefined ? {} : { email: tenant.email },
      ...tenant.avatar === undefined ? {} : { avatar: tenant.avatar },
    },
    workspace: {
      id: workspace.id,
      path: workspace.path,
      created,
    },
    ...models === undefined ? {} : {
      models: {
        ...models.provider === undefined ? {} : { provider: models.provider },
        ...models.model === undefined ? {} : { model: models.model },
      },
    },
  }
}

/**
 * Prepare one tenant's data-plane state before its first request is served.
 *
 * Domain-backed services read their handles **synchronously**
 * (`WorkspaceRegistry.list()` and the archived/pinned getters), and a
 * synchronous read cannot await a first open. A tenant's copies of those
 * documents therefore have to exist before anything asks for them — and login
 * is the one moment that knows a tenant just became real, which makes it the
 * only correct place to do this.
 *
 * Warming is per-tenant state, so it must run inside the tenant's ambient
 * context; the caller establishes that before invoking this.
 */
async function warmTenantDataPlane(ctx: Context): Promise<void> {
  await ctx.workspaceRegistry.warm()
  await ctx.get('sessionProjectionCache')?.warm()
  await ctx.get('schedule')?.warm()
}

/**
 * Resolve the presented token and answer with the tenant it names.
 *
 * The workspace is prepared inside the tenant's own ambient context, so the
 * registry record it writes lands under the right tenant root.
 */
async function establish(ctx: Context, request: Request): Promise<Response> {
  const token = await presentedLoginToken(request)
  if (token === undefined) return envelope(400, 400, '缺少 token', null)
  const resolution = await ctx.tenants.resolve(token)
  if (!resolution.ok) {
    const failure = FAILURES[resolution.reason]
    return envelope(failure.status, failure.status, failure.msg, null)
  }
  const { tenant, models } = resolution
  return ctx.tenants.run(tenant, async () => {
    await warmTenantDataPlane(ctx)
    const ensured = await ensureWorkspace(ctx, tenant)
    if (ensured === undefined) return envelope(500, 500, '工作区无法建立，请联系管理员', null)
    return envelope(200, 0, 'ok', sessionPayload(tenant, models, ensured.workspace, ensured.created))
  })
}

/**
 * Confine one request path to a root directory.
 *
 * Two checks, not one. The lexical check stops `../` before any filesystem
 * call; the canonical check after `realpath` stops a symlink that points out of
 * the workspace, which no amount of string comparison would catch. `resolve`
 * uses the platform separator, so a Windows backslash path cannot slip past a
 * `/`-only suffix test.
 */
async function confine(root: string, relative: string): Promise<string | undefined> {
  const lexical = resolve(root, relative)
  if (lexical !== root && !lexical.startsWith(root + sep)) return undefined
  const canonical = await realpath(lexical).catch(() => undefined)
  if (canonical === undefined) return undefined
  if (canonical !== root && !canonical.startsWith(root + sep)) return undefined
  return canonical
}

/** An attachment filename that survives both ASCII and RFC 5987 readers. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\u0020-\u007e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Stream one file out of the caller's workspace. */
async function download(ctx: Context, request: Request): Promise<Response> {
  const tenant = ctx.tenants.current()
  // Unreachable through the carrier — this route is not public, so a tenant is
  // always ambient — but a route handler that trusts that would be one config
  // edit away from serving an arbitrary directory.
  if (tenant === undefined) return envelope(401, 401, '未认证', null)

  const relative = new URL(request.url).searchParams.get('path')
  if (relative === null || relative.length === 0) return envelope(400, 400, '缺少 path 参数', null)

  const root = await realpath(tenant.workspace).catch(() => undefined)
  if (root === undefined) return envelope(404, 404, '工作区不存在', null)

  const target = await confine(root, relative)
  if (target === undefined) return envelope(400, 400, 'path 越界或文件不存在', null)

  const info = await stat(target).catch(() => undefined)
  if (info?.isFile() !== true) return envelope(404, 404, '文件不存在', null)

  const bytes = await readFile(target)
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(basename(target)),
      'content-length': String(bytes.byteLength),
    },
  })
}

/**
 * Mount the tenant routes.
 * @param ctx - plugin context carrying the identity layer and the HTTP carrier.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const routes: ConnectionFetchRoute[] = [
    { path: LOGIN_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => establish(ctx, request) },
    { path: ME_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => establish(ctx, request) },
  ]
  if (config.download ?? true) {
    routes.push({
      path: DOWNLOAD_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => download(ctx, request),
    })
  }
  for (const route of routes) ctx.connection.fetch.register(route)
}
