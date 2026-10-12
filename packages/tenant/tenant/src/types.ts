/**
 * Public types of the multi-tenant identity layer.
 *
 * A **tenant** is one person's slice of a single Harness process: one home
 * directory, one workspace, one credentials document, one session history.
 * Tenants are keyed by `username`, which the deployment's auth endpoint owns
 * and is therefore the only stable word for "whose data is this".
 * @module @deepseek-ai/dsh-tenant/types
 */

/**
 * One tenant's resolved identity and directories.
 *
 * `home` and `workspace` are absolute. The directories exist by the time a
 * Tenant leaves the registry; callers never have to create them.
 */
export interface Tenant {
  /** Folder name under the tenant root; equals the auth endpoint's `username`. */
  readonly username: string
  /** Deployment-owned stable user id. Diagnostic only — never used as a path. */
  readonly userId: string
  /** Human-facing name; falls back to `username` when the endpoint omits one. */
  readonly displayName: string
  /** Optional contact address, display only. */
  readonly email?: string
  /** Optional avatar URL, display only. */
  readonly avatar?: string
  /** Absolute tenant home: `<tenantRoot>/<username>`. */
  readonly home: string
  /** Absolute workspace root: `<home>/workspace`, the cwd every session starts in. */
  readonly workspace: string
}

/**
 * The model configuration a deployment hands back with a user record.
 *
 * Only `apiKey` reaches durable storage; the rest is advisory metadata the
 * caller may surface. Keeping the key here is what makes two tenants use two
 * different provider keys without touching any LLM adapter: resolution runs
 * through the tenant-scoped credentials document.
 */
export interface TenantModels {
  /** Provider route name; defaults to the deployment's own. */
  readonly provider?: string
  /** Provider endpoint base. */
  readonly baseURL?: string
  /** Provider API key, written into this tenant's credentials document. */
  readonly apiKey?: string
  /** Default model id. */
  readonly model?: string
  /** Thinking toggle. */
  readonly thinking?: 'enabled' | 'disabled'
  /** Reasoning effort. */
  readonly reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Per-response output cap. */
  readonly maxTokens?: number
}

/** One user record, normalized from the auth endpoint's response envelope. */
export interface AuthUser {
  readonly userId: string
  readonly username: string
  readonly displayName?: string
  readonly email?: string
  readonly avatar?: string
  /** Absolute token expiry in Unix milliseconds, when the endpoint reports one. */
  readonly expiresAt?: number
  readonly models?: TenantModels
}

/** Why a token did not resolve to a tenant. */
export type TenantResolutionFailure =
  /** The endpoint rejected the token, or the token was empty. */
  | 'invalid-token'
  /** The endpoint was unreachable or answered with something unusable. */
  | 'upstream-unavailable'
  /** The endpoint returned a username outside the addressable grammar. */
  | 'bad-username'

/** Outcome of resolving one token. */
export type TenantResolution =
  | { readonly ok: true; readonly tenant: Tenant; readonly models?: TenantModels }
  | { readonly ok: false; readonly reason: TenantResolutionFailure }
