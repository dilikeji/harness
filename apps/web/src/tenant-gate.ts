/**
 * The tenant gate: the page's own authentication step, run before any UI.
 *
 * Upstream the browser never authenticated itself — the URL carried a process
 * launch token that the Host traded for an `HttpOnly` cookie, so the page could
 * not know who it was and did not need to. Under tenant authentication the page
 * holds the credential, so it must establish identity *first*: starting the UI
 * before a tenant exists would render a shell whose every request comes back
 * 401.
 *
 * The token reaches the browser on its URL (the deployment's entry link). It is
 * moved into `localStorage` and then stripped from the address bar, so a later
 * screenshot, a Referer header, or a proxy access log cannot leak a live
 * credential.
 *
 * ## Storage keys are a contract
 *
 * This module reads and writes `dsh.token` directly rather than importing the
 * Connection client's helpers. Importing that entry point here would pull the
 * whole client plugin — Cordis registration included — into the pre-boot
 * bundle, giving the process two copies of it. The key therefore has a second
 * definition, and the two must move together:
 * `packages/client/connection/src/client/tenant-token.ts`.
 * @module apps/web/src/tenant-gate
 */

/** `localStorage` key holding the tenant token; must match the Connection client. */
const TOKEN_STORAGE_KEY = 'dsh.token'

/** Where the deployment hands the browser its entry token. */
const TOKEN_QUERY = 'token'

/** Host endpoint that exchanges a token for a tenant identity. */
const SESSION_ENDPOINT = '/api/tenant/session'

/** Header the exchange presents its token in. */
const TOKEN_HEADER = 'x-dsh-token'

/** The identity this page runs as, published for UI that shows who is signed in. */
export interface TenantIdentity {
  readonly token: string
  readonly user: {
    readonly userId: string
    readonly username: string
    readonly displayName: string
    readonly email?: string
    readonly avatar?: string
  }
  readonly workspace: {
    readonly id: string
    readonly path: string
    readonly created: boolean
  }
}

/** Page global carrying the established identity; absent until the gate passes. */
interface TenantGlobal {
  __DSH_TENANT__?: TenantIdentity
}

function storage(): Storage | undefined {
  return (globalThis as { readonly localStorage?: Storage }).localStorage
}

/** Read the token this page should run as, preferring the URL over storage. */
function captureToken(): string | undefined {
  const fromUrl = new URLSearchParams(location.search).get(TOKEN_QUERY)
  if (fromUrl !== null && fromUrl.length > 0) {
    storeToken(fromUrl)
    stripTokenFromUrl()
    return fromUrl
  }
  try {
    const stored = storage()?.getItem(TOKEN_STORAGE_KEY)
    return stored !== null && stored !== undefined && stored.length > 0 ? stored : undefined
  } catch {
    return undefined
  }
}

function storeToken(token: string): void {
  try {
    storage()?.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // The gate still admits this page load; only the next reload loses the token.
  }
}

/** Remove the token from the address bar so it cannot leak through logs or Referer. */
function stripTokenFromUrl(): void {
  const url = new URL(location.href)
  url.searchParams.delete(TOKEN_QUERY)
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function forgetToken(): void {
  try {
    storage()?.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // Nothing was persisted to remove.
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the exchange response into an identity.
 *
 * The Host is the only party that validated the token, so a malformed body is
 * treated as a broken deployment rather than something to repair here.
 */
function readIdentity(body: unknown, token: string): TenantIdentity | undefined {
  const envelope = asRecord(body)
  if (envelope === undefined || envelope.code !== 0) return undefined
  const data = asRecord(envelope.data)
  const user = asRecord(data?.user)
  const workspace = asRecord(data?.workspace)
  const { userId, username, displayName, email, avatar } = user ?? {}
  if (typeof userId !== 'string' || typeof username !== 'string' || typeof displayName !== 'string') {
    return undefined
  }
  if (workspace === undefined
    || typeof workspace.id !== 'string' || typeof workspace.path !== 'string') {
    return undefined
  }
  return {
    token,
    user: {
      userId,
      username,
      displayName,
      ...typeof email === 'string' ? { email } : {},
      ...typeof avatar === 'string' ? { avatar } : {},
    },
    workspace: {
      id: workspace.id,
      path: workspace.path,
      created: workspace.created === true,
    },
  }
}

/** Render a blocking notice in place of the application. */
function renderNotice(container: HTMLElement, title: string, detail: string): void {
  container.replaceChildren()
  const shell = document.createElement('div')
  shell.setAttribute('style', [
    'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
    'gap:14px', 'min-height:100vh', 'padding:32px', 'box-sizing:border-box',
    'background:#0b0b0d', 'text-align:center',
    'font-family:system-ui,-apple-system,"Segoe UI",system-ui,sans-serif',
  ].join(';'))
  const heading = document.createElement('div')
  // textContent, never innerHTML: the strings here are ours, but the habit is
  // what keeps a future refactor from interpolating someone else's.
  heading.textContent = title
  heading.setAttribute('style', 'font-size:17px;font-weight:600;letter-spacing:.02em;color:#e8c37a')
  const body = document.createElement('div')
  body.textContent = detail
  body.setAttribute('style', 'font-size:13px;line-height:1.75;color:#bfb49b;max-width:32em')
  shell.append(heading, body)
  container.append(shell)
}

/**
 * Establish the tenant this page runs as, rendering a notice and returning
 * false when it cannot.
 *
 * Runs before any UI starts. The Host side is a cache-aware lookup: a token it
 * has already seen resolves without calling the deployment, so reloading the
 * page costs one cheap round trip and does not hammer the auth service.
 * @param container - application mount point, used for the notice when blocked.
 * @returns true when an identity was established and the UI may start.
 */
export async function ensureTenant(container: HTMLElement): Promise<boolean> {
  const token = captureToken()
  if (token === undefined) {
    renderNotice(container, '需要登录', '请通过公司入口打开本页面；直接访问是未授权的。')
    return false
  }

  let response: Response
  try {
    response = await fetch(SESSION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ token }),
    })
  } catch {
    renderNotice(container, '无法连接', '认证服务暂时不可达，请稍后刷新重试。')
    return false
  }

  if (response.status === 401) {
    // Expired or revoked: drop the stored copy so the next load shows the same
    // door rather than retrying a token that will never work.
    forgetToken()
    renderNotice(container, '登录已失效', '请回到公司入口重新打开本页面。')
    return false
  }
  if (!response.ok) {
    renderNotice(container, '服务暂时不可用', `认证服务返回 ${String(response.status)}，请稍后刷新重试。`)
    return false
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    renderNotice(container, '响应无法解析', '认证服务返回了非预期的内容，请联系管理员。')
    return false
  }

  const identity = readIdentity(body, token)
  if (identity === undefined) {
    renderNotice(container, '身份无法识别', '认证服务返回了缺少必要字段的用户信息，请联系管理员。')
    return false
  }

  ;(globalThis as TenantGlobal).__DSH_TENANT__ = identity
  return true
}
