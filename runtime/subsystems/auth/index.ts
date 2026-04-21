/**
 * Auth subsystem — public API.
 *
 * Protocol → Backend → Factory, per ADR-008 + ADR-031. Imports:
 *
 * ```typescript
 * import {
 *   AuthModule,
 *   ENCRYPTION_KEY,
 *   OAUTH_STATE_STORE,
 *   AUTH_INTEGRATION_READER,
 *   AUTH_INTEGRATION_TOKEN_WRITER,
 *   OAuth2RefreshStrategy,
 *   withAuthRetry,
 *   IntegrationBrokenError,
 *   SessionExpiredError,
 *   type IAuthStrategy,
 *   type IEncryptionKey,
 *   type IOAuthStateStore,
 *   type IIntegrationReader,
 *   type IIntegrationTokenWriter,
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
  OAuthStateEntry,
} from './protocols/oauth-state-store';
export type {
  DecryptedIntegration,
  IIntegrationReader,
  IIntegrationTokenWriter,
  IntegrationTokenUpdate,
} from './protocols/integration-store';

// Tokens
export {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
  AUTH_INTEGRATION_READER,
  AUTH_INTEGRATION_TOKEN_WRITER,
} from './auth.tokens';

// Runtime
export {
  OAuth2RefreshStrategy,
  type OAuth2RefreshStrategyOptions,
  type ParsedRefreshResponse,
  type FetchLike,
} from './runtime/oauth2-refresh.strategy';
export { withAuthRetry, type WithAuthRetryOptions } from './runtime/with-auth-retry';
export { IntegrationBrokenError } from './runtime/integration-broken.error';
export {
  SessionExpiredError,
  isSessionExpiredError,
} from './runtime/session-expired.error';

// Backends
export {
  EnvEncryptionKey,
  type EnvEncryptionKeyOptions,
} from './backends/encryption-key/env';
export {
  InMemoryOAuthStateStore,
  type InMemoryOAuthStateStoreOptions,
} from './backends/oauth-state-store/in-memory';

// Module
export { AuthModule, type AuthModuleOptions } from './auth.module';
