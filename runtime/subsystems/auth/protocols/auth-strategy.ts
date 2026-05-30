/**
 * Auth subsystem — `IAuthStrategy` port.
 *
 * The credentials-resolution seam used by every connection adapter. Adapters
 * depend on this interface; concrete strategies (SalesforceAuthStrategy,
 * HubSpotAuthStrategy, future Gmail/Calendar) typically extend the
 * `OAuth2RefreshStrategy` template-method base in `../runtime/`.
 *
 * See `docs/adrs/ADR-031-auth-subsystem.md` and
 * `docs/gate-1-auth-extraction-findings.md` (extraction-source findings) for
 * the rationale.
 */

/**
 * Credentials the adapter consumes — opaque bag at this boundary. Provider-
 * specific shapes (`instanceUrl` for Salesforce, no host for HubSpot) live
 * inside as extra fields.
 */
export interface AuthCredentials {
  accessToken: string;
  /** OAuth refresh token if the adapter needs to inspect it. Usually omitted. */
  refreshToken?: string;
  /** Provider-specific extras (instance URL, api version, scope list, …). */
  [extra: string]: unknown;
}

export interface AuthResolveOptions {
  /**
   * Force the strategy to bypass its cache and mint fresh credentials.
   * Callers use this after catching a session-expired error; a second
   * resolve that still returns an expired token fails hard rather than
   * looping.
   */
  forceRefresh?: boolean;
}

/**
 * Auth-strategy contract shared by every connection adapter. Implementations
 * typically extend `OAuth2RefreshStrategy` and override four small hooks.
 */
export interface IAuthStrategy {
  resolve(
    connectionId: string,
    opts?: AuthResolveOptions,
  ): Promise<AuthCredentials>;
}
