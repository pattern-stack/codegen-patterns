/**
 * Integration subsystem — the Nest-free entry (PW-0).
 *
 * Everything in the integration public API that loads no `@nestjs/*` package,
 * type imports included: the protocols, the change-source registry, the
 * detection schema, the middleware, the poll / incremental-read / webhook
 * primitives, `buildChangeSource`, the tokens, the errors and the audit schemas.
 * Not here: the memory and Drizzle backends, the differ and the use case (all
 * decorated; S-3 gives them plain twins) and the module. A pattern-stack app imports
 * through this file (`subsystemCoreImport(mode, 'integration')`); `./index`
 * re-exports it beside the Nest half. `src/__tests__/runtime/nest-free.test.ts`
 * holds it Nest-free.
 */

// Protocols
export type {
  Change,
  ChangeSource,
  IChangeSource,
  IntegrationSubscriptionView,
} from './integration-change-source.protocol';
export type {
  CursorSnapshot,
  ICursorStore,
} from './integration-cursor-store.protocol';
export type {
  DiffResult,
  FieldDiff,
  FieldDiffValue,
  IFieldDiffer,
} from './integration-field-diff.protocol';
export {
  FieldDiffSchema,
  FieldDiffValueSchema,
} from './integration-field-diff.protocol';
export type { IIntegrationSink } from './integration-sink.protocol';
export type {
  IIntegrationChangeEmitter,
  IntegrationChangeAction,
  IntegrationChangeNotification,
} from './integration-change-emitter.protocol';
export type {
  CompleteRunInput,
  IIntegrationRunRecorder,
  RecordItemInput,
  StartRunInput,
  IntegrationRunSummary,
} from './integration-run-recorder.protocol';
export type { ILoopbackFingerprintStore } from './integration-loopback.protocol';

// Entity-keyed change-source registry (C7, #336) — L1 protocol + memory impl.
// Generalizes per-entity `<ENTITY>_POLL_FETCH_REGISTRY` tokens into one
// entity-keyed registry so the L3 surface port (C6) is entity-agnostic. Codegen
// retarget to emit it is Track D D3/D4 (RFC-0001 §3).
export type { IEntityChangeSourceRegistry } from './entity-change-source-registry.protocol';
export { UnknownEntityError } from './entity-change-source-registry.protocol';
export { MemoryEntityChangeSourceRegistry } from './entity-change-source-registry.memory';

// DetectionConfig (#226-1) — Zod schema + inferred types; canonical source
// of filter/mapping shape consumed by primitives + codegen YAML validator
export {
  CURSOR_DIVISIBILITY,
  CursorStrategySchema,
  DetectionConfigSchema,
  FieldMappingSchema,
  isDivisibleCursor,
  PollDetectionSchema,
  ResolvedFilterSchema,
  WebhookDetectionSchema,
} from './detection-config.schema';
export type {
  CursorStrategy,
  DetectionConfig,
  FieldMapping,
  PollDetection,
  ResolvedFilter,
  WebhookDetection,
} from './detection-config.schema';

// Middleware (#226-1) — composable wrapper around the cursor-aware iterator
export type {
  ChangeIterator,
  ChangeMiddleware,
  ComposeChangeMiddleware,
} from './integration-middleware.protocol';

// Loopback middleware factory (#226-5) — replaces the orchestrator's prior
// `@Optional() INTEGRATION_LOOPBACK_FINGERPRINT_STORE` branch. Consumers compose
// `createLoopbackMiddleware(store)` into their primitive's middleware chain.
export { createLoopbackMiddleware } from './loopback.middleware';

// Poll primitive (#226-3) — generic poll-mode IChangeSource<T>
export {
  PollChangeSource,
  type PollChangeSourceOptions,
  type PollCursor,
  type PollFetchCallback,
  type PollFetchContext,
} from './poll-change-source';

// IncrementalRead primitive (RFC-0003 R1) — enumerate/hydrate read capability;
// the providing base emits a streaming, filter-before-hydrate IChangeSource<T>.
export {
  IncrementalReadBase,
  mapConcurrent,
  type IncrementalRead,
  type RandomRead,
  type ReadContext,
  type ReadMode,
  type ReadRequest,
  type Ref,
  type SourcedRecord,
} from './incremental-read';

// Webhook primitive (#226-4) — generic webhook-mode IChangeSource<T>
// driven by a consumer-owned inbound staging queue iterator
export {
  WebhookChangeSource,
  type WebhookChangeSourceOptions,
  type WebhookCursor,
  type WebhookFetchCallback,
  type WebhookFetchContext,
} from './webhook-change-source';

// buildChangeSource (#250, ADR-033.1 b) — mode-dispatching factory consumed
// by codegen-emitted provider modules' `useFactory` wiring
export { buildChangeSource } from './build-change-source';

// Tokens
export {
  ENTITY_CHANGE_SOURCE_REGISTRY,
  INTEGRATION_CHANGE_EMITTER,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_CURSOR_STORE,
  INTEGRATION_FIELD_DIFFER,
  INTEGRATION_MODULE_OPTIONS,
  INTEGRATION_MULTI_TENANT,
  INTEGRATION_RUN_RECORDER,
  INTEGRATION_SINK,
} from './integration.tokens';

// Errors + shared guards
export { MissingTenantIdError, assertTenantId } from './integration-errors';

// Audit schemas (SYNC-1) — Drizzle pgTable declarations + row types + enums
export {
  integrationSubscriptions,
  integrationRuns,
  integrationRunItems,
  integrationRunDirectionEnum,
  integrationRunActionEnum,
  integrationRunStatusEnum,
  integrationRunItemOperationEnum,
  integrationRunItemStatusEnum,
} from './integration-audit.schema';
export type {
  IntegrationSubscriptionRow,
  IntegrationRunRow,
  IntegrationRunItemRow,
} from './integration-audit.schema';
