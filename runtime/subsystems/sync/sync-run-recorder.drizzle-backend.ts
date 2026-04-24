/**
 * DrizzleSyncRunRecorder — Drizzle-backed `ISyncRunRecorder` (SYNC-4).
 *
 * Generic write path only — extracted from dealbrain-v2's
 * `SyncRunRecorderService`, minus CRM-specific convenience methods. Those
 * stay consumer-owned; the subsystem ships the substrate.
 *
 * ## Responsibilities
 *
 *   - `startRun`     — INSERT sync_runs row in status='running', returns id.
 *   - `recordItem`   — validates `changedFields` via `FieldDiffSchema.parse`
 *                      BEFORE the INSERT; a malformed shape throws before
 *                      any DB call fires. Enforces the ADR-0003 contract at
 *                      the write boundary.
 *   - `completeRun`  — UPDATE sync_runs with terminal status, counts,
 *                      cursor_after, duration_ms, completed_at.
 *
 * ## Multi-tenancy
 *
 * When `SYNC_MULTI_TENANT` is true (SYNC-6):
 *   - `startRun` and `recordItem` require non-null `tenantId` on input.
 *     Enforcement goes through the shared `assertTenantId` helper so the
 *     error message shape matches the orchestrator entry point + the
 *     cursor-store backends.
 *   - `completeRun` does NOT re-check tenancy — the run id was returned
 *     by `startRun` which already enforced it, and run ids are uuids that
 *     aren't guessable cross-tenant. Matches JOB-3's pattern of trusting
 *     the run-id for downstream mutations.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import type {
  CompleteRunInput,
  ISyncRunRecorder,
  RecordItemInput,
  StartRunInput,
  SyncRunSummary,
} from './sync-run-recorder.protocol';
import { syncRuns, syncRunItems, syncSubscriptions } from './sync-audit.schema';
import { FieldDiffSchema } from './sync-field-diff.protocol';
import { SYNC_MULTI_TENANT } from './sync.tokens';
import { assertTenantId } from './sync-errors';

@Injectable()
export class DrizzleSyncRunRecorder implements ISyncRunRecorder {
  private readonly multiTenant: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() @Inject(SYNC_MULTI_TENANT) multiTenant?: boolean,
  ) {
    this.multiTenant = multiTenant ?? false;
  }

  async startRun(input: StartRunInput): Promise<{ id: string }> {
    assertTenantId(input.tenantId, {
      multiTenant: this.multiTenant,
      operation: 'startRun',
    });

    const rows = await this.db
      .insert(syncRuns)
      .values({
        subscriptionId: input.subscriptionId,
        direction: input.direction,
        action: input.action,
        status: 'running',
        cursorBefore: input.cursorBefore ?? null,
        tenantId: input.tenantId ?? null,
      })
      .returning({ id: syncRuns.id });

    const id = rows[0]?.id;
    if (!id) {
      // Drizzle's insert().returning() contract: at least one row is
      // returned for every successful INSERT. A missing id would indicate
      // a driver misbehavior; throw loudly rather than return bogus data.
      throw new Error('DrizzleSyncRunRecorder: INSERT RETURNING produced no id');
    }
    return { id };
  }

  async recordItem(input: RecordItemInput): Promise<void> {
    assertTenantId(input.tenantId, {
      multiTenant: this.multiTenant,
      operation: 'recordItem',
    });

    // ADR-0003 contract enforcement — reject malformed changedFields
    // before the DB call fires. `parse` throws a ZodError; callers see
    // the validation failure, not a DB constraint error.
    FieldDiffSchema.parse(input.changedFields);

    await this.db.insert(syncRunItems).values({
      syncRunId: input.syncRunId,
      entityType: input.entityType,
      externalId: input.externalId,
      localId: input.localId ?? null,
      operation: input.operation,
      status: input.status,
      changedFields: input.changedFields,
      title: input.title ?? null,
      error: input.error ?? null,
      tenantId: input.tenantId ?? null,
    });
  }

  async listRecent(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<SyncRunSummary[]> {
    assertTenantId(tenantId, {
      multiTenant: this.multiTenant,
      operation: 'listRecent',
    });

    // JOIN against sync_subscriptions to resolve `integration_id` per run.
    // `sync_runs.subscription_id` is a non-null FK so INNER JOIN is correct;
    // there should be no orphaned runs.
    const conditions: SQL[] = [];
    if (subscriptionId !== undefined) {
      conditions.push(eq(syncRuns.subscriptionId, subscriptionId));
    }
    if (this.multiTenant) {
      conditions.push(eq(syncRuns.tenantId, tenantId as string));
    }
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await this.db
      .select({
        id: syncRuns.id,
        subscriptionId: syncRuns.subscriptionId,
        integrationId: syncSubscriptions.integrationId,
        status: syncRuns.status,
        startedAt: syncRuns.startedAt,
        completedAt: syncRuns.completedAt,
        recordsProcessed: syncRuns.recordsProcessed,
        tenantId: syncRuns.tenantId,
      })
      .from(syncRuns)
      .innerJoin(
        syncSubscriptions,
        eq(syncRuns.subscriptionId, syncSubscriptions.id),
      )
      .where(where)
      .orderBy(desc(syncRuns.startedAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      integrationId: row.integrationId,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      recordsProcessed: row.recordsProcessed,
      tenantId: row.tenantId,
    }));
  }

  async completeRun(runId: string, input: CompleteRunInput): Promise<void> {
    await this.db
      .update(syncRuns)
      .set({
        status: input.status,
        recordsFound: input.recordsFound,
        recordsProcessed: input.recordsProcessed,
        cursorAfter: input.cursorAfter ?? null,
        durationMs: input.durationMs,
        error: input.error ?? null,
        completedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId));
  }
}
