# Orchestrator flow

`ExecuteIntegrationUseCase<T>` is the one generic integration loop in the codebase.
This file walks through its lifecycle, failure semantics, and the
decisions that are non-obvious until you've debugged a run.

## Happy-path lifecycle

```
execute(input)
  ├─ assertTenantId(input.tenantId, …)        ← throws BEFORE startRun when multiTenant
  ├─ cursorBefore = cursors.get(subId, tenantId)
  ├─ runId = recorder.startRun({subId, direction, action, cursorBefore, tenantId})
  │
  ├─ for await (change of source.listChanges(sub, cursorBefore)):
  │    recordsFound++
  │    latestCursor = change.cursor
  │    cursorAdvanced = true
  │
  │    try:
  │      if loopback.isEchoOfOwnWrite(…): recordItem({operation:'noop', status:'skipped'}); continue
  │
  │      if change.operation === 'deleted':
  │        result = sink.softDeleteByExternalId(…)
  │        recordItem({operation: result ? 'deleted' : 'noop', status:'success', localId: result?.id})
  │      else:
  │        existing = sink.findByExternalId(…)
  │        diff = differ.diff(existing, change.record, change.providerChangedFields)
  │        if diff === 'noop':
  │          recordItem({operation:'noop', status:'success'})
  │        else:
  │          { id } = sink.upsertByExternalId(…)
  │          recordItem({operation: existing===null ? 'created' : 'updated', status:'success', localId: id, changedFields: diff})
  │      recordsProcessed++
  │    catch:
  │      recordsFailed++
  │      recordItem({status:'failed', error})
  │
  ├─ if cursorAdvanced: cursors.put(subId, latestCursor, tenantId)
  └─ recorder.completeRun(runId, { status, counts, cursorAfter, durationMs, error })
```

## Five design decisions worth memorizing

### 1. `assertTenantId` fires BEFORE `startRun`

When `multiTenant=true` and `input.tenantId` is null/missing, the
orchestrator throws `MissingTenantIdError` at entry. Critically, this
happens before the `integration_runs` row is opened — no dangling
`status=running` rows for rejected inputs. The Drizzle backends
independently re-validate at their write boundary (defense in depth);
all three sites use the shared `assertTenantId` helper so error
messages are identical.

### 2. Cursor advance is per-successful-yield, not per-run

`latestCursor = change.cursor` updates on every iterator yield. The
cursor is persisted in `cursors.put()` once at the end — but the value
is whatever the iterator last produced, regardless of whether that
record succeeded, failed, or was skipped for loopback.

Consequence: a source that yields 10 records and throws on record 11
still persists the cursor of record 10. Re-running picks up at record
11, not back at the beginning.

### 3. All-failed runs still advance the cursor

If every record in a run throws from the sink, the orchestrator:
- records each failure as a `integration_run_items` row with `status='failed'`
- marks the run `status='failed'` with `error: 'all N records failed'`
- **still persists the new cursor** (last-yielded)

Rationale: the source kept yielding. Re-running would not re-deliver
those records. Retry semantics (dead-letter replay, `action: 'manual'`
resync with a `sourceOverride`) are caller-owned.

**This is the most common "wait, what?" moment for first-time
consumers.** Document it in your runbooks. If you want different
semantics (hold cursor on all-fail), wrap the orchestrator with a
retry policy layer — don't change the subsystem default.

### 4. Source-iterator throws persist last-good cursor

If `source.listChanges(...)` throws mid-iteration (auth expiry,
network error, upstream rate-limit), the orchestrator catches,
marks the run `status='failed'`, persists `latestCursor`, and runs
`completeRun` in the finally clause.

Consequence: partial runs don't lose progress. Re-running resumes
from the last successful yield.

Source throws BEFORE any yield (e.g. connect timeout) → cursor is not
advanced (`cursorAdvanced` stays false); `cursors.put()` is skipped;
`completeRun` runs with `cursorAfter: cursorBefore`.

### 5. `completeRun` is in a finally block

A thrown `startRun` / sink call / whatever still reaches
`completeRun`. The run always terminates — no in-flight rows stuck in
`status='running'`. Operator cleanup queries work against `completed_at
IS NULL` filters.

## Per-item failure does not fail the run

The orchestrator's try/catch is per-record. One bad record increments
`recordsFailed` and logs it; the loop continues. A run with 9
successes + 1 failure is `status='success'` with
`recordsProcessed: 9, recordsFailed: 1`.

Only when **every** record fails AND at least one was seen does the
run get `status='failed'` (see design decision 3).

## Loopback filter

When `INTEGRATION_LOOPBACK_FINGERPRINT_STORE` is bound, every change goes
through `isEchoOfOwnWrite(entityType, externalId, record)` first. An
echo is recorded as `operation='noop', status='skipped'` with empty
`changed_fields` — the audit log shows the skip so you can verify the
suppression is working, but the sink is never called.

Absent binding (`@Optional()` yields undefined), the check is skipped
and all changes proceed normally.

## Deletion branch

`change.operation === 'deleted'` short-circuits the diff path. The
orchestrator calls `sink.softDeleteByExternalId(userId, externalId)`;
if the sink returns null (no local row), the item is recorded as
`operation='noop', status='success'` — deletion of a never-integrated
record is not an error. If the sink returns `{ id }`, the item is
recorded as `operation='deleted'` with the local id.

`changed_fields` is always `{}` for deletions. The deletion itself is
the change; per-field before/after would be redundant.

## Noop emission

`differ.diff(existing, incoming, ...) === 'noop'` short-circuits
before the sink write. The item is recorded with
`operation='noop', status='success'` and no sink call. This is the
common case on cursor-over-poll runs where the differ-ignore list
covers every upstream-updated field (e.g. SFDC bumps `SystemModstamp`
but no canonical column changed).

## `cursors.put` failure handling

If the cursor persist throws (DB down, tenancy check failed), the
orchestrator logs the error; if the run was otherwise successful, it
promotes the run to `status='failed'` with
`error: 'cursor put failed: ...'` and completes normally.

Rationale: a successful run-log but no cursor advance is a bigger
operational footgun than a failed-run marker — the next run would
re-process every record. Failing loudly surfaces the cursor problem.

## What the orchestrator does NOT do

- **Does not emit events.** That's a consumer concern. Wire
  `TypedEventBus.publish(...)` inside your `IIntegrationSink.upsertByExternalId`
  transaction — after the row is saved, before the transaction commits.
- **Does not schedule itself.** Scheduling (a cron, a job, a webhook
  handler) is the caller's concern. Consumers typically wire
  `ExecuteIntegrationUseCase` to a scheduled job in the `events_inbound` pool.
- **Does not retry.** Per-item failures are recorded and skipped;
  run-level failures bubble up to the caller. Retry policies (dead-
  letter queues, manual re-integration, backoff) are caller-owned.
- **Does not resolve subscriptions.** `input.subscription` is passed in
  by the caller. Subscription lookup / filtering / enabled-check is
  the caller's concern (typically via a `IntegrationSubscriptionService` the
  consumer owns).
