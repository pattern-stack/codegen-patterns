/**
 * Auth subsystem — public API.
 *
 * Protocol → Backend → Factory, per ADR-008 + ADR-031. Imports:
 *
 * ```typescript
 * import {
 *   AuthModule,
 *   AuthController,
 *   ENCRYPTION_KEY,
 *   OAUTH_STATE_STORE,
 *   AUTH_CONNECTION_READER,
 *   AUTH_CONNECTION_TOKEN_WRITER,
 *   AUTH_CONNECTION_GRANT_SINK,
 *   AUTH_USER_CONTEXT,
 *   STRATEGY_REGISTRY,
 *   AUTH_OPTIONS,
 *   OAuth2RefreshStrategy,
 *   withAuthRetry,
 *   ConnectionBrokenError,
 *   SessionExpiredError,
 *   OAuthStateError,
 *   type IAuthStrategy,
 *   type IEncryptionKey,
 *   type IOAuthStateStore,
 *   type OAuthStateRecord,
 *   type IConnectionReader,
 *   type IConnectionTokenWriter,
 *   type IConnectionGrantSink,
 *   type ConnectionGrantInput,
 *   type IUserContext,
 *   type IProviderStrategy,
 *   type ProviderStrategyRegistry,
 *   type ExchangedTokens,
 * } from '@pattern-stack/codegen/runtime/subsystems/auth';
 * ```
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

// Controller
export { AuthController } from './controllers/auth.controller';

// Middleware — RequesterContext boundary (bridges auth → ambient tenant scope)
export {
  installRequesterContext,
  makeRequesterContextMiddleware,
  resolveRequesterContext,
  type RequesterContextOptions,
} from './middleware/requester-context';

// Module
export { AuthModule, type AuthModuleOptions } from './auth.module';
