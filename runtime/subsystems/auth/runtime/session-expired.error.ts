/**
 * Provider-agnostic marker for "the access token was rejected; a forced
 * refresh may recover."
 *
 * Concrete provider error classes (e.g. SalesforceSessionExpiredError,
 * HubSpotUnauthorizedError) either extend `SessionExpiredError` directly or
 * set `isSessionExpired === true` on their instances. `withAuthRetry` uses
 * the `isSessionExpiredError` predicate to decide whether to force-refresh
 * and retry once.
 *
 * This discriminator replaces the SFDC-only `instanceof` check from the
 * extraction-source app's original `withAuthRetry`. See
 * `docs/gate-1-auth-extraction-findings.md` (recommendation 4).
 */
export class SessionExpiredError extends Error {
  /** Duck-type marker — works across package boundaries where `instanceof` fails. */
  readonly isSessionExpired = true as const;

  constructor(message = 'Access token rejected by provider') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Predicate used by `withAuthRetry` by default.
 *
 * Matches any error that either `instanceof SessionExpiredError` or carries
 * the `isSessionExpired === true` marker property. Provider adapters that
 * want their existing error classes to participate can simply add the
 * marker property without touching the class hierarchy.
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof SessionExpiredError) return true;
  if (err !== null && typeof err === 'object' && 'isSessionExpired' in err) {
    return (err as { isSessionExpired?: unknown }).isSessionExpired === true;
  }
  return false;
}
