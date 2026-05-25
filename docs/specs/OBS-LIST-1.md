# OBS-LIST-1 — row-level list reads in the observability combiner

**Status:** Draft — ready to build
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
   - `query: { rootRunId?, poolId?, direction?, since?, cursor?, limit }`. `rootRunId` filters via `metadata->>'rootRunId'`.
   - Needs a **read port over `domain_events`** — the events subsystem currently exposes `EVENT_BUS` (publish/findById/subscribe). Add a read method (`listEvents(query)`) to the events read surface, or a small `IEventReadPort`, that the combiner composes `@Optional()`.
3. **`getCorrelationTimeline(rootRunId)`** — stitches `listEvents({ rootRunId })` + the job runs sharing `root_run_id` into one chronological timeline + summary.

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

## Consumer follow-up (dbi)

dbi swaps its hand-lifted `src/shared/observability/{jobs,events,correlations}.service.ts` query bodies for calls into the combiner (`OBSERVABILITY` token), keeping `ObservabilityViewerModule`'s controllers + DTOs. Tracked in dbi RFC-0005.

## Related
- [BULLMQ-1](BULLMQ-1.md), [CREATE-DTO-1](CREATE-DTO-1.md).
- Note: ADR-025 is "Combiner Subsystems" (= observability/bridge), **not** signals — the jobs `phase-roadmap.md` mislabels Phase 3. Worth correcting while here; the signals design (`ctx.waitFor/signal/sleep`) has no ADR yet.
