/**
 * Thrown when an OAuth2 provider returns `400 invalid_grant`/`invalid_token`
 * on refresh — the refresh token itself is dead (user revoked, org
 * deactivated, token expired beyond the provider's rotation window). The
 * connection should be marked broken so background sync stops picking it
 * up; the user re-initiates OAuth.
 *
 * Shared across every OAuth2 strategy.
 */
export class ConnectionBrokenError extends Error {
  constructor(
    readonly connectionId: string,
    readonly errorCode: string,
    readonly errorDescription: string,
  ) {
    super(
      `Connection ${connectionId} broken: ${errorCode} - ${errorDescription}`,
    );
    this.name = 'ConnectionBrokenError';
  }
}
