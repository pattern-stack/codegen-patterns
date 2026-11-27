/**
 * Auth subsystem — public API.
 *
 * Protocol → Backend → Factory, per ADR-008 + ADR-031. Imports:
 *
 * ```typescript
 * import {
 *   AuthModule,
 *   AuthController,
 *   AuthenticatedGuard,
 *   Public,
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

// The Nest-free half of the API (PW-0): protocols, tokens, runtime, schema,
// backends.
export * from './core';

// Controller
export { AuthController } from './controllers/auth.controller';

// Guard — closed-by-default data-plane authentication (ADR-043)
export { AuthenticatedGuard } from './guards/authenticated.guard';
export { Public, IS_PUBLIC_KEY } from './guards/public.decorator';

// Middleware — RequesterContext boundary (bridges auth → ambient tenant scope)
export {
  installRequesterContext,
  makeRequesterContextMiddleware,
  resolveRequesterContext,
  resolveUserContext,
  type RequesterContextOptions,
} from './middleware/requester-context';

// Module
export { AuthModule, type AuthModuleOptions } from './auth.module';
