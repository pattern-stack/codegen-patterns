/**
 * ExecuteIntegrationUseCase — the generic integration orchestrator (SYNC-5).
 *
 * One class. Reused across every `(provider, detection-mode, canonical-entity)`
 * tuple. Parameterized over `T` so canonical records stay typed end-to-end.
 *
 * Flow per run:
 *
 *   1. `recorder.startRun(...)` — opens a `integration_runs` row in 'running'.
 *   2. for each change yielded by `source.listChanges(subscription, cursorBefore)`:
 *        a. differ.diff(existing, incoming) → 'noop' short-circuits to
 *           a noop audit row (no sink write).
 *        b. sink.upsertByExternalId / softDeleteByExternalId → records
 *           the local id on the audit row.
 *        c. per-item try/catch — a failed item increments the failed
 *           counter and records `status: 'failed'` with `error`, but
 *           does NOT abort the run.
 *        d. advance `latestCursor = change.cursor` as the iterator moves.
 *   3. `cursors.put(subscription.id, latestCursor)` when the loop completes
 *      AND at least one cursor advance happened. On exceptions from the
 *      source iterator (auth expiry, network error), we persist the
 *      last-good cursor so the next run resumes from the last known
 *      successful position.
 *   4. `finally { recorder.completeRun(...) }` — always terminates the run.
 *
 * Loopback suppression — when a consumer's writes echo back on the next
 * inbound poll/CDC/webhook — is composed into the source's middleware
 * chain via `createLoopbackMiddleware(store)` (#226-5 / ADR-033). The
 * orchestrator no longer special-cases echoes: middleware drops them
 * before they reach this loop. Consumers that don't have outbound
 * writeback paths simply omit the middleware.
 *
 * ## Generics
 *
 * - `T` = canonical record shape from the adapter side. Same `T` flows
 *   through `IChangeSource<T>`, `IFieldDiffer<T>`, `IIntegrationSink<T>`.
 *
 * ## No CRM bleed
 *
 * Per the SYNC-5 issue's extraction notes (HS-9 finding), this orchestrator
 * is strictly provider-agnostic:
 *   - `entityType` is `string` throughout; no `'opportunity' | 'account' | ...`
 *     narrowing leaks into the use case
 *   - the upstream consumer's `IntegrationRunRecorderService` class injection replaced with the
 *     `IIntegrationRunRecorder` protocol (backend lands in SYNC-4)
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IChangeSource, Change } from './integration-change-source.protocol';
import type { ICursorStore } from './integration-cursor-store.protocol';
import type { IFieldDiffer, FieldDiff } from './integration-field-diff.protocol';
import type { IIntegrationSink } from './integration-sink.protocol';
import type { IIntegrationRunRecorder } from './integration-run-recorder.protocol';
import { assertTenantId } from './integration-errors';
import {
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_CURSOR_STORE,
  INTEGRATION_FIELD_DIFFER,
  INTEGRATION_MULTI_TENANT,
  INTEGRATION_RUN_RECORDER,
  INTEGRATION_SINK,
} from './integration.tokens';

// ============================================================================
// Inputs + result
// ============================================================================

export interface ExecuteIntegrationInput<T> {
  /** The subscription whose cursor/identity frames this run. */
  readonly subscription: {
    readonly id: string;
    readonly domain: string; // entityType — used on audit rows
    readonly externalRef?: string | null;
  };
  /** Per-run user context; threaded through sink writes. */
  readonly userId: string;
  /** Provider label persisted on saved rows, e.g. `'salesforce-crm'`. */
  readonly provider: string;
  /** Run direction — almost always `'inbound'`. Reserved for writeback. */
  readonly direction: 'inbound' | 'outbound';
  /** Detection mode — maps 1:1 to `integration_runs.action`. */
  readonly action: 'poll' | 'cdc' | 'webhook' | 'manual' | 'writeback';
  /** Multi-tenant deployments pass the tenant id through. */
  readonly tenantId?: string | null;
  /**
   * Optional override — inject a specific change source for this run when
   * the DI-bound source is not the one to use (e.g. manual backfill with
   * a custom cursor). Defaults to the DI-resolved `INTEGRATION_CHANGE_SOURCE`.
   */
  readonly sourceOverride?: IChangeSource<T>;
}

export interface ExecuteIntegrationResult {
  readonly runId: string;
  readonly status: 'success' | 'no_changes' | 'failed';
  readonly recordsFound: number;
  readonly recordsProcessed: number;
  readonly recordsFailed: number;
  readonly cursorBefore: unknown | null;
  readonly cursorAfter: unknown | null;
  readonly durationMs: number;
  readonly error?: string | null;
}

// ============================================================================
// ExecuteIntegrationUseCase
// ============================================================================

@Injectable()
export class ExecuteIntegrationUseCase<T extends Record<string, unknown>> {
  private readonly logger = new Logger(ExecuteIntegrationUseCase.name);

  constructor(
    @Inject(INTEGRATION_CHANGE_SOURCE) private readonly source: IChangeSource<T>,
    @Inject(INTEGRATION_CURSOR_STORE) private readonly cursors: ICursorStore,
    @Inject(INTEGRATION_FIELD_DIFFER) private readonly differ: IFieldDiffer<T>,
    @Inject(INTEGRATION_SINK) private readonly sink: IIntegrationSink<T>,
    @Inject(INTEGRATION_RUN_RECORDER) private readonly recorder: IIntegrationRunRecorder,
    @Optional()
    @Inject(INTEGRATION_MULTI_TENANT)
    private readonly multiTenant: boolean = false,
  ) {}

  async execute(input: ExecuteIntegrationInput<T>): Promise<ExecuteIntegrationResult> {
    // Defense-in-depth tenancy guard — fire BEFORE startRun so a rejected
    // input never leaves a dangling `status=running` row. Backends also
    // enforce (SYNC-4), but failing fast at the orchestrator boundary is
    // cheaper for observability, metrics, and manual cleanup.
    assertTenantId(input.tenantId, {
      multiTenant: this.multiTenant,
      operation: 'execute',
    });

    const source = input.sourceOverride ?? this.source;
    const startedAt = Date.now();
    const cursorBefore = await this.cursors.get(input.subscription.id, input.tenantId);

    const { id: runId } = await this.recorder.startRun({
      subscriptionId: input.subscription.id,
      direction: input.direction,
      action: input.action,
      cursorBefore,
      tenantId: input.tenantId,
    });

    let recordsFound = 0;
    let recordsProcessed = 0;
    let recordsFailed = 0;
    let latestCursor: unknown | null = cursorBefore;
    let cursorAdvanced = false;
    let runError: string | null = null;
    let status: 'success' | 'no_changes' | 'failed' = 'no_changes';

    try {
      for await (const change of source.listChanges(input.subscription, cursorBefore)) {
        recordsFound++;
        latestCursor = change.cursor;
        cursorAdvanced = true;

        try {
          await this.processChange(runId, input, change);
          recordsProcessed++;
        } catch (err) {
          recordsFailed++;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `integration item failed: subscription=${input.subscription.id} externalId=${change.externalId}: ${message}`,
          );
          await this.recorder.recordItem({
            integrationRunId: runId,
            entityType: input.subscription.domain,
            externalId: change.externalId,
            operation: change.operation === 'deleted' ? 'deleted' : 'updated',
            status: 'failed',
            changedFields: {},
            error: message,
            tenantId: input.tenantId,
          });
        }
      }

      if (recordsFailed > 0 && recordsProcessed === 0 && recordsFound > 0) {
        // Every record we saw failed — call the run a failure, not a
        // success. Partial success (some processed, some failed) still
        // counts as 'success' so the cursor advances.
        status = 'failed';
        runError = `all ${recordsFailed} records failed`;
      } else if (recordsFound === 0) {
        status = 'no_changes';
      } else {
        status = 'success';
      }
    } catch (err) {
      // Source iterator itself threw — cursor DOES NOT advance past the
      // last-successful cursor. `latestCursor` still holds the last
      // `change.cursor` we observed, which is the furthest we know to
      // have delivered. Persist it (below) so next run resumes there.
      status = 'failed';
      runError = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `integration source failed: subscription=${input.subscription.id}: ${runError}`,
      );
    }

    // Persist cursor advance only when something actually moved. Never
    // overwrite a valid cursor with `null` on a no-change run.
    if (cursorAdvanced && latestCursor !== null && latestCursor !== undefined) {
      try {
        await this.cursors.put(input.subscription.id, latestCursor, input.tenantId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `cursor put failed: subscription=${input.subscription.id}: ${message}`,
        );
        if (status !== 'failed') {
          status = 'failed';
          runError = `cursor put failed: ${message}`;
        }
      }
    }

    const durationMs = Date.now() - startedAt;

    await this.recorder.completeRun(runId, {
      status,
      recordsFound,
      recordsProcessed,
      cursorAfter: cursorAdvanced ? latestCursor : cursorBefore,
      durationMs,
      error: runError,
    });

    return {
      runId,
      status,
      recordsFound,
      recordsProcessed,
      recordsFailed,
      cursorBefore,
      cursorAfter: cursorAdvanced ? latestCursor : cursorBefore,
      durationMs,
      error: runError,
    };
  }

  private async processChange(
    runId: string,
    input: ExecuteIntegrationInput<T>,
    change: Change<T>,
  ): Promise<void> {
    // Deletion branch — no diff, no upsert; soft-delete via sink.
    if (change.operation === 'deleted') {
      const result = await this.sink.softDeleteByExternalId(
        input.userId,
        change.externalId,
      );
      await this.recorder.recordItem({
        integrationRunId: runId,
        entityType: input.subscription.domain,
        externalId: change.externalId,
        localId: result?.id ?? null,
        operation: result ? 'deleted' : 'noop',
        status: 'success',
        changedFields: {},
        tenantId: input.tenantId,
      });
      return;
    }

    // Create/update path — diff against local state, short-circuit on noop.
    const existing = await this.sink.findByExternalId(
      input.userId,
      change.externalId,
    );
    const diff = this.differ.diff(
      existing,
      change.record,
      change.providerChangedFields,
    );

    if (diff === 'noop') {
      // Sinks that declare `reprojectsOnNoop` reproject side data the differ
      // can't see (e.g. EAV field_values) — so fall through to the idempotent
      // upsert instead of short-circuiting. The canonical state is unchanged,
      // so the audit `operation` stays `'noop'`, but we capture the local id
      // returned by the upsert. Sinks without the flag keep today's behavior.
      if (!this.sink.reprojectsOnNoop) {
        await this.recorder.recordItem({
          integrationRunId: runId,
          entityType: input.subscription.domain,
          externalId: change.externalId,
          localId: null,
          operation: 'noop',
          status: 'success',
          changedFields: {},
          tenantId: input.tenantId,
        });
        return;
      }

      const { id: noopLocalId } = await this.sink.upsertByExternalId(
        input.userId,
        change.record,
        input.provider,
      );
      await this.recorder.recordItem({
        integrationRunId: runId,
        entityType: input.subscription.domain,
        externalId: change.externalId,
        localId: noopLocalId,
        operation: 'noop',
        status: 'success',
        changedFields: {},
        tenantId: input.tenantId,
      });
      return;
    }

    const { id: localId } = await this.sink.upsertByExternalId(
      input.userId,
      change.record,
      input.provider,
    );

    await this.recorder.recordItem({
      integrationRunId: runId,
      entityType: input.subscription.domain,
      externalId: change.externalId,
      localId,
      operation: existing === null ? 'created' : 'updated',
      status: 'success',
      changedFields: diff as FieldDiff,
      tenantId: input.tenantId,
    });
  }
}
