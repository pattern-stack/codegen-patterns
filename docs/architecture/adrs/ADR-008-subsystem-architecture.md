# ADR-008 — Subsystem Architecture: Protocol → Backend → Factory

**Status:** Draft
**Date:** 2026-04-12
**Owner:** Doug
**Related:** ADR-001, ADR-003, ADR-005
**Unblocks:** #15 (A11), #16 (A12)

## Context

ADR-003 establishes the sharp test: if an operation produces side effects outside the database, it belongs in a use case. Use cases may emit events, enqueue jobs, call external systems, and manage cache/storage. But the infrastructure that receives those calls — the event bus, job queue, cache service, storage service, and integration adapters — does not exist yet.

Without generated subsystem infrastructure, every team building on codegen-patterns must:
1. Hand-write an event bus interface and implementation
2. Hand-write a job queue interface and implementation  
3. Wire up NestJS modules for each subsystem
4. Write memory-backed test doubles for each
5. Build their own provider registry for external integrations

This is 500+ lines of infrastructure boilerplate per project, identical in shape every time. It should be generated.

The broadcast subsystem (`templates/broadcast/`) already demonstrates the pattern: a protocol interface, pluggable backends (memory, WebSocket), and a NestJS module. This ADR generalizes that pattern to all infrastructure subsystems.

## Decision

### The Pattern: Protocol → Backend → Factory

Every infrastructure subsystem follows one pattern:

```
Protocol (interface)    → What the app calls
Backend (class)         → How the call is fulfilled
Factory (DynamicModule) → Which backend is selected at boot
```

The protocol is the **port** (hexagonal architecture). Backends are **adapters**. The factory is NestJS `DynamicModule.forRoot()` wiring. Use cases inject the protocol via token; they never know which backend is active.

### Infrastructure Subsystems

Four infrastructure subsystems are generated as one-time scaffolds:

#### Events

```
subsystems/events/
├── event-bus.protocol.ts           # IEventBus
├── event-bus.drizzle-backend.ts    # Postgres: domain_events table
├── event-bus.memory-backend.ts     # In-memory: array + callbacks
├── domain-events.schema.ts         # Drizzle table definition
├── events.module.ts                # EventsModule.forRoot({ backend })
├── events.tokens.ts                # EVENT_BUS token
└── index.ts
```

**Protocol:**
```typescript
export interface DomainEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface IEventBus {
  publish(event: DomainEvent): Promise<void>;
  publishMany(events: DomainEvent[]): Promise<void>;
  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void;
}
```

**Drizzle backend** inserts to a `domain_events` table with columns: `id`, `type`, `payload` (jsonb), `occurredAt`, `processedAt`, `metadata` (jsonb). Subscription uses polling or pg_notify (configurable). The table acts as an outbox — events are persisted atomically with the write operation, then processed asynchronously.

**Memory backend** stores events in an array and dispatches to registered callbacks synchronously. Used in tests to assert event publication without database.

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
  retries?: number;         // max retry count
  backoff?: number;         // ms between retries
  priority?: number;        // higher = sooner
}

export interface IJobQueue {
  enqueue<T = unknown>(type: string, payload: T, options?: JobOptions): Promise<string>;
  process(type: string, handler: (payload: unknown) => Promise<void>): void;
  schedule(type: string, cron: string, payload?: unknown): Promise<string>;
  cancel(jobId: string): Promise<void>;
}
```

**Drizzle backend** follows the pg-boss pattern: a `job_queue` table with `id`, `type`, `payload` (jsonb), `status` (pending/active/completed/failed), `runAt`, `attempts`, `maxRetries`, `lastError`, `createdAt`, `completedAt`. A polling loop claims jobs with `UPDATE ... SET status = 'active' WHERE status = 'pending' AND runAt <= now() ... LIMIT 1 RETURNING *`. Advisory locks prevent double-processing.

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
  invalidate(pattern: string): Promise<number>;  // returns count deleted
  has(key: string): Promise<boolean>;
}
```

**Drizzle backend** uses a `cache_entries` table with `key` (primary), `value` (jsonb), `expiresAt` (timestamp). Reads check `expiresAt > now()`. A periodic cleanup job (registered with the jobs subsystem if available, else manual) deletes expired entries.

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

### Why Drizzle Backends (Not Redis/BullMQ)

The default backend for events, jobs, and cache is **Postgres via Drizzle**, not Redis or BullMQ. Rationale:

1. **Zero new dependencies.** The project already has Postgres and Drizzle. Adding Redis requires a new service in Docker, new connection management, new failure modes.
2. **Postgres is sufficient at startup.** Domain events via outbox table, jobs via pg-boss pattern, cache via table with TTL — all work until you're processing thousands of events/second. Most projects never reach that threshold.
3. **The protocol is the escape hatch.** When Postgres becomes a bottleneck, implement `IEventBus` with Redis Streams, `IJobQueue` with BullMQ, `ICacheService` with Redis. The app code doesn't change — only the `forRoot()` call.
4. **Drizzle backends are testable with the existing scaffold.** The integration test harness already has Docker Postgres. No additional infrastructure needed.

### Entity-Level Event Generation

The `events:` block in entity YAML generates typed event classes:

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
export class ContactCreatedEvent implements DomainEvent {
  readonly type = 'contact_created';
  readonly occurredAt = new Date();

  constructor(
    readonly payload: {
      contactId: string;
      accountId: string;
      createdBy: string;
    },
  ) {}
}
```

And when `generate_handler: true`:
```typescript
// modules/contacts/events/contact-created.handler.ts
@Injectable()
export class ContactCreatedHandler {
  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: IEventBus,
  ) {
    this.eventBus.subscribe('contact_created', this.handle.bind(this));
  }

  async handle(event: DomainEvent): Promise<void> {
    // TODO: implement handler logic
  }
}
```

Entity modules auto-register handlers in their `providers` array when `events:` block is present.

### Integration Ports (Hexagonal Adapters)

Integration ports are **per-entity**, generated from the `sync:` block in entity YAML. They follow the hexagonal port/adapter pattern from ADR-001.

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
  private adapters = new Map<string, Map<string, any>>();

  register(entity: string, provider: string, adapter: any): void { ... }
  get<T>(entity: string, provider: string): T { ... }
  getAll(entity: string): Map<string, any> { ... }
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

```bash
# One-time infrastructure scaffolds
bun codegen subsystem events
bun codegen subsystem jobs
bun codegen subsystem cache
bun codegen subsystem storage
bun codegen subsystem integrations   # provider registry + base types

# Per-entity (already exists, extended with events + ports)
bun codegen entity entities/contact.yaml
# → generates event classes from events: block
# → generates sync port + field mapper from sync: block
```

## Consequences

### Positive

- **Near-complete generated application.** After running codegen, a project has working infrastructure for events, jobs, cache, and storage with zero hand-written plumbing. The only hand-written code is write use cases (business workflows) and integration adapter implementations.
- **ADR-003 becomes enforceable.** Use cases inject `EVENT_BUS` and `JOB_QUEUE` — these imports can be lint-checked. Services cannot import subsystem tokens. The sharp test is mechanically enforced.
- **Test story is clean.** Swap to memory backends in tests. No Docker, no external services. The memory backends are generated alongside the Drizzle backends.
- **Postgres-first simplicity.** New projects start with zero infrastructure beyond Postgres. Events, jobs, and cache all work out of the box. Scale-out to Redis/BullMQ is a single `forRoot()` change.
- **Integration ports are mechanical.** Field mapping from YAML eliminates the most error-prone part of building integrations. The port interface and mapper are generated; the user only writes API-specific adapter logic.

### Negative

- **Postgres-as-job-queue has limits.** The pg-boss pattern works well up to moderate throughput. High-volume job processing needs BullMQ/Redis. The protocol pattern makes this swap clean, but teams must recognize when to make it.
- **Postgres-as-event-bus is not pub/sub.** The outbox pattern provides persistence and ordering but not real-time fan-out. For real-time needs, the Drizzle backend should be swapped for Redis Streams or similar.
- **More generated files.** Each subsystem adds 6-7 files. Four subsystems = ~25 files of infrastructure. This is boilerplate the user would otherwise write by hand, but it's visible in the tree.
- **DynamicModule pattern has NestJS learning curve.** `forRoot()` with `global: true` is idiomatic NestJS but not obvious to newcomers. Generated code includes comments explaining the pattern.

### Neutral

- Integration adapters remain hand-written. This is intentional — API auth, pagination, rate limiting, and error handling are provider-specific and cannot be meaningfully generated.
- The broadcast subsystem (`templates/broadcast/`) predates this ADR and follows the same pattern. It may be refactored to use the standard `forRoot()` factory, or left as-is since it already works.
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
