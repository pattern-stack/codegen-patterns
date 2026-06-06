/**
 * Subsystems barrel export
 *
 * Infrastructure subsystems following Protocol → Backend → Factory pattern (ADR-008).
 */

// Events
export { EVENT_BUS } from './events';
// `DrizzleTransaction` is re-exported here (not just from the `events` barrel)
// so package-mode generated code — which imports from the single
// `@pattern-stack/codegen/subsystems` barrel — resolves it (ADR-037). Vendored
// mode reaches it via `@shared/subsystems/events`; both must export it.
export type { DomainEvent, IEventBus, DrizzleTransaction } from './events';
export { EventsModule, DrizzleEventBus, MemoryEventBus } from './events';
// The `TYPED_EVENT_BUS` token is re-exported here so package-mode generated code
// that publishes events from the single `@pattern-stack/codegen/subsystems`
// barrel resolves it — notably the EMIT-CHANGES integration change-emitter
// (`<entity>.change-emitter.ts`), which injects `TYPED_EVENT_BUS`. The emitter
// types the bus with a local structural `publish` shape (NOT the package's
// `TypedEventBus`, whose `EventTypeName` union is the package's own events — the
// consumer's `<entity>_*` events live in the CONSUMER registry), so only the
// token needs forwarding. The CONSUMER binds their generated `TypedEventBus` to
// the token via `EventsModule.forRoot()`. Vendored mode reaches it via
// `@shared/subsystems/events`.
export { TYPED_EVENT_BUS } from './events';

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

// Integration — entity change-source registry (C7) + change-source port.
// Exposed here so L2 surface packages (e.g. @pattern-stack/codegen-crm) can
// import them across the package boundary via @pattern-stack/codegen/subsystems
// (Track C C6). Selective re-export (not `export *`) to avoid the
// IntegrationRunSummary name clash with the observability barrel above.
export {
  ENTITY_CHANGE_SOURCE_REGISTRY,
  MemoryEntityChangeSourceRegistry,
  UnknownEntityError,
} from './integration';
export type {
  IEntityChangeSourceRegistry,
  IChangeSource,
  IntegrationSubscriptionView,
} from './integration';

// Integration — IncrementalRead read primitive (RFC-0003 R1). Re-exported here
// so surface packages can author enumerate/hydrate adapters across the package
// boundary via @pattern-stack/codegen/subsystems. ResolvedFilter rides along:
// the R3 read-primitive scaffold imports it for its static `detection.filters`
// const and the `F = ResolvedFilter[]` type parameter.
export {
  CURSOR_DIVISIBILITY,
  IncrementalReadBase,
  isDivisibleCursor,
  mapConcurrent,
} from './integration';
export type {
  IncrementalRead,
  RandomRead,
  ReadContext,
  ReadMode,
  ReadRequest,
  Ref,
  ResolvedFilter,
  SourcedRecord,
} from './integration';

// Integration — change-source primitives + DetectionConfig (#226-3/4, ADR-033).
// Re-exported here so consumers authoring a webhook/poll drain across the
// package boundary import them from `@pattern-stack/codegen/subsystems` instead
// of reaching into the deep `.../integration/index` path. Surfaced by the
// swe-brain dogfood (gap #6 — the first real consumer of `WebhookChangeSource`,
// whose Slack inbound drain otherwise had to deep-import the primitive +
// `DetectionConfigSchema`). Selective re-export (mirrors the curated
// `IncrementalReadBase` / `ExecuteIntegrationUseCase` forwards above) — not
// `export *`, to keep the `IntegrationRunSummary` name clash contained.
export {
  WebhookChangeSource,
  PollChangeSource,
  buildChangeSource,
  DetectionConfigSchema,
} from './integration';
export type {
  WebhookChangeSourceOptions,
  WebhookFetchCallback,
  WebhookFetchContext,
  WebhookCursor,
  PollChangeSourceOptions,
  PollFetchCallback,
  PollFetchContext,
  PollCursor,
  DetectionConfig,
} from './integration';

// Integration — assembly emission (RFC-0002). The generated per-entity sink
// imports `IIntegrationSink`; the generated per-entity assembly module imports
// `ExecuteIntegrationUseCase` + `INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK`
// — all from `@pattern-stack/codegen/subsystems`. Forwarded here so the emitted
// `src/integrations/**` tree resolves them across the package boundary.
export {
  ExecuteIntegrationUseCase,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_SINK,
} from './integration';
export type { IIntegrationSink } from './integration';

// Integration — EMIT-CHANGES seam. The generated per-entity change-emitter
// (`<entity>.change-emitter.ts`) imports the `INTEGRATION_CHANGE_EMITTER` token
// + the `IIntegrationChangeEmitter` port + `IntegrationChangeNotification` from
// `@pattern-stack/codegen/subsystems`. Forwarded here so the emitted opt-in
// emitter resolves them across the package boundary (package mode).
export { INTEGRATION_CHANGE_EMITTER } from './integration';
export type {
  IIntegrationChangeEmitter,
  IntegrationChangeAction,
  IntegrationChangeNotification,
} from './integration';

// Auth
export {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
  AUTH_CONNECTION_READER,
  AUTH_CONNECTION_TOKEN_WRITER,
  AUTH_CONNECTION_GRANT_SINK,
  AUTH_USER_CONTEXT,
  STRATEGY_REGISTRY,
  AUTH_OPTIONS,
  AuthModule,
  AuthController,
  OAuth2RefreshStrategy,
  withAuthRetry,
  ConnectionBrokenError,
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
  IConnectionReader,
  IConnectionTokenWriter,
  IConnectionGrantSink,
  ConnectionGrantInput,
  IUserContext,
  IProviderStrategy,
  ProviderStrategyRegistry,
  ExchangedTokens,
  AuthCredentials,
  AuthResolveOptions,
  DecryptedConnection,
  OAuthStateRecord,
  ConnectionTokenUpdate,
  ParsedRefreshResponse,
  AuthOAuthState,
} from './auth';
