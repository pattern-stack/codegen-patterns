/**
 * Sync subsystem — public API
 *
 * Slices landed so far:
 *   - SYNC-2 — protocols + DI tokens (#134)
 *   - SYNC-1 — Drizzle audit-table schemas (#148)
 *   - SYNC-3 — MemoryCursorStore (#149)
 *   - SYNC-5 — ExecuteSyncUseCase + DeepEqualDiffer + recorder/loopback protocols (#150)
 *   - SYNC-4 — Drizzle backends (#151)
 *   - SYNC-6 — SyncModule + MemoryRunRecorder + multi-tenancy opt-in (this slice)
 *
 * Scaffold templates (SYNC-7) and docs/skills (SYNC-8) land in their own
 * PRs. See epic #60.
 */

// Protocols
export type {
  Change,
  ChangeSource,
  IChangeSource,
  SyncSubscriptionView,
} from './sync-change-source.protocol';
export type {
  CursorSnapshot,
  ICursorStore,
} from './sync-cursor-store.protocol';
export type {
  DiffResult,
  FieldDiff,
  FieldDiffValue,
  IFieldDiffer,
} from './sync-field-diff.protocol';
export {
  FieldDiffSchema,
  FieldDiffValueSchema,
} from './sync-field-diff.protocol';
export type { ISyncSink } from './sync-sink.protocol';
export type {
  CompleteRunInput,
  ISyncRunRecorder,
  RecordItemInput,
  StartRunInput,
  SyncRunSummary,
} from './sync-run-recorder.protocol';
export type { ILoopbackFingerprintStore } from './sync-loopback.protocol';

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
} from './sync-middleware.protocol';

// Loopback middleware factory (#226-5) — replaces the orchestrator's prior
// `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` branch. Consumers compose
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
  SYNC_CHANGE_SOURCE,
  SYNC_CURSOR_STORE,
  SYNC_FIELD_DIFFER,
  SYNC_MODULE_OPTIONS,
  SYNC_MULTI_TENANT,
  SYNC_RUN_RECORDER,
  SYNC_SINK,
} from './sync.tokens';

// Errors + shared guards
export { MissingTenantIdError, assertTenantId } from './sync-errors';

// Audit schemas (SYNC-1) — Drizzle pgTable declarations + row types + enums
export {
  syncSubscriptions,
  syncRuns,
  syncRunItems,
  syncRunDirectionEnum,
  syncRunActionEnum,
  syncRunStatusEnum,
  syncRunItemOperationEnum,
  syncRunItemStatusEnum,
} from './sync-audit.schema';
export type {
  SyncSubscriptionRow,
  SyncRunRow,
  SyncRunItemRow,
} from './sync-audit.schema';

// Memory backends (SYNC-3, SYNC-6) — test doubles
export { MemoryCursorStore } from './sync-cursor-store.memory-backend';
export {
  MemoryRunRecorder,
  type MemoryRunRecord,
  type MemorySyncSubscription,
} from './sync-run-recorder.memory-backend';

// Runtime (SYNC-5) — orchestrator + default differ
export {
  DeepEqualDiffer,
  type DeepEqualDifferOptions,
} from './deep-equal.differ';
export {
  ExecuteSyncUseCase,
  type ExecuteSyncInput,
  type ExecuteSyncResult,
} from './execute-sync.use-case';

// Drizzle backends (SYNC-4)
export { PostgresCursorStore } from './sync-cursor-store.drizzle-backend';
export { DrizzleSyncRunRecorder } from './sync-run-recorder.drizzle-backend';

// Module (SYNC-6)
export { SyncModule, type SyncModuleOptions } from './sync.module';
