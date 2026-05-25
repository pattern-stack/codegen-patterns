# OBS-LIST-1 — row-level list reads in the observability combiner

**Status:** Implemented (2026-05-25, branch `feat/obs-list-1-combiner-reads`)
**Date:** 2026-05-25
**Source:** dbi `.ai-docs/rfcs/0005-observability-runs-events-viewer.md`, ADR-025 (Combiner Subsystems) §70, dealbrain-v2 `specs/2026-04-22-jobs-events-viewer-mvp.md`
**Origin:** The Jobs & Events viewer's row-level read endpoints are currently **app-level and duplicated** across dealbrain-v2 (`src/shared/observability/`) and dealbrain-integrations (`src/shared/observability/`, lifted this session). Per Hard Rule #5 (shows up twice → upstream), consolidate the *queries* into the observability combiner.

---

## Problem & goal

The observability combiner (`runtime/subsystems/observability/`, ADR-025) today exposes **aggregate** reads — `getPoolDepths`, `getRecentFailedJobs`, `getBridgeDeliveryHistogram`, `getRecentSyncRuns`, `getCursors`. It does **not** offer a general paginated list of `job_run` or `domain_events`, nor a correlation timeline. So every consumer hand-writes those (dealbrain-v2 + dbi both do).

**Goal:** add **row-level list reads** to the combiner so consumers expose only thin HTTP controllers over it. ADR-025 §70 sanctions exactly this: "new observability reads extend the existing ports and land in the existing backend classes; they do not introduce a repository layer."

## Scope — three new combiner reads

Add to the `IObservability` facade (and the composing ports):

1. **`listJobRuns(query)`** — paginated/filterable `job_run` list.
   - `query: { poolId?, status?, since?, cursor?, limit }` → `{ items: JobRunSummary[], nextCursor }`.
   - Composes `IJobRunService` — **add `listJobRuns(query)` to the job-run service** (protocol + drizzle + memory backends), alongside the existing `countByPoolAndStatus` / `listRecentFailed`. Keyset pagination on `created_at`.
2. **`listEvents(query)`** — paginated/filterable `domain_events` list.
   - `query: { rootRunId?, poolId?, direction?, since?, cursor?, limit, tenantId? }`. `rootRunId` filters via `metadata->>'rootRunId'`.
   - Needs a **read port over `domain_events`** — the events subsystem currently exposes `EVENT_BUS` (publish/findById/subscribe). Add a read method (`listEvents(query)`) to the events read surface, or a small `IEventReadPort`, that the combiner composes `@Optional()`.
3. **`getCorrelationTimeline(rootRunId)`** — stitches `listEvents({ rootRunId })` + the job runs sharing `root_run_id` into one chronological timeline + summary.

### What was actually built (post-implementation truth)

- **`listJobRuns`** lives on `IJobRunService` (protocol + Drizzle + Memory backends) returning `{ items: JobRunSummary[], nextCursor: string | null }`. `JobRunSummary` is a narrow projection that **also carries `rootRunId`** so the timeline can stitch without a second lookup. `ListJobRunsQuery` gained a **`rootRunId` filter** (not in the original sketch) — the timeline needs "all runs sharing this root", and adding it to the public query (rather than relying on the concrete-class-only `findByRootRunId`) keeps the combiner on the protocol surface.
- **`listEvents`** lives on a **new dedicated `IEventReadPort`** (`runtime/subsystems/events/event-read.protocol.ts`) bound to the **new `EVENT_READ_PORT` token**, NOT bolted onto `IEventBus`. Rationale: `IEventBus` is a write+dispatch port; reads are a separate concern, and crucially the **Redis backend retains no history** — it simply does not provide the read port. `EventsModule.forRoot` binds `EVENT_READ_PORT` → the same backend instance for `drizzle`/`memory`, and to **`null`** for `redis`. The combiner injects it `@Optional()` and treats both "absent" and "null" as degradation → empty page.
- **Keyset pagination.** Both reads use opaque base64url cursors over `(orderKey, id)` — `(created_at, id)` for runs, `(occurred_at, id)` for events — with an `id` desc tie-break so identical timestamps paginate deterministically. Two small self-contained codecs (`job-run-keyset-cursor.ts`, `event-keyset-cursor.ts`), one per owning subsystem (no cross-subsystem import). `limit` is clamped to `[1, 200]`, default 50. Malformed cursors decode to `null` → "start from the beginning" (no throw on user input).
- **`getCorrelationTimeline`** drains BOTH ports page-by-page via their cursors (capped at `MAX_TIMELINE_PAGES = 50` as a safety bound), merges into one **ascending** timeline (`CorrelationTimelineEntry` discriminated on `kind: 'job_run' | 'event'`), tie-breaking job-run-before-event at equal instants, and rolls up `{ runCount, eventCount, startedAt, lastActivityAt }`. `tenantId` passes through to both ports verbatim.
- **Memory backend `EventSummary.status`** is reported as `'processed'` (the memory bus dispatches synchronously, so a published event is by definition handled); `pool`/`direction`/`tier`/`tenantId`/`rootRunId` are read from `metadata` (the Drizzle backend stamps them onto first-class columns at publish time, so the projections agree).

## Reference implementation (the queries to move upstream)

The exact query logic already exists — lift it from the consumer into the composed ports:
- `dealbrain-integrations/src/shared/observability/jobs.service.ts` — `list(q)` + `findByRootRunId` (job_run select/filter/paginate).
- `.../events.service.ts` — `list(q)` (domain_events select + `metadata->>'rootRunId'`).
- `.../correlations.service.ts` — the stitch + summary.

These are pure `DRIZZLE` selects over `jobRuns` / `domainEvents` — they belong in the job-run service + an events read port, composed by the combiner. (dealbrain-v2 has byte-identical logic.)

## Out of scope (stays app-level)

- **HTTP shapes + controllers.** `JobRunView`/`EventView` (the flattened HTTP DTOs) and the `@Controller('api/observability')` routes + auth are *consumer conventions* — keep them app-level (dealbrain-v2's `DevStatusModule` reasoning). After this lands, the consumer's `*.service.ts` shrink to thin controllers calling the combiner; the DTOs stay.
- The frontend (viewer UI on `@pattern-stack/frontend-patterns`).

## Verification

- Unit-test the new combiner reads + the new port methods (drizzle + memory) against seeded `job_run`/`domain_events`.
- `@Optional()` degradation: combiner returns empty when a sibling port is absent (ADR-025 §61).

**Done.** New unit tests (all passing, run under `just test-unit`):
- `src/__tests__/runtime/subsystems/job-run-service.list-job-runs.unit.spec.ts` — Memory `listJobRuns`: ordering, poolId/status/rootRunId/since filters, keyset round-trip + id tie-break, limit clamp, malformed cursor, projection, tenant matrix.
- `src/__tests__/runtime/subsystems/event-read.list-events.unit.spec.ts` — Memory `listEvents`: ordering, pool/direction/rootRunId/since/tenantId filters, keyset round-trip, projection, malformed cursor.
- `src/__tests__/runtime/subsystems/observability.list-reads.spec.ts` — combiner delegation + verbatim query passthrough, missing-port degradation (JOB_RUN_SERVICE absent; EVENT_READ_PORT absent AND null/redis), timeline stitch + multi-page cursor drain + tenant passthrough.
- `events-module.spec.ts` gained a case asserting `EVENT_READ_PORT` binds to the same Memory backend instance.

Drizzle backends are covered structurally (shared cursor codec + projection helpers) but the SQL paths are not exercised against a live Postgres here — `just test-unit` has no DB. They mirror the Memory backend semantics 1:1; integration coverage would land with the dbi consumer swap (RFC-0005).

## Consumer follow-up (dbi)

dbi swaps its hand-lifted `src/shared/observability/{jobs,events,correlations}.service.ts` query bodies for calls into the combiner (`OBSERVABILITY` token), keeping `ObservabilityViewerModule`'s controllers + DTOs. Tracked in dbi RFC-0005.

## Related
- [BULLMQ-1](BULLMQ-1.md), [CREATE-DTO-1](CREATE-DTO-1.md).
- Note: ADR-025 is "Combiner Subsystems" (= observability/bridge), **not** signals — the jobs `phase-roadmap.md` mislabelled Phase 3. **Corrected in this PR**: Phase 3 heading + the deferral table now say "signals ADR TBD — NOT ADR-025", with a dated note. The schema placeholder columns (`wait_kind`/`resume_token`/`wait_deadline`) still carry `// Phase 3 placeholder — see ADR-025` comments; left as-is (out of this spec's code scope) but flagged in the roadmap note as the same historical mislabel.
