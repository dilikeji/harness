/**
 * Where a tenant token may appear on a request, and how to read it.
 *
 * Two carriers exist because the two transports differ in what they can say:
 * a unary `/api` call sets headers, a WebSocket upgrade cannot. The header form
 * is therefore the only one an ordinary request may use, and the query form is
 * opt-in at the call site — an ordinary request that happened to carry `?token=`
 * would otherwise put a live credential into every access log in the path.
 * @module @deepseek-ai/dsh-client-connection/src/tenant-token
 */

/** Header carrying the tenant token on unary `/api` requests. */
export const TENANT_TOKEN_HEADER = 'x-dsh-token'

/**
 * Query parameter carrying the tenant token on WebSocket upgrades.
 *
 * Browser WebSocket clients cannot set request headers, so the upgrade carries
 * its token in the URL.
 */
export const TENANT_TOKEN_QUERY = 'token'

/** The request facts token extraction reads. */
export interface TokenBearingRequest {
  /** Request headers from either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
  /**
   * Request URL, present only for WebSocket upgrades.
   *
   * Supplying it is what admits the query-parameter form; a unary request must
   * leave it out so its token can only ever travel in a header.
   */
  readonly url?: string | undefined
}

function header(
  headers: TokenBearingRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read the tenant token one request presents.
 * @param request - headers, and the URL only for a WebSocket upgrade.
 * @returns the presented token, or undefined when the request carries none.
 */
export function presentedToken(request: TokenBearingRequest): string | undefined {
  const direct = header(request.headers, TENANT_TOKEN_HEADER)
  if (direct !== undefined && direct.length > 0) return direct
  if (request.url === undefined) return undefined
  try {
    const value = new URL(request.url, 'http://dsh.invalid').searchParams.get(TENANT_TOKEN_QUERY)
    return value !== null && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
