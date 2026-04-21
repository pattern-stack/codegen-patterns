/**
 * Sync subsystem — public API
 *
 * SYNC-2 slice (protocols + tokens only). Backends, orchestrator, and module
 * land in SYNC-3..SYNC-6. See epic #60 for the full plan.
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
