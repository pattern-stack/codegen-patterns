/**
 * Sync subsystem — public API
 *
 * Slices landed so far:
 *   - SYNC-2 — protocols + DI tokens (#134)
 *   - SYNC-1 — Drizzle audit-table schemas (this slice)
 *
 * Backends (SYNC-3/4), orchestrator (SYNC-5), and module (SYNC-6) land in
 * their own PRs. See epic #60 for the full plan.
 */

// Protocols
export type {
  Change,
  ChangeSource,
  IChangeSource,
  SyncSubscriptionView,
} from './sync-change-source.protocol';
export type { ICursorStore } from './sync-cursor-store.protocol';
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

// Tokens
export {
  SYNC_CHANGE_SOURCE,
  SYNC_CURSOR_STORE,
  SYNC_FIELD_DIFFER,
  SYNC_MODULE_OPTIONS,
  SYNC_MULTI_TENANT,
  SYNC_SINK,
} from './sync.tokens';

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
