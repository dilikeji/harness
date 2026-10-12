/**
 * The tenant token the browser presents on every Host request.
 *
 * The page reads the token from its own URL on first load, keeps it here, and
 * presents it on each request. `localStorage` rather than a cookie is the whole
 * point of the change: a cookie is attached by the browser to whoever holds it
 * and carries no identity, while an explicit header makes the credential
 * visible to the code that sends it and able to name a person.
 *
 * The in-memory copy is authoritative for the page's lifetime. Storage can be
 * unavailable (blocked cookies, private mode, a page with no origin) and the
 * session must still work, so every storage access is best-effort.
 * @module @deepseek-ai/dsh-client-connection/src/client/tenant-token
 */

/** `localStorage` key holding the tenant token across page loads. */
export const TENANT_TOKEN_STORAGE_KEY = 'dsh.token'

/** Header carrying the tenant token on unary `/api` requests. */
export const TENANT_TOKEN_HEADER = 'x-dsh-token'

/** Query parameter carrying the tenant token on WebSocket upgrades. */
export const TENANT_TOKEN_QUERY = 'token'

/**
 * The slice of the Web Storage API this module uses.
 *
 * Declared structurally rather than naming the DOM's `Storage`: this file is
 * compiled on both faces (the Host builds it too, because `client/rpc.ts`
 * imports it), and a node-face build has no DOM library.
 */
interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

let memory: string | undefined

/** The page's storage, when it has one. */
function storage(): TokenStorage | undefined {
  return (globalThis as { readonly localStorage?: TokenStorage }).localStorage
}

/**
 * Read the stored tenant token.
 * @returns the token, or undefined when this page has never authenticated.
 */
export function readTenantToken(): string | undefined {
  if (memory !== undefined) return memory
  try {
    const stored = storage()?.getItem(TENANT_TOKEN_STORAGE_KEY)
    if (stored !== null && stored !== undefined && stored.length > 0) {
      memory = stored
      return memory
    }
  } catch {
    // Storage refused the read; the in-memory copy still serves this page.
  }
  return undefined
}

/**
 * Persist one token for this page and later page loads.
 * @param token - the entry token read from the URL.
 */
export function writeTenantToken(token: string): void {
  memory = token
  try {
    storage()?.setItem(TENANT_TOKEN_STORAGE_KEY, token)
  } catch {
    // See readTenantToken: the in-memory copy still serves this page.
  }
}

/** Forget the token; the next request will be unauthenticated. */
export function clearTenantToken(): void {
  memory = undefined
  try {
    storage()?.removeItem(TENANT_TOKEN_STORAGE_KEY)
  } catch {
    // Nothing was persisted to clear.
  }
}

/**
 * Headers one authenticated unary request must carry.
 * @returns the token header, or an empty object when nothing is stored.
 */
export function tenantAuthHeaders(): Record<string, string> {
  const token = readTenantToken()
  return token === undefined ? {} : { [TENANT_TOKEN_HEADER]: token }
}
