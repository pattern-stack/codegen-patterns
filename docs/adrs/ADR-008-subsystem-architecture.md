# ADR-008 — Subsystem Architecture: Protocol → Backend → Factory

**Status:** Draft
**Date:** 2026-04-12
**Owner:** Doug
**Related:** ADR-001, ADR-003, ADR-005
**Unblocks:** #15 (A11), #16 (A12)

> **Vocabulary note (2026-05-30, ADR-0005):** This ADR predates the `sync`→`integration` rename (shipped in 0.11.0). The "sync subsystem" described below is now the **integration** subsystem (`SyncModule`→`IntegrationModule`, `subsystem install sync`→`… install integration`, `sync_*` tables→`integration_*`). The architecture is unchanged — only the names. See swe-brain `ADR-0005-rename-sync-to-integration` and the 0.11.0 CHANGELOG.

> **Revision note (2026-04-25)** — ADR-033 refines the sync subsystem's
> change-source seam under this Protocol → Backend → Factory pattern:
> `IChangeSource<T>` remains the single port (no per-mode split), but
> per-entity *configuration* (filter / mapping / cursor strategy) moves
> into a declarative `DetectionConfig` Zod schema, and reusable
> primitives (`PollChangeSource<T>`, `WebhookChangeSource<T>`) replace
> hand-authored adapter classes. Loopback fingerprint suppression also
> moves out of the orchestrator into a stock `ChangeMiddleware<T>`
> factory. See `docs/adrs/ADR-033-config-driven-change-sources.md`.

## Context

ADR-003 establishes the sharp test: if an operation produces side effects outside the database, it belongs in a use case. Use cases may emit events, enqueue jobs, call external systems, and manage cache/storage. But the infrastructure that receives those calls — the event bus, job queue, cache service, storage service, and integration adapters — does not exist yet.

Without generated subsystem infrastructure, every team building on codegen-patterns must:
1. Hand-write an event bus interface and implementation
2. Hand-write a job queue interface and implementation  
3. Wire up NestJS modules for each subsystem
4. Write memory-backed test doubles for each
5. Build their own provider registry for external integrations

This is 500+ lines of infrastructure boilerplate per project, identical in shape every time. It should be generated.

The existing broadcast subsystem (`templates/broadcast/`) demonstrates the concept — a protocol interface, pluggable backends (memory, WebSocket), and a NestJS module — but uses a plain `@Module` with hardcoded backend selection. This ADR generalizes and formalizes the pattern with `DynamicModule.forRoot()` for runtime backend selection.

## Decision

### The Pattern: Protocol → Backend → Factory

Every infrastructure subsystem follows one pattern:

```
Protocol (interface)    → What the app calls
Backend (class)         → How the call is fulfilled
Factory (DynamicModule) → Which backend is selected at boot
```

The protocol is the **port** (hexagonal architecture). Backends are **adapters**. The factory is NestJS `DynamicModule.forRoot()` wiring. Use cases inject the protocol via token; they never know which backend is active.

All subsystem injection tokens use `Symbol()` for type safety and collision avoidance:
```typescript
export const EVENT_BUS = Symbol('EVENT_BUS');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const CACHE = Symbol('CACHE');
export const STORAGE = Symbol('STORAGE');
export const OBSERVABILITY = Symbol('OBSERVABILITY'); // added 2026-04-22 — 5th subsystem
```

### Infrastructure Subsystems

Five infrastructure subsystems are generated as one-time scaffolds. None of these exist yet — this ADR proposes their creation via new `bun codegen subsystem <name>` commands and corresponding templates.

#### Events

```
subsystems/events/
├── event-bus.protocol.ts           # IEventBus
├── event-bus.drizzle-backend.ts    # Postgres: domain_events table (outbox)
├── event-bus.memory-backend.ts     # In-memory: array + callbacks
├── domain-events.schema.ts         # Drizzle table definition
├── events.module.ts                # EventsModule.forRoot({ backend })
├── events.tokens.ts                # EVENT_BUS token
└── index.ts
```

**Protocol:**
```typescript
export interface DomainEvent {
  readonly id: string;              // UUID — for deduplication and idempotency
  readonly type: string;            // e.g., 'contact_created'
  readonly aggregateId: string;     // ID of the entity that produced the event
  readonly aggregateType: string;   // e.g., 'contact'
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly metadata?: Record<string, unknown>;
}

// DrizzleTransaction is the Drizzle ORM transaction type from the project's DrizzleClient.
// In practice: import type { DrizzleTransaction } from '@shared/types/drizzle';
// (extends the existing DrizzleClient type alias with transaction support)
type DrizzleTransaction = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];

export interface IEventBus {
  /** Publish events within a Drizzle transaction (outbox pattern). */
  publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void>;
  publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void>;

  /** Subscribe to events by type. Returns unsubscribe function. */
  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void;
}
```

**Transactional outbox pattern:** The `tx` parameter is the key to atomicity. When a use case writes to the database and publishes an event, both happen in the same transaction:

```typescript
// In a use case:
async execute(input: CreateContactInput): Promise<Contact> {
  return this.db.transaction(async (tx) => {
    const contact = await this.contacts.create(input, tx);
    await this.eventBus.publish(new ContactCreatedEvent(contact), tx);
    return contact;
  });
}
```

If the transaction rolls back, the event is never persisted. The Drizzle backend inserts events into the `domain_events` table within the provided transaction. A separate polling process (started via `OnModuleInit`) reads unprocessed events and dispatches to subscribers. The memory backend ignores the `tx` parameter and dispatches synchronously.

**Drizzle table:** `domain_events` with columns: `id` (uuid pk), `type`, `aggregateId`, `aggregateType`, `payload` (jsonb), `occurredAt`, `processedAt` (null until consumed), `metadata` (jsonb). Indexes: `(type, processedAt)` for the polling query, `(aggregateId, aggregateType)` for event replay per entity.

**Memory backend** stores events in an array and dispatches to registered callbacks synchronously. Used in tests to assert event publication without database.

**The `queue` field** in entity YAML event declarations maps to the `metadata.queue` field on published events. Backends that support multiple queues (e.g., a future Redis Streams backend) use this for routing. The Drizzle backend stores it in metadata but processes all events from a single table.

#### Jobs

```
subsystems/jobs/
├── job-queue.protocol.ts           # IJobQueue
├── job-queue.drizzle-backend.ts    # pg-boss pattern
├── job-queue.memory-backend.ts     # In-memory queue
├── job-queue.schema.ts             # Drizzle table definition
├── jobs.module.ts                  # JobsModule.forRoot({ backend })
├── jobs.tokens.ts                  # JOB_QUEUE token
└── index.ts
```

**Protocol:**
```typescript
export interface JobOptions {
  delay?: number;           // ms before processing
  retries?: number;         // max retry count (default: 3)
  backoff?: number;         // ms between retries (default: 1000)
  priority?: number;        // higher = sooner
}

export interface IJobQueue {
  enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string>;
  process<T = unknown>(
    type: string,
    handler: (payload: T) => Promise<void>,
    payloadSchema?: ZodType<T>,
  ): void;
  schedule(type: string, cron: string, payload?: unknown): Promise<string>;
  cancel(jobId: string): Promise<void>;
}
```

The optional `payloadSchema` parameter on `process()` enables runtime validation — the backend parses the stored payload through the Zod schema before passing it to the handler. This closes the type safety gap between `enqueue<T>` and `process<T>`.

**Drizzle backend** follows the pg-boss pattern: a `job_queue` table with `id`, `type`, `payload` (jsonb), `status` (pending/active/completed/failed/expired), `runAt`, `attempts`, `maxRetries`, `backoffMs`, `lastError`, `createdAt`, `completedAt`. Indexes: `(status, runAt)` for the claim query, `(type, status)` for routing. A polling loop (started via `OnModuleInit`, stopped via `OnModuleDestroy`) claims jobs with `UPDATE ... SET status = 'active' WHERE status = 'pending' AND runAt <= now() ... LIMIT 1 RETURNING *`. Advisory locks prevent double-processing. Failed jobs are retried with exponential backoff up to `maxRetries`.

**Memory backend** uses a Map of type → handler and processes jobs synchronously (for tests).

#### Cache

```
subsystems/cache/
├── cache.protocol.ts               # ICacheService
├── cache.drizzle-backend.ts        # Postgres cache with TTL
├── cache.memory-backend.ts         # Map-based
├── cache.schema.ts                 # Drizzle table definition
├── cache.module.ts                 # CacheModule.forRoot({ backend, defaultTtl })
├── cache.tokens.ts                 # CACHE token
└── index.ts
```

**Protocol:**
```typescript
export interface ICacheService {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete all entries matching a key prefix (e.g., 'contact:*' deletes all contact cache). */
  invalidateByPrefix(prefix: string): Promise<number>;
  has(key: string): Promise<boolean>;
}
```

**Sharp test clarification:** Cache *reads* (`get`, `has`) are not side effects — services MAY use them. Cache *writes* (`set`, `delete`, `invalidateByPrefix`) are side effects — they belong in use cases per ADR-003. In practice, a common pattern is: services read from cache, use cases invalidate on mutations.

**Drizzle backend** uses a `cache_entries` table with `key` (primary), `value` (jsonb), `expiresAt` (timestamp). Reads filter by `expiresAt > now()`. `invalidateByPrefix` uses `LIKE prefix%`. Indexes: `(expiresAt)` for cleanup. A periodic cleanup (via jobs subsystem if available, else `setInterval` in `OnModuleInit`) deletes expired entries.

**Memory backend** uses a Map with setTimeout-based expiry.

#### Storage

```
subsystems/storage/
├── storage.protocol.ts             # IStorageService
├── storage.local-backend.ts        # Local filesystem
├── storage.memory-backend.ts       # Buffer map
├── storage.module.ts               # StorageModule.forRoot({ backend, basePath })
├── storage.tokens.ts               # STORAGE token
└── index.ts
```

**Protocol:**
```typescript
export interface IStorageService {
  upload(key: string, data: Buffer | ReadableStream, contentType?: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getUrl(key: string, expiresInSeconds?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}
```

**Local backend** writes to `{basePath}/{key}` on the filesystem. `getUrl` returns a file:// URI. Suitable for dev only.

**Memory backend** stores Buffers in a Map. For tests.

No Drizzle backend — files in Postgres is an antipattern. Users implement S3/GCS backends by implementing `IStorageService`.

#### Observability (added 2026-04-22)

```
subsystems/observability/
├── observability.protocol.ts         # IObservabilityService (5 core methods)
├── observability.drizzle-backend.ts  # Postgres queries over framework tables
├── observability.memory-backend.ts   # Seedable fixture backend for tests
├── observability.module.ts           # ObservabilityModule.forRoot({ backend, reporters })
├── observability.tokens.ts           # OBSERVABILITY, OBSERVABILITY_REPORTERS
├── reporters/
│   └── bridge-metrics.reporter.ts    # Opt-in 60s log sampler over bridge_delivery
└── index.ts
```

**Protocol — the five core methods:**
```typescript
export interface IObservabilityService {
  getPoolDepths(): Promise<PoolDepth[]>;
  getRecentSyncRuns(limit: number, integrationId?: string): Promise<SyncRunSummary[]>;
  getBridgeDeliveryHistogram(windowHours: number): Promise<StatusHistogram>;
  getRecentFailedJobs(limit: number): Promise<JobRunFailure[]>;
  getCursors(): Promise<CursorSnapshot[]>;
}
```

The subsystem owns **no tables**. It's a read-only query facade over state
that other subsystems (jobs, bridge, events, sync) already persist:
`job_run`, `bridge_delivery`, `domain_events`, `sync_runs`, `sync_subscriptions`.

**Build-first-extract-later trigger:** two concrete consumers in dealbrain
(`BridgeMetricsReporter` sampler and `StackStatusService` `/dev/status`
endpoint) ran the same ad-hoc SQL over framework tables. That's the
extraction trigger — #195.

**Drizzle backend** implements the five methods via SQL. Enrichment columns
on sync runs (integration/adapter/domain) come from a join against
`sync_subscriptions`, which owns those labels. The histogram windows on
`COALESCE(delivered_at, attempted_at)` so terminal skipped/failed rows are
counted alongside delivered.

**Memory backend** is a fixture holder with `seed*` methods — tests stage
slices and the protocol reads return them verbatim. No replay simulation.

**Reporters** (`reporters/`) are orthogonal to backends. `BridgeMetricsReporter`
is the first: a 60s interval sampler that logs per-window
`(status × eventType × skipReason)` aggregates. Opt in via
`ObservabilityModule.forRoot({ ..., reporters: { bridgeMetrics: true } })`.
Gated so consumers without the bridge subsystem don't pay the
`@nestjs/schedule` + bridge-schema import tax.

**Extensions** (per CLAUDE.md "core/extensions"): Drizzle-specific
capabilities that don't belong on the core interface — `pg_stat_activity`
sampling, advisory-lock inspection, `LISTEN/NOTIFY` tie-ins — live as
methods on the drizzle backend class. Consumers opting in accept
backend-specific coupling. A future OTel exporter backend would likewise
expose span-export extensions without lifting them into the core
protocol.

**No lifecycle hooks on the backends themselves.** The drizzle backend
runs on-demand queries; the memory backend is state-only. Reporters may
have their own `OnModuleInit`/`OnModuleDestroy` (e.g. timer setup), but
those are per-reporter concerns.

### Lifecycle Management

All Drizzle backends that require background processing implement NestJS lifecycle hooks:

```typescript
@Injectable()
export class DrizzleEventBus implements IEventBus, OnModuleInit, OnModuleDestroy {
  private polling = false;

  async onModuleInit(): Promise<void> {
    this.polling = true;
    this.startPolling();    // begin processing unhandled events
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;   // stop polling loop gracefully
  }
}
```

This applies to:
- **Events Drizzle backend** — polling loop for unprocessed events
- **Jobs Drizzle backend** — polling loop for claimable jobs
- **Cache Drizzle backend** — periodic cleanup of expired entries (if jobs subsystem unavailable)

Memory backends do not need lifecycle hooks — they process synchronously.

### Error Handling

Protocol methods throw on failure — they do not swallow errors. Retry logic lives in the backend implementation, not the caller.

- **EventBus.publish()** — if the transaction commits, the event is persisted. Processing failures are retried by the polling loop with backoff. After max retries, events are marked as `failed` (not lost).
- **JobQueue.enqueue()** — always succeeds if the database is reachable (it's just an INSERT). Processing failures trigger retry per `JobOptions`. After `maxRetries`, job status becomes `failed`.
- **CacheService.get()** — returns `null` on any error (cache miss behavior). Cache should never cause request failures.
- **StorageService** — throws on all failures. Callers must handle `upload`/`download` errors explicitly.

### The Factory Module Pattern

Every subsystem uses `DynamicModule.forRoot()` with `global: true`:

```typescript
@Module({})
export class EventsModule {
  static forRoot(
    options: { backend: 'drizzle' | 'memory' } = { backend: 'drizzle' },
  ): DynamicModule {
    const provider =
      options.backend === 'drizzle'
        ? { provide: EVENT_BUS, useClass: DrizzleEventBus }
        : { provide: EVENT_BUS, useClass: MemoryEventBus };

    return {
      module: EventsModule,
      global: true,
      providers: [provider],
      exports: [EVENT_BUS],
    };
  }
}
```

`global: true` means entity modules don't need to import subsystem modules individually — they're available project-wide once registered in `AppModule`. This keeps entity module templates simple.

```typescript
// app.module.ts (hand-written, one-time setup)
@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    JobsModule.forRoot({ backend: 'drizzle' }),
    CacheModule.forRoot({ backend: 'drizzle', defaultTtl: 300 }),
    StorageModule.forRoot({ backend: 'local' }),
    // Codegen entity modules
    ContactsModule,
    OpportunitiesModule,
  ],
})
export class AppModule {}
```

Tests swap backends:
```typescript
Test.createTestingModule({
  imports: [
    EventsModule.forRoot({ backend: 'memory' }),
    JobsModule.forRoot({ backend: 'memory' }),
    // ...
  ],
});
```

### Subsystem Dependencies

```
Events:       standalone
Jobs:         standalone
Cache:        optional dependency on Jobs (for cleanup scheduling)
Storage:      standalone
Integrations: depends on Events (for sync tracking)
```

When the cache subsystem detects that the jobs subsystem is available (via optional injection), it registers a periodic cleanup job. Otherwise it falls back to `setInterval`.

### Why Drizzle Backends (Not Redis/BullMQ)

The default backend for events, jobs, and cache is **Postgres via Drizzle**, not Redis or BullMQ. Rationale:

1. **Zero new dependencies.** The project already has Postgres and Drizzle. Adding Redis requires a new service in Docker, new connection management, new failure modes.
2. **Postgres is sufficient at startup.** Domain events via outbox table, jobs via pg-boss pattern, cache via table with TTL — all work until you're processing thousands of events/second. Most projects never reach that threshold.
3. **The protocol is the escape hatch.** When Postgres becomes a bottleneck, implement `IEventBus` with Redis Streams, `IJobQueue` with BullMQ, `ICacheService` with Redis. The app code doesn't change — only the `forRoot()` call.
4. **Drizzle backends are testable with the existing scaffold.** The integration test harness already has Docker Postgres. No additional infrastructure needed.

### Entity-Level Event Generation

The `events:` block in entity YAML is already parsed by `prompt.js` (producing `processedEvents` with class names, payloads, and handler flags). This ADR proposes adding templates that generate typed event classes from that parsed data.

```yaml
# contact.yaml
events:
  - name: contact_created
    queue: domain-events
    body:
      contact_id: uuid
      account_id: uuid
      created_by: uuid
    generate_handler: true
```

Generates:
```typescript
// modules/contacts/events/contact-created.event.ts
import { randomUUID } from 'crypto';
import type { DomainEvent } from '@shared/subsystems/events';

export class ContactCreatedEvent implements DomainEvent {
  readonly id = randomUUID();
  readonly type = 'contact_created' as const;
  readonly aggregateType = 'contact' as const;
  readonly occurredAt: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: {
      contactId: string;
      accountId: string;
      createdBy: string;
    },
    occurredAt?: Date,
  ) {
    this.occurredAt = occurredAt ?? new Date();
  }

  /** Rehydrate from stored event (e.g., when replaying from domain_events table). */
  static fromRecord(record: DomainEvent): ContactCreatedEvent {
    return new ContactCreatedEvent(
      record.aggregateId,
      record.payload as ContactCreatedEvent['payload'],
      record.occurredAt,
    );
  }
}
```

And when `generate_handler: true`:
```typescript
// modules/contacts/events/contact-created.handler.ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EVENT_BUS, type IEventBus, type DomainEvent } from '@shared/subsystems/events';
import { ContactCreatedEvent } from './contact-created.event';

@Injectable()
export class ContactCreatedHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: IEventBus,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe<ContactCreatedEvent>(
      'contact_created',
      this.handle.bind(this),
    );
  }

  async handle(event: ContactCreatedEvent): Promise<void> {
    // TODO: implement handler logic
  }
}
```

Entity modules auto-register handlers in their `providers` array when `events:` block is present. **Prerequisite:** The events subsystem must be scaffolded before entity event generation works. `bun codegen entity` should warn if `subsystems/events/` does not exist and the entity has an `events:` block.

### Integration Ports (Hexagonal Adapters)

Integration ports are **per-entity**, generated from the `sync:` block in entity YAML. The `sync:` block is already parsed by `prompt.js` (producing `syncProviders` with field mappings). This ADR proposes adding templates that generate port interfaces and field mappers from that parsed data.

```yaml
# contact.yaml
sync:
  providers:
    salesforce:
      remote_entity: Contact
      direction: bidirectional
      field_mapping:
        first_name: FirstName
        last_name: LastName
        email: Email
```

Generates:
```typescript
// modules/contacts/ports/contact-sync.port.ts
export interface IContactSyncPort {
  pull(since?: Date): Promise<ExternalContact[]>;
  push(contact: Contact): Promise<void>;
}

export interface ExternalContact {
  externalId: string;
  FirstName: string;   // remote field names from field_mapping values
  LastName: string;
  Email: string;
}

export const CONTACT_SYNC_PORT = Symbol('CONTACT_SYNC_PORT');
```

And a field mapper:
```typescript
// modules/contacts/ports/contact-field-mapper.ts
export function mapFromExternal(external: ExternalContact): Partial<Contact> {
  return {
    firstName: external.FirstName,
    lastName: external.LastName,
    email: external.Email,
  };
}

export function mapToExternal(contact: Contact): Partial<ExternalContact> {
  return {
    FirstName: contact.firstName,
    LastName: contact.lastName,
    Email: contact.email,
  };
}
```

The adapter implementation (e.g., `SalesforceContactAdapter implements IContactSyncPort`) is **hand-written** — it contains API-specific logic (auth, pagination, rate limiting) that cannot be generated.

A **provider registry** manages adapter selection:
```typescript
// subsystems/integrations/provider-registry.ts
@Injectable()
export class ProviderRegistry {
  private adapters = new Map<string, Map<string, unknown>>();

  register<T>(entity: string, provider: string, adapter: T): void { ... }
  get<T>(entity: string, provider: string): T { ... }
  getAll(entity: string): Map<string, unknown> { ... }
}
```

The provider registry is a one-time scaffold (like events/jobs), while the ports and field mappers are per-entity.

### Subsystem vs Integration — When to Use What

| Need | Subsystem or Port? | Why |
|------|-------------------|-----|
| Publish domain events | Subsystem (EventBus) | Global infrastructure, protocol-agnostic |
| Enqueue background job | Subsystem (JobQueue) | Global infrastructure |
| Cache a read | Subsystem (CacheService) | Global infrastructure |
| Store a file | Subsystem (StorageService) | Global infrastructure |
| Sync entity to Salesforce | Port (ISyncPort) | Per-entity, per-provider, entity-specific field mapping |
| Receive webhook from Stripe | Port (IWebhookPort) | Per-provider inbound adapter |
| Call an LLM | Port (ILLMPort) | External system, provider-swappable |

### Generation Commands

These commands do not exist yet — they are part of what this ADR proposes to build:

```bash
# One-time infrastructure scaffolds (new CLI commands)
bun codegen subsystem events
bun codegen subsystem jobs
bun codegen subsystem cache
bun codegen subsystem storage
bun codegen subsystem integrations   # provider registry + base types

# Per-entity (existing command, extended with new template outputs)
bun codegen entity entities/contact.yaml
# → generates event classes from events: block (NEW)
# → generates sync port + field mapper from sync: block (NEW)
```

### Broadcast Subsystem

The existing broadcast subsystem (`templates/broadcast/`) predates this ADR. It demonstrates the protocol/backend concept but uses a plain `@Module` with hardcoded backend selection rather than `DynamicModule.forRoot()`. It should be refactored to follow the standard factory pattern when the subsystem templates are built. Until then, it continues to work as-is.

## Consequences

### Positive

- **Near-complete generated application.** After running codegen, a project has working infrastructure for events, jobs, cache, and storage with zero hand-written plumbing. The only hand-written code is write use cases (business workflows) and integration adapter implementations.
- **ADR-003 becomes enforceable.** Use cases inject `EVENT_BUS` and `JOB_QUEUE` — these imports can be lint-checked. Services cannot import subsystem tokens (exception: `CACHE` for reads only). The sharp test is mechanically enforced.
- **Test story is clean.** Swap to memory backends in tests. No Docker, no external services. The memory backends are generated alongside the Drizzle backends.
- **Postgres-first simplicity.** New projects start with zero infrastructure beyond Postgres. Events, jobs, and cache all work out of the box. Scale-out to Redis/BullMQ is a single `forRoot()` change.
- **Integration ports are mechanical.** Field mapping from YAML eliminates the most error-prone part of building integrations. The port interface and mapper are generated; the user only writes API-specific adapter logic.
- **Transactional event publishing.** The outbox pattern ensures events are atomically persisted with domain writes. No lost events from process crashes.

### Negative

- **Postgres-as-job-queue has limits.** The pg-boss pattern works well up to moderate throughput. High-volume job processing needs BullMQ/Redis. The protocol pattern makes this swap clean, but teams must recognize when to make it.
- **Postgres-as-event-bus is not pub/sub.** The outbox pattern provides persistence and ordering but not real-time fan-out. For real-time needs, the Drizzle backend should be swapped for Redis Streams or similar.
- **More generated files.** Each subsystem adds 6-7 files. Four subsystems = ~25 files of infrastructure. This is boilerplate the user would otherwise write by hand, but it's visible in the tree.
- **DynamicModule pattern has NestJS learning curve.** `forRoot()` with `global: true` is idiomatic NestJS but not obvious to newcomers. Generated code includes comments explaining the pattern.
- **Ordering not guaranteed across aggregates.** Events for the same aggregate are ordered (insertion order in the outbox). Events across aggregates may be processed out of order depending on polling concurrency. This is acceptable for domain events but should be documented.

### Neutral

- Integration adapters remain hand-written. This is intentional — API auth, pagination, rate limiting, and error handling are provider-specific and cannot be meaningfully generated.
- Subsystem tables (`domain_events`, `job_queue`, `cache_entries`) are managed by the same migration tooling as entity tables. No separate migration path.

## Alternatives Considered

### Alternative 1 — Redis/BullMQ as default backends

Use Redis for events and cache, BullMQ for jobs. These are the "production-grade" defaults.

**Rejected because:** Every project would need Redis from day one. For a project that starts with 3 entities and 5 API endpoints, requiring Redis alongside Postgres is unnecessary infrastructure cost. Postgres handles the load until it demonstrably can't. The protocol pattern makes swapping trivial.

### Alternative 2 — Generate protocols only, no backends

Generate interfaces and tokens. Users implement all backends.

**Rejected because:** The value of codegen is eliminating boilerplate. Generating only interfaces forces users to write 400+ lines of infrastructure code that is identical across every project. The Drizzle backend IS the boilerplate — it should be generated.

### Alternative 3 — Use NestJS ecosystem packages (@nestjs/bull, @nestjs/cache-manager)

Integrate with existing NestJS packages instead of generating custom subsystems.

**Rejected because:** These packages impose their own abstractions and configuration. They don't follow the hexagonal port pattern. Swapping from `@nestjs/bull` to a custom implementation requires changing application code. Our protocol-first approach keeps the application code stable regardless of backend choice.

### Alternative 4 — Single ADR per subsystem

Write separate ADRs for events, jobs, cache, storage, and integrations.

**Rejected because:** They all follow the same Pattern → Backend → Factory architecture. The per-subsystem differences are in the protocol interface and backend implementation, not in the architectural pattern. One ADR for the pattern, with per-subsystem protocol definitions, is more maintainable.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-003 — Service vs use case boundary rules](./ADR-003-service-vs-use-case-boundary.md)
- [ADR-005 — Entity-family base class inheritance tree](./ADR-005-entity-family-base-classes.md)
- [Transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [pg-boss — Postgres job queue](https://github.com/timgit/pg-boss)
