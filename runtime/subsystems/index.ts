/**
 * Subsystems barrel export
 *
 * Infrastructure subsystems following Protocol → Backend → Factory pattern (ADR-008).
 */

// Events
export { EVENT_BUS } from './events';
export type { DomainEvent, IEventBus } from './events';
export { EventsModule, DrizzleEventBus, MemoryEventBus } from './events';

// Jobs — orchestration schema only (JOB-1). Protocols / modules land in JOB-2 / JOB-5.
export { jobs, jobRuns, jobSteps } from './jobs';
export type { JobDefinitionRow, JobRunRow, JobStepRow } from './jobs';
export {
  jobRunStatusEnum,
  jobStepKindEnum,
  jobStepStatusEnum,
  collisionModeEnum,
  replayFromEnum,
  parentClosePolicyEnum,
  waitKindEnum,
  triggerSourceEnum,
} from './jobs';

// Cache
export { CACHE } from './cache';
export type { ICacheService } from './cache';
export { CacheModule, DrizzleCacheService, MemoryCacheService } from './cache';

// Storage
export { STORAGE } from './storage';
export type { IStorageService } from './storage';
export { StorageModule, LocalStorageBackend, MemoryStorageBackend } from './storage';

// Observability (ADR-025 combiner subsystem, OBS-5)
export {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
  ObservabilityModule,
  type ObservabilityModuleOptions,
  ObservabilityError,
} from './observability';
export type {
  IObservability,
  PoolStatusCount,
  JobRunFailure,
  StatusHistogram,
  IntegrationRunSummary,
  CursorSnapshot,
} from './observability';

// Auth
export {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
  AUTH_INTEGRATION_READER,
  AUTH_INTEGRATION_TOKEN_WRITER,
  AUTH_INTEGRATION_GRANT_SINK,
  AUTH_USER_CONTEXT,
  STRATEGY_REGISTRY,
  AUTH_OPTIONS,
  AuthModule,
  AuthController,
  OAuth2RefreshStrategy,
  withAuthRetry,
  IntegrationBrokenError,
  SessionExpiredError,
  isSessionExpiredError,
  OAuthStateError,
  EnvEncryptionKey,
  MemoryOAuthStateStore,
  DrizzleOAuthStateStore,
  authOAuthState,
} from './auth';
export type {
  IAuthStrategy,
  IEncryptionKey,
  IOAuthStateStore,
  IIntegrationReader,
  IIntegrationTokenWriter,
  IIntegrationGrantSink,
  IntegrationGrantInput,
  IUserContext,
  IProviderStrategy,
  ProviderStrategyRegistry,
  ExchangedTokens,
  AuthCredentials,
  AuthResolveOptions,
  DecryptedIntegration,
  OAuthStateRecord,
  IntegrationTokenUpdate,
  ParsedRefreshResponse,
  AuthOAuthState,
} from './auth';
