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

// Tokens
export {
  SYNC_CHANGE_SOURCE,
  SYNC_CURSOR_STORE,
  SYNC_FIELD_DIFFER,
  SYNC_LOOPBACK_FINGERPRINT_STORE,
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
