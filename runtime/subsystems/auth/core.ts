/**
 * Auth subsystem — the Nest-free entry (PW-0).
 *
 * Everything in the auth public API that loads no `@nestjs/*` package, type
 * imports included: the protocols, tokens, the refresh strategy and retry, the
 * errors, the OAuth-state schema and the backends. Not here: the controller, the
 * guard, `@Public`, the requester-context middleware (typed against
 * `INestApplication`; its Hono twin is H-2) and the module. A pattern-stack app imports
 * through this file (`subsystemCoreImport(mode, 'auth')`); `./index` re-exports
 * it beside the Nest half. `src/__tests__/runtime/nest-free.test.ts` holds it
 * Nest-free.
 */

// Protocols
export type {
  AuthCredentials,
  AuthResolveOptions,
  IAuthStrategy,
} from './protocols/auth-strategy';
export type { IEncryptionKey } from './protocols/encryption-key';
export type {
  IOAuthStateStore,
  OAuthStateRecord,
} from './protocols/oauth-state-store';
export { OAuthStateError } from './protocols/oauth-state-store';
export type {
  DecryptedConnection,
  IConnectionReader,
  IConnectionTokenWriter,
  ConnectionTokenUpdate,
  IConnectionGrantSink,
  ConnectionGrantInput,
} from './protocols/connection-store';
export type { IUserContext } from './protocols/user-context';
export type {
  IProviderStrategy,
  ProviderStrategyRegistry,
  ExchangedTokens,
} from './protocols/provider-strategy';

// Tokens
export {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
  AUTH_CONNECTION_READER,
  AUTH_CONNECTION_TOKEN_WRITER,
  AUTH_CONNECTION_GRANT_SINK,
  AUTH_USER_CONTEXT,
  STRATEGY_REGISTRY,
  AUTH_OPTIONS,
} from './auth.tokens';

// Runtime
export {
  OAuth2RefreshStrategy,
  type OAuth2RefreshStrategyOptions,
  type ParsedRefreshResponse,
  type FetchLike,
} from './runtime/oauth2-refresh.strategy';
export { withAuthRetry, type WithAuthRetryOptions } from './runtime/with-auth-retry';
export { ConnectionBrokenError } from './runtime/connection-broken.error';
export { oauthCallbackUrl } from './runtime/oauth-callback-url';
export {
  SessionExpiredError,
  isSessionExpiredError,
} from './runtime/session-expired.error';

// Schema (drizzle backend)
export {
  authOAuthState,
  type AuthOAuthState,
} from './auth-oauth-state.schema';

// Backends
export {
  EnvEncryptionKey,
  type EnvEncryptionKeyOptions,
} from './backends/encryption-key/env';
export {
  MemoryOAuthStateStore,
  type MemoryOAuthStateStoreOptions,
} from './backends/state-store.memory-backend';
export {
  DrizzleOAuthStateStore,
  type DrizzleOAuthStateStoreOptions,
} from './backends/state-store.drizzle-backend';
