# Dealbrain BullMQ Audit

**Scope:** Read-only audit of `/Users/dug/Projects/dealbrain` (the actual project location — the nominal `dev/dealbrain-agent` path is empty). Single backend at `apps/backend/`.

## Verdict — Pattern (2): "Native features," deeply

Dealbrain uses BullMQ as a full job-orchestration platform, not a transport. It leans on FlowProducer, JobScheduler (cron), Bull Board, per-queue concurrency, and native deduplication. Ripping BullMQ out would require reimplementing ~5 distinct BullMQ capabilities. A thin `IJobQueue` transport port would leak.

## Feature usage

| Feature | Used? | Example |
|---|---|---|
| `Queue.add()` / `addBulk()` | Yes | `apps/backend/src/infrastructure/events/bullmq.service.ts:45, 89` |
| `Worker` via `@Processor` | Yes (35+ processors) | `apps/backend/src/presentation/event-handlers/opportunity-upserted.event-handler.ts:18` |
| **`FlowProducer` (parent/child)** | **Yes** | `apps/backend/src/infrastructure/events/bullmq.service.ts:20, 100-102`; call sites: `presentation/event-handlers/sync-gmail-emails-for-user.event-handler.ts:97`, `applications/use-cases/reprocess-failed-artifacts.use-case.ts:128`, `process-pending-artifacts.use-case.ts:123`, `start-import.use-case.ts:81`. Uses `removeDependencyOnFailure` flag. |
| **`upsertJobScheduler` (cron)** | **Yes — 8 cron jobs** | `apps/backend/src/infrastructure/events/scheduler.service.ts` — heartbeat, gmail, calendar, granola, transcripts, transcript-retry, SF poll, notion. Patterns like `*/5 * * * *`, `0 */6 * * *`. |
| **`attempts` + exponential `backoff`** | **Yes, globally** | `queue.module.ts:44-49` — `DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 }` |
| **Per-processor `concurrency`** | **Yes, tuned per queue** | 28 processors with explicit concurrency (1, 3, 5, 10); e.g. `retry-transcript-enrichment.event-handler.ts:10` `concurrency: 1` "Single consumer to avoid racing on the pending queue" |
| `lockDuration` / stalled tuning | Yes | `queue.module.ts:51-55` — `LONG_RUNNING_WORKER_OPTIONS = { lockDuration: 300_000, stalledInterval: 30_000, maxStalledCount: 1 }` |
| **`jobId` dedup + `deduplication` TTL** | **Yes, heavily** | `bullmq.service.ts:47-61`; call site `sync-gmail-emails-for-user.event-handler.ts:127` with `ttl: 10 * 60 * 1000`. `PublishEventOptions` exposes both as first-class. |
| **Bull Board dashboard** | **Yes, prod-mounted** | `apps/backend/src/main.ts:4-6, 39-65` — all 36 queues wrapped in `BullMQAdapter`, mounted at `/api/admin/queues`, gated by admin auth middleware. Deps: `@bull-board/api`, `@bull-board/express` in `package.json:34-35`. |
| Rate limiter (`limiter: { max, duration }`) | No | Rate limiting done in app code (`p-limit`-style in `core/notion/notion.service.ts`) |
| `priority` | No | — |
| `QueueEvents` | No (only mocked in `app.module.spec.ts:72`) | — |
| `job.updateProgress()` / `job.log()` | No (`updateProgress` seen is on `SyncJobRepository`, not BullMQ `Job`) | — |
| Repeatable (`repeat:` on `add`) | Uses newer `upsertJobScheduler` API instead | — |

## Queue topology

**36 distinct queue names** registered in `queue.module.ts:57-94` via `BullModule.registerQueue(...)`. One queue per event/job type (e.g. `import-opportunities-queue`, `sync-gmail-emails-queue`, `artifact-created-queue`). Each queue has exactly one `@Processor` — not a mega-queue. A single `FlowProducer` named `default` registered for parent/child flows (`queue.module.ts:111`).

## Is BullMQ also the event bus? Yes — and Doug already considers this a problem

There is no separate event bus. The `IQueueProvider` (`apps/backend/src/domain/events/queueProvider.interface.ts`) is the sole dispatch path; every `BaseEvent` subclass hardcodes a `queueName` and is enqueued as a BullMQ job. Doug's own architecture doc at `/Users/dug/Projects/dealbrain/docs/architecture/event-and-job-system.md` (authored 2026-04-17) explicitly says:

> "In our system, **events and jobs are the same thing.** … We should invest in separating a narrow event bus and a dedicated job queue…"
> "Define `IEventBus` and `IJobQueue` as distinct interfaces — today both resolve to the same BullMQ-backed implementation under the hood."

## Pain points (documented)

1. **2026-04-17 onboarding incident** (`docs/incidents/2026-04-17-slow-onboarding.md`): a stuck job blocked a worker slot for up to `lockDuration=300s`; BullMQ workers outside one specific queue **don't emit Sentry transactions** (AI-2) — observability gap.
2. **Worker-pool starvation** — "All compete for the same BullMQ worker pool at concurrency: 10. 44-min artifact gap at 17:26–18:09 confirms starvation." (incident, line 67)
3. **Deduplication misuse** — deterministic `jobId` used to express "debounce signal," causing dropped signals when the prior job got stuck in `active` (architecture doc, §1).
4. **Thundering herd** — `scheduler.service.ts:14-18` TODO: multiple cron jobs aligned on `*/5` forced an offset pattern workaround.

## Recommendation for codegen-patterns

**Yes, Dealbrain would adopt a BullMQ `IJobOrchestrator` backend — but would NOT benefit from a swappable `IJobQueue` transport port.**

- They need: FlowProducer (DAGs), cron scheduling, per-queue concurrency, dedup/TTL, Bull Board, retries+backoff. These are the orchestrator's job — they define what "orchestrator" means for them.
- They don't need: low-level queue substrate abstraction. `Queue.add`/`Worker` are implementation details under the orchestrator; a transport port would only drag the same BullMQ semantics through a thinner interface (exactly the "domain imports BullMQ primitives" smell Doug flags).
- Recommended codegen-patterns shape: keep BullMQ **only** at the high-level `IJobOrchestrator` port (with `enqueue`, `flow`, `schedule`, `dedup` as first-class operations). Pair it with a separate `IEventBus` port (memory/outbox) — exactly the split Doug's own ADR is proposing. Dealbrain would migrate to this on day one.
