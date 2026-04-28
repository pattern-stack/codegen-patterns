/**
 * Auth subsystem — integration storage ports.
 *
 * `OAuth2RefreshStrategy` reads decrypted integration rows and persists
 * refreshed tokens. The subsystem doesn't care what entity framework stores
 * those rows — consumers implement these narrow ports against whatever
 * `integrations` table their app uses.
 *
 * In the extraction-source app both ports are satisfied by a
 * pair of thin adapters over `IntegrationService` + `RefreshIntegrationUseCase`.
 * The codegen-patterns `examples/auth-integrations/` starter (separate PR)
 * ships a canonical `integration.yaml` whose generated service + use case
 * satisfy the shape out of the box.
 */

/**
 * An integration row with its secrets decrypted and ready to use.
 *
 * Consumers produce this shape from their own storage by passing stored
 * ciphertexts through `IEncryptionKey.decrypt`. The subsystem never sees
 * the ciphertext form.
 */
export interface DecryptedIntegration {
  id: string;
  /** Provider slug — must match the strategy's `provider`. */
  provider: string;
  /** Plaintext access token, or empty string if never granted. */
  accessToken: string;
  /** Plaintext refresh token, or null if not yet granted / revoked. */
  refreshToken: string | null;
  /** Access-token expiry wall time, or null if unknown. */
  expiresAt: Date | null;
  /** Opaque provider-specific metadata bag (instance URL, scopes, …). */
  providerMetadata?: Record<string, unknown> | null;
}

/**
 * Read port — fetches a decrypted integration by id.
 *
 * Adapters typically wrap a service/repo call that does the decryption
 * internally. `OAuth2RefreshStrategy.resolve()` calls this on every invocation.
 */
export interface IIntegrationReader {
  findByIdDecrypted(integrationId: string): Promise<DecryptedIntegration | null>;
}

/**
 * Write port — persists a refreshed access token (and optionally rotated
 * refresh token) with the new expiry.
 *
 * The subsystem calls this after a successful refresh. Implementations are
 * responsible for re-encrypting the tokens before they hit storage.
 *
 * `refreshToken` semantics: `undefined` means "provider did not rotate; keep
 * existing ciphertext". A rotated token comes through as a string.
 */
export interface IntegrationTokenUpdate {
  integrationId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

export interface IIntegrationTokenWriter {
  persistRefresh(update: IntegrationTokenUpdate): Promise<void>;
}

/**
 * Grant-sink port — persists a freshly-minted OAuth2 grant from the
 * authorize-code callback (i.e. the user just connected a new provider, or
 * re-connected an existing one).
 *
 * `AuthController.callback` invokes this after `IProviderStrategy.exchangeCodeForTokens`.
 * The subsystem itself never imports a concrete `IntegrationsService` — the
 * consumer's `auth-integrations` starter (or any equivalent) adapts this
 * port. Keeps the auth subsystem standalone: a non-codegen consumer can
 * satisfy the port against its own integrations storage.
 *
 * Semantics:
 *   - Upserts on `(userId, provider)`. Repeated grants for the same pair
 *     replace the prior tokens (re-connect flow).
 *   - Implementations are responsible for encrypting tokens at rest.
 *   - `expiresAt` / `refreshToken` / `scope` / `externalAccountId` /
 *     `providerMetadata` are optional because not every provider supplies
 *     them (e.g. some providers omit `expires_in`; not every flow returns
 *     a refresh token on first grant).
 */
export interface IntegrationGrantInput {
  userId: string;
  /** Provider slug — must match the strategy's `provider`. */
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string[];
  externalAccountId?: string;
  /** Provider-specific bag (SFDC `instance_url`, Google `sub`, …). */
  providerMetadata?: Record<string, unknown>;
}

export interface IIntegrationGrantSink {
  createOrUpdateFromOAuthGrant(input: IntegrationGrantInput): Promise<void>;
}
