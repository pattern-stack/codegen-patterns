/**
 * MemoryCursorStore — in-memory backend for `ICursorStore` (SYNC-3).
 *
 * Test double that lets consumers exercise `ExecuteSyncUseCase` (SYNC-5) and
 * other cursor-consuming code paths without Postgres. Mirrors the role of
 * `MemoryEventBus` and `MemoryJobStore`: plain keyed state, tests take a
 * direct reference for `beforeEach` resets.
 *
 * Cursor values are stored by reference — the port's `get`/`put` contract
 * treats them as opaque `unknown`. Callers that want durable value-equality
 * semantics should snapshot via JSON before `put` and reparse after `get`;
 * this is what the Drizzle backend (SYNC-4) does implicitly via jsonb
 * round-trip. The memory backend intentionally does not simulate the
 * serialize/deserialize cycle — consumers who care should test against
 * Postgres.
 *
 * ## Multi-tenancy
 *
 * `tenantId` is accepted but ignored. The memory backend's state is
 * process-local — there's no durable storage where a cross-tenant leak
 * could occur. Tests that want to assert per-tenant isolation should
 * target the Drizzle backend.
 *
 * Not shipped in dealbrain-v2; this is a subsystem-first addition for the
 * test surface. Consumed by:
 *   - SYNC-5 unit tests (`ExecuteSyncUseCase` against synthetic sources)
 *   - SYNC-6 module tests (`SyncModule.forRoot({ backend: 'memory' })`)
 */
import { Injectable } from '@nestjs/common';
import type {
  CursorSnapshot,
  ICursorStore,
} from './sync-cursor-store.protocol';
import type { MemorySyncSubscription } from './sync-run-recorder.memory-backend';

@Injectable()
export class MemoryCursorStore implements ICursorStore {
  /**
   * Subscription-id → last persisted cursor. Public so tests can inspect
   * or pre-seed state; production callers MUST go through `get`/`put`.
   */
  readonly cursors: Map<string, unknown> = new Map();

  /**
   * Seedable subscription metadata for `listAll` — the memory backend
   * stores only `subscriptionId → cursor` in its write path, so the
   * snapshot shape (`integrationId`, `adapter`, `domain`, `externalRef`,
   * timestamps) has no natural source without test seeding. Tests populate
   * this map; unseeded entries get empty-string metadata and `new Date(0)`
   * timestamps so the shape stays stable. Production paths go through the
   * Drizzle backend.
   */
  readonly subscriptions: Map<string, MemorySyncSubscription> = new Map();

  async get(
    subscriptionId: string,
    _tenantId?: string | null,
  ): Promise<unknown | null> {
    // `Map.get` returns `undefined` for missing keys; the port contract
    // returns `null`. Normalize here so callers can `=== null`-check.
    const value = this.cursors.get(subscriptionId);
    return value === undefined ? null : value;
  }

  async put(
    subscriptionId: string,
    cursor: unknown,
    _tenantId?: string | null,
  ): Promise<void> {
    // Overwrite semantics — matches the port contract and the Drizzle
    // backend's `ON CONFLICT DO UPDATE` behavior.
    this.cursors.set(subscriptionId, cursor);
  }

  async listAll(_tenantId?: string | null): Promise<CursorSnapshot[]> {
    // Accepts tenantId for contract symmetry but does not filter on it —
    // the memory backend never enforces tenancy (see class-level comment).
    const snapshots: CursorSnapshot[] = [];
    for (const [subscriptionId, cursor] of this.cursors.entries()) {
      const meta = this.subscriptions.get(subscriptionId);
      snapshots.push({
        subscriptionId,
        integrationId: meta?.integrationId ?? '',
        adapter: meta?.adapter ?? '',
        domain: meta?.domain ?? '',
        externalRef: meta?.externalRef ?? null,
        cursor: cursor ?? null,
        lastSyncAt: meta?.lastSyncAt ?? null,
        updatedAt: meta?.updatedAt ?? new Date(0),
        tenantId: null,
      });
    }
    return snapshots.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  /** Reset state. Tests call this in `beforeEach`. */
  clear(): void {
    this.cursors.clear();
    this.subscriptions.clear();
  }
}
