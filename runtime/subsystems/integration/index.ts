/**
 * Integration subsystem — public API
 *
 * Slices landed so far:
 *   - SYNC-2 — protocols + DI tokens (#134)
 *   - SYNC-1 — Drizzle audit-table schemas (#148)
 *   - SYNC-3 — MemoryCursorStore (#149)
 *   - SYNC-5 — ExecuteIntegrationUseCase + DeepEqualDiffer + recorder/loopback protocols (#150)
 *   - SYNC-4 — Drizzle backends (#151)
 *   - SYNC-6 — IntegrationModule + MemoryRunRecorder + multi-tenancy opt-in (this slice)
 *
 * Scaffold templates (SYNC-7) and docs/skills (SYNC-8) land in their own
 * PRs. See epic #60.
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
  CompleteRunInput,
  IIntegrationRunRecorder,
  RecordItemInput,
  StartRunInput,
  IntegrationRunSummary,
} from './integration-run-recorder.protocol';
export type { ILoopbackFingerprintStore } from './integration-loopback.protocol';

// DetectionConfig (#226-1) — Zod schema + inferred types; canonical source
// of filter/mapping shape consumed by primitives + codegen YAML validator
export {
  CursorStrategySchema,
  DetectionConfigSchema,
  FieldMappingSchema,
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

// Memory backends (SYNC-3, SYNC-6) — test doubles
export { MemoryCursorStore } from './integration-cursor-store.memory-backend';
export {
  MemoryRunRecorder,
  type MemoryRunRecord,
  type MemoryIntegrationSubscription,
} from './integration-run-recorder.memory-backend';

// Runtime (SYNC-5) — orchestrator + default differ
export {
  DeepEqualDiffer,
  type DeepEqualDifferOptions,
} from './deep-equal.differ';
export {
  ExecuteIntegrationUseCase,
  type ExecuteIntegrationInput,
  type ExecuteIntegrationResult,
} from './execute-integration.use-case';

// Drizzle backends (SYNC-4)
export { PostgresCursorStore } from './integration-cursor-store.drizzle-backend';
export { DrizzleIntegrationRunRecorder } from './integration-run-recorder.drizzle-backend';

// Module (SYNC-6)
export { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
