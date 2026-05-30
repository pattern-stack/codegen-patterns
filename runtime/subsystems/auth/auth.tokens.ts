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
 *   @Inject(AUTH_CONNECTION_READER) private readonly reader: IConnectionReader,
 *   @Inject(AUTH_CONNECTION_TOKEN_WRITER) private readonly writer: IConnectionTokenWriter,
 *   @Inject(AUTH_CONNECTION_GRANT_SINK) private readonly grants: IConnectionGrantSink,
 *   @Inject(AUTH_USER_CONTEXT) private readonly userCtx: IUserContext,
 *   @Inject(STRATEGY_REGISTRY) private readonly registry: ProviderStrategyRegistry,
 * ) {}
 * ```
 *
 * `IAuthStrategy` implementations are provider-specific and registered under
 * provider-specific tokens (e.g. `SALESFORCE_AUTH_STRATEGY`,
 * `HUBSPOT_AUTH_STRATEGY`) by each connection module — this subsystem does
 * not mandate a single `AUTH_STRATEGY` token because an app typically has
 * many concurrent strategies, one per provider. They are dispatched through
 * `STRATEGY_REGISTRY` (a `ReadonlyMap<slug, IProviderStrategy>`), populated
 * by per-provider modules via a `useFactory` provider.
 */
export const ENCRYPTION_KEY = Symbol('ENCRYPTION_KEY');
export const OAUTH_STATE_STORE = Symbol('OAUTH_STATE_STORE');
export const AUTH_CONNECTION_READER = Symbol('AUTH_CONNECTION_READER');
export const AUTH_CONNECTION_TOKEN_WRITER = Symbol('AUTH_CONNECTION_TOKEN_WRITER');
export const AUTH_CONNECTION_GRANT_SINK = Symbol('AUTH_CONNECTION_GRANT_SINK');
export const AUTH_USER_CONTEXT = Symbol('AUTH_USER_CONTEXT');
export const STRATEGY_REGISTRY = Symbol('STRATEGY_REGISTRY');
/**
 * Holds the resolved `AuthModuleOptions` (used by `AuthController` to read
 * `redirectUriBase` for building per-provider callback URIs).
 */
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
