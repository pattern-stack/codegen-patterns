/**
 * Auth subsystem — injection tokens.
 *
 * Following ADR-008 guidance: `Symbol()` tokens for type safety and collision
 * avoidance. Consumers inject these via `@Inject(...)` against the matching
 * protocol interface.
 *
 * Usage:
 * ```typescript
 * constructor(
 *   @Inject(ENCRYPTION_KEY) private readonly key: IEncryptionKey,
 *   @Inject(OAUTH_STATE_STORE) private readonly states: IOAuthStateStore,
 *   @Inject(AUTH_INTEGRATION_READER) private readonly reader: IIntegrationReader,
 *   @Inject(AUTH_INTEGRATION_TOKEN_WRITER) private readonly writer: IIntegrationTokenWriter,
 * ) {}
 * ```
 *
 * `IAuthStrategy` implementations are provider-specific and registered under
 * provider-specific tokens (e.g. `SALESFORCE_AUTH_STRATEGY`,
 * `HUBSPOT_AUTH_STRATEGY`) by each integration module — this subsystem does
 * not mandate a single `AUTH_STRATEGY` token because an app typically has
 * many concurrent strategies, one per provider.
 */
export const ENCRYPTION_KEY = Symbol('ENCRYPTION_KEY');
export const OAUTH_STATE_STORE = Symbol('OAUTH_STATE_STORE');
export const AUTH_INTEGRATION_READER = Symbol('AUTH_INTEGRATION_READER');
export const AUTH_INTEGRATION_TOKEN_WRITER = Symbol('AUTH_INTEGRATION_TOKEN_WRITER');
