/**
 * DrizzleIntegrationRunRecorder — Drizzle-backed `IIntegrationRunRecorder` (SYNC-4).
 *
 * Generic write path only — extracted from the source app's
 * `IntegrationRunRecorderService`, minus CRM-specific convenience methods. Those
 * stay consumer-owned; the subsystem ships the substrate.
 *
 * ## Responsibilities
 *
 *   - `startRun`     — INSERT integration_runs row in status='running', returns id.
 *   - `recordItem`   — validates `changedFields` via `FieldDiffSchema.parse`
 *                      BEFORE the INSERT; a malformed shape throws before
 *                      any DB call fires. Enforces the ADR-0003 contract at
 *                      the write boundary.
 *   - `completeRun`  — UPDATE integration_runs with terminal status, counts,
 *                      cursor_after, duration_ms, completed_at.
 *
 * ## Multi-tenancy
 *
 * When `INTEGRATION_MULTI_TENANT` is true (SYNC-6):
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
  IIntegrationRunRecorder,
  RecordItemInput,
  StartRunInput,
  IntegrationRunSummary,
} from './integration-run-recorder.protocol';
import { integrationRuns, integrationRunItems, integrationSubscriptions } from './integration-audit.schema';
import { FieldDiffSchema } from './integration-field-diff.protocol';
import { INTEGRATION_MULTI_TENANT } from './integration.tokens';
import { assertTenantId } from './integration-errors';

@Injectable()
export class DrizzleIntegrationRunRecorder implements IIntegrationRunRecorder {
  private readonly multiTenant: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() @Inject(INTEGRATION_MULTI_TENANT) multiTenant?: boolean,
  ) {
    this.multiTenant = multiTenant ?? false;
  }

  async startRun(input: StartRunInput): Promise<{ id: string }> {
    assertTenantId(input.tenantId, {
      multiTenant: this.multiTenant,
      operation: 'startRun',
    });

    const rows = await this.db
      .insert(integrationRuns)
      .values({
        subscriptionId: input.subscriptionId,
        direction: input.direction,
        action: input.action,
        status: 'running',
        cursorBefore: input.cursorBefore ?? null,
        tenantId: input.tenantId ?? null,
      })
      .returning({ id: integrationRuns.id });

    const id = rows[0]?.id;
    if (!id) {
      // Drizzle's insert().returning() contract: at least one row is
      // returned for every successful INSERT. A missing id would indicate
      // a driver misbehavior; throw loudly rather than return bogus data.
      throw new Error('DrizzleIntegrationRunRecorder: INSERT RETURNING produced no id');
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

    await this.db.insert(integrationRunItems).values({
      integrationRunId: input.integrationRunId,
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
  ): Promise<IntegrationRunSummary[]> {
    assertTenantId(tenantId, {
      multiTenant: this.multiTenant,
      operation: 'listRecent',
    });

    // JOIN against integration_subscriptions to resolve `integration_id` per run.
    // `integration_runs.subscription_id` is a non-null FK so INNER JOIN is correct;
    // there should be no orphaned runs.
    const conditions: SQL[] = [];
    if (subscriptionId !== undefined) {
      conditions.push(eq(integrationRuns.subscriptionId, subscriptionId));
    }
    if (this.multiTenant) {
      conditions.push(eq(integrationRuns.tenantId, tenantId as string));
    }
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await this.db
      .select({
        id: integrationRuns.id,
        subscriptionId: integrationRuns.subscriptionId,
        integrationId: integrationSubscriptions.integrationId,
        status: integrationRuns.status,
        startedAt: integrationRuns.startedAt,
        completedAt: integrationRuns.completedAt,
        recordsProcessed: integrationRuns.recordsProcessed,
        tenantId: integrationRuns.tenantId,
      })
      .from(integrationRuns)
      .innerJoin(
        integrationSubscriptions,
        eq(integrationRuns.subscriptionId, integrationSubscriptions.id),
      )
      .where(where)
      .orderBy(desc(integrationRuns.startedAt))
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
      .update(integrationRuns)
      .set({
        status: input.status,
        recordsFound: input.recordsFound,
        recordsProcessed: input.recordsProcessed,
        cursorAfter: input.cursorAfter ?? null,
        durationMs: input.durationMs,
        error: input.error ?? null,
        completedAt: new Date(),
      })
      .where(eq(integrationRuns.id, runId));
  }
}
