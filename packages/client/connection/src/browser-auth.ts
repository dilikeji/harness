/**
 * Tenant-token authentication for the Host Connection carrier.
 *
 * ## What changed from the upstream single-user design
 *
 * Upstream, `?token=` was a **process** launch token exchanged once for an
 * `HttpOnly` signed cookie; afterwards every request was the same anonymous
 * operator. Multi-tenant operation cannot work that way — a cookie is one
 * browser's credential and carries no identity, so two people on the same
 * origin would be indistinguishable, and `SameSite=Strict` plus the absence of
 * a logout made revoking one person impossible without disturbing everyone.
 *
 * Now the token is the **user's** token. The page reads it from its URL on
 * first load, keeps it in `localStorage`, and presents it on every request — as
 * `x-dsh-token` on unary calls, as `?token=` on WebSocket upgrades.
 *
 * This class owns only the carrier-level questions: where a token may appear,
 * and whether the index is servable. Whether a presented token is *valid* is
 * the tenant registry's business, and Connection asks it directly — keeping
 * presence ({@link isAuthenticated}) and validity apart is what lets a request
 * be admitted against a cache warmed by the login call.
 * @module @deepseek-ai/dsh-client-connection/src/browser-auth
 */

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { presentedToken } from './tenant-token.ts'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

/**
 * Carrier-level authentication for the Host Connection.
 *
 * The instance holds no secret: the upstream design needed a signing key to
 * mint cookies, and with cookies gone there is nothing to sign. The class
 * survives its own emptiness because it remains the one seam that answers
 * "where does a token come from" for both the HTTP route and the upgrade path.
 */
export class BrowserAuth {
  private constructor() {}

  /**
   * Initialize carrier authentication.
   *
   * The parameters are retained so existing compositions and tests keep
   * compiling; none is consulted any more. The signing secret in particular is
   * gone — there is no cookie to sign.
   * @param _processOwner - unused; formerly the owner of the launch token.
   * @param _credentials - unused; formerly the storage of the signing secret.
   * @param _maxAgeDays - unused; formerly the cookie lifetime.
   * @returns the stateless authentication owner.
   */
  static create(
    _processOwner: object,
    _credentials: CredentialProvider,
    _maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return Promise.resolve(new BrowserAuth())
  }

  /**
   * Present an application URL to a user.
   *
   * Upstream this appended the process launch token. The token now belongs to
   * the deployment, which hands the browser its own entry URL, so the base URL
   * is returned unchanged: a startup banner prints a URL people can open, and
   * the page explains that it needs an entry token when it has none.
   * @param baseUrl - clean application URL.
   * @returns the same URL, unmodified.
   */
  authenticatedUrl(baseUrl: string): string {
    return baseUrl
  }

  /**
   * Decide whether one request may be served the application index.
   *
   * Always true: the index is a static shell holding no user data, and it must
   * be servable to a browser that has not authenticated yet — reading the token
   * out of its own URL is precisely what the page does first.
   * @param _req - incoming index request.
   * @param _res - response, never owned by this method.
   * @returns true, so the caller serves index.html.
   */
  authorizeIndex(_req: ConnectionIndexRequest, _res: ConnectionIndexResponse): boolean {
    return true
  }

  /**
   * Whether one request presents a tenant token at all.
   *
   * Presence only. The registry decides validity, and Connection consults it
   * through `admit`. Do not read this as authorization.
   * @param request - request headers, and the URL for an upgrade.
   * @returns true when a token is present, whether or not it resolves.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    return presentedToken({ headers: request.headers }) !== undefined
  }
}
