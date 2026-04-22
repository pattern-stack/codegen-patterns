/**
 * Drizzle schema for the `bridge_delivery` ledger (ADR-023 Phase 2, BRIDGE-1).
 *
 * The `bridge_delivery` table is the idempotency ledger for the event-to-job
 * bridge. Every (event, trigger) pair the bridge is asked to spawn produces
 * exactly one row; the `UNIQUE (event_id, trigger_id)` constraint guarantees
 * that:
 *
 *   1. Outbox replays of an event do not double-spawn user job runs — the
 *      drain attempts to insert the duplicate, the constraint trips, and the
 *      drain skips that trigger.
 *   2. The `IEventFlow.publishAndStart` facade can pre-write a
 *      `(status='delivered')` row before the drain runs (Case B from ADR-023
 *      §`publishAndStart` + existing `triggers:` collision); the drain then
 *      hits UNIQUE on that trigger and skips it while still spawning any
 *      other triggers for the same event normally.
 *
 * Status values:
 *   - `pending`   — wrapper run exists; user job not yet started.
 *   - `delivered` — user job started; `user_run_id` populated.
 *   - `skipped`   — intentional no-op (`when:` returned false, or
 *                   facade-eager path pre-empted the bridge spawn).
 *   - `failed`    — wrapper exhausted retry policy; no auto-retry past that
 *                   (mirrors events outbox stance — ops eyes only).
 *
 * `wrapper_run_id` is **nullable**: the facade-eager path (Case B) pre-writes
 * `bridge_delivery` with no wrapper. The bridge-drain path always populates
 * it.
 *
 * `tenant_id` is emitted **unconditionally and nullable** (per JOB-8
 * 2026-04-20 reversal); enforcement is service-layer (BRIDGE-8) gated on the
 * `BRIDGE_MULTI_TENANT` DI token, not a DB constraint.
 *
 * Indexes:
 *   - `bridge_delivery_event_idx` — lookup all deliveries for an event.
 *   - `bridge_delivery_status_idx` — partial; ops dashboards filter by
 *     `pending | failed`.
 *   - `bridge_delivery_user_run_idx` — partial; reverse lookup from a
 *     spawned user run back to its delivery row.
 *
 * No service logic, no DI wiring — this is the schema foundation. Backends
 * (memory + drizzle) and the framework handler land in BRIDGE-3 / BRIDGE-4 /
 * BRIDGE-5.
 */
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

import { domainEvents } from '../events/domain-events.schema';
import { jobRuns } from '../jobs/job-orchestration.schema';

// ─── Enum ───────────────────────────────────────────────────────────────────

export const bridgeDeliveryStatusEnum = pgEnum('bridge_delivery_status', [
  'pending',
  'delivered',
  'skipped',
  'failed',
]);

// ─── Table ──────────────────────────────────────────────────────────────────

export const bridgeDelivery = pgTable(
  'bridge_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** FK to the source event in the outbox. */
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id),
    /**
     * Stable codegen-emitted identifier for the (job, trigger) pair, of the
     * form `<job_type>#<triggerIndex>` (BRIDGE-6). Forms the second half of
     * the UNIQUE idempotency key.
     */
    triggerId: text('trigger_id').notNull(),
    /**
     * Wrapper `job_run.id` (the framework `@framework/bridge_delivery` run
     * that drove this delivery). Nullable: the facade-eager path
     * (`publishAndStart` Case B) pre-writes a delivered row with no wrapper.
     */
    wrapperRunId: uuid('wrapper_run_id').references(() => jobRuns.id),
    /**
     * Spawned user `job_run.id`. Null until status is `delivered`; remains
     * null for `skipped` and `failed` deliveries.
     */
    userRunId: uuid('user_run_id').references(() => jobRuns.id),
    status: bridgeDeliveryStatusEnum('status').notNull().default('pending'),
    /** Populated when status=`skipped` (e.g. `'when_returned_false'`, `'trigger_unregistered'`). */
    skipReason: text('skip_reason'),
    /** Populated when status=`failed`. Mirrors `job_run.error` shape. */
    error: jsonb('error').$type<Record<string, unknown>>(),
    /**
     * Emitted unconditionally and nullable (JOB-8 / SYNC-6 precedent).
     * Enforcement gated on `BRIDGE_MULTI_TENANT` at the service layer
     * (BRIDGE-8); no DB constraint.
     */
    tenantId: text('tenant_id'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    /**
     * Idempotency ledger. Outbox replays and facade-vs-drain collisions both
     * dedup through this constraint.
     */
    uqBridgeDeliveryEventTrigger: unique('uq_bridge_delivery_event_trigger').on(
      t.eventId,
      t.triggerId,
    ),
    /** Lookup all deliveries for an event (fanout report, debugging). */
    idxBridgeDeliveryEvent: index('idx_bridge_delivery_event').on(t.eventId),
    /**
     * Ops dashboard filter — only the actionable states. Partial index keeps
     * it small at scale (the bulk of rows will be `delivered`).
     */
    idxBridgeDeliveryStatus: index('idx_bridge_delivery_status')
      .on(t.status)
      .where(sql`${t.status} IN ('pending','failed')`),
    /**
     * Reverse lookup from a spawned user run back to its delivery row.
     * Partial — most rows in the bridge ledger but only successful
     * deliveries have a `user_run_id`.
     */
    idxBridgeDeliveryUserRun: index('idx_bridge_delivery_user_run')
      .on(t.userRunId)
      .where(sql`${t.userRunId} IS NOT NULL`),
  }),
);

export type BridgeDeliveryRecord = InferSelectModel<typeof bridgeDelivery>;
