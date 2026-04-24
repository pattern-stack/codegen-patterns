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

// Observability (ADR-008, 5th subsystem)
export { OBSERVABILITY, OBSERVABILITY_REPORTERS } from './observability';
export type {
  CursorSnapshot,
  IObservabilityService,
  JobRunFailure,
  PoolDepth,
  StatusHistogram,
  SyncRunSummary,
} from './observability';
export {
  ObservabilityModule,
  DrizzleObservabilityService,
  MemoryObservabilityService,
  BridgeMetricsReporter,
} from './observability';
export type {
  ObservabilityModuleOptions,
  ObservabilityReporterOptions,
  BridgeMetricsRow,
  BridgeMetricsTick,
} from './observability';

// Auth
export {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
  AUTH_INTEGRATION_READER,
  AUTH_INTEGRATION_TOKEN_WRITER,
  AuthModule,
  OAuth2RefreshStrategy,
  withAuthRetry,
  IntegrationBrokenError,
  SessionExpiredError,
  isSessionExpiredError,
  EnvEncryptionKey,
  InMemoryOAuthStateStore,
} from './auth';
export type {
  IAuthStrategy,
  IEncryptionKey,
  IOAuthStateStore,
  IIntegrationReader,
  IIntegrationTokenWriter,
  AuthCredentials,
  AuthResolveOptions,
  DecryptedIntegration,
  OAuthStateEntry,
  IntegrationTokenUpdate,
  ParsedRefreshResponse,
} from './auth';
