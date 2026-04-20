# ADR-024 — Events Domain Formalization

**Status:** Draft
**Date:** 2026-04-20
**Owner:** Doug
**Related:** ADR-008 (Subsystem Architecture), ADR-022 (Job Orchestration), ADR-023 (Event-to-Job Bridge, blocked on this ADR)
**Unblocks:** ADR-023 (Event-to-Job Bridge), ADR-026 (JobEvent Observability)

## Context

The existing events subsystem (`runtime/subsystems/events/`) ships:

- `IEventBus` — three-method narrow port (`publish`, `publishMany`, `subscribe`)
- `DomainEvent` — untyped (`type: string`, `payload: Record<string, unknown>`)
- `DrizzleEventBus` — transactional outbox polling loop, no pool or direction awareness
- `MemoryEventBus` / `RedisEventBus` — alternate backends
- `domain_events` Drizzle table — no `pool`, `direction`, or `tenant_id` columns
- `EventsModule.forRoot({ backend })` — `global: true`, ADR-008 factory pattern

What is missing, and is the job of this ADR:

1. **No typed event registry.** Events are referenced by free-string `type`. No `AppDomainEvent` discriminated union, no compile-time validation of publish/subscribe calls, no Zod schemas at the boundary.
2. **No `direction` concept.** The three reserved job pools (`events_inbound`, `events_change`, `events_outbound`) exist in the jobs subsystem (ADR-022) to isolate event drain lanes. But `domain_events` has no `pool` or `direction` column, so the drain loop cannot filter by pool — all events drain through one lane today.
3. **No first-class inbound/outbound event declaration.** Entity-YAML `events:` blocks cover CRUD change events, but inbound webhooks and outbound publishes are not entity-owned and have no home. `lifecycle-events.ts` emits untyped strings.
4. **No `TypedEventBus` facade.** Application code constructs raw `DomainEvent` objects with manual `metadata` population. No stamping of `pool` or `direction` at publish time.
5. **No typed event-codegen pipeline.** The `events-codegen-plan.md` (2026-04-17) is a draft plan with 8 open questions. None of its artifacts (`events/*.yaml` parser, generated types, registry, facade) are implemented.
6. **Bridge dependency blocked.** ADR-023 (Event-to-Job Bridge) requires a typed event registry to validate trigger references and extract scope from payloads. This ADR ships that registry.

## Decision

### Architecture spine

```
events/*.yaml (per-event declarations)
        │
        ▼
Event YAML parser (src/parser/load-events.ts)
        │
        ▼
Code generator → runtime/subsystems/events/generated/
    types.ts       AppDomainEvent discriminated union, EventOfType<T>, PayloadOfType<T>
    schemas.ts     Zod payload schemas, eventPayloadSchemas map
    registry.ts    eventRegistry keyed by type, EventMetadata shape
    bus.ts         TypedEventBus injectable facade (typed publish<T>, subscribe<T>)
    index.ts       Re-export surface
        │
        ▼
IEventBus (protocol, unchanged — stays narrow)
DrizzleEventBus (upgraded: pool/direction columns populated at insert, pool-filtered drain)
MemoryEventBus  (upgraded: pool-aware for test assertions)
```

`IEventBus` remains the hexagonal port — three methods, untyped. It does not know about the generated registry. That would introduce circular coupling (generated types depend on the bus; bus depending on generated types would mean the bus cannot be instantiated before codegen runs). The typed facade (`TypedEventBus`) wraps `IEventBus` and carries the typed generics. Application code uses `TypedEventBus`; libraries and non-generated code use `IEventBus`.

### Event YAML shape (`events/*.yaml`)

One file per event type, living alongside `entities/` and `jobs/`:

```
events/
  contact_created.yaml
  stripe_payment_received.yaml
  webhook_outbound_contact_sync.yaml
```

Fields:
- `type` — unique snake_case key, matches filename
- `direction` — `inbound | change | outbound`; drives default pool
- `aggregate` — entity name (required for `direction: change`, optional elsewhere)
- `source` — inbound origin (`"stripe"`, `"email"`)
- `destination` — outbound target (`"crm"`, `"slack"`)
- `payload` — `Record<snake_case, { type, nullable?, description? }>`; snake_case keys → camelCase TS properties
- `pool` — optional override; must be a reserved pool of the same category
- `retry` — `{ attempts, backoff }` metadata surfaced to the drain loop
- `version` — integer, default 1
- `description` — optional free text

Direction → default pool derivation:

| direction  | default pool       |
|------------|--------------------|
| `inbound`  | `events_inbound`   |
| `change`   | `events_change`    |
| `outbound` | `events_outbound`  |

### Generated artifacts (`runtime/subsystems/events/generated/`)

Following the convention established by JOB-7 (Q5 resolution), generated subsystem types live in `runtime/subsystems/<name>/generated/`. Five files:

- **`types.ts`** — per-event interfaces extending `DomainEvent`, `AppDomainEvent` discriminated union, `EventTypeName`, `EventOfType<T>`, `PayloadOfType<T>`.
- **`schemas.ts`** — Zod payload schema per event, `eventPayloadSchemas` map keyed by `EventTypeName`.
- **`registry.ts`** — `EventMetadata` interface, `eventRegistry` constant, `getEventMetadata<T>()`.
- **`bus.ts`** — `TypedEventBus` injectable class with typed `publish<T>()` and `subscribe<T>()`.
- **`index.ts`** — re-export surface.

These files are generated by the codegen pipeline from `events/*.yaml`. They are not hand-edited.

### `domain_events` schema upgrade

Two new first-class columns (Phase A, EVT-1):

- `pool text` (nullable, indexed) — populated at insert from `metadata.pool`. Enables pool-filtered drain queries without JSON unpacking.
- `direction text` (nullable, indexed) — populated at insert from `metadata.direction`.
- `tenant_id text` (nullable) — conditionally emitted per scaffold-time `events.multi_tenant: true` flag. Follows the JOB-1/JOB-8 convention: column omitted from schema when flag is false; enabling tenancy requires a reinstall and Atlas migration.

New index: `(pool, status, occurred_at)` for per-pool drain.

### Drizzle backend upgrade

`DrizzleEventBus.publish(event, tx?)` reads `metadata.pool` and `metadata.direction` and writes them to the explicit columns alongside `metadata`. No protocol change — the information is already passed via metadata; the backend just extracts it.

`DrizzleEventBus.processBatch()` gains an optional `pools?: string[]` filter:

```sql
SELECT * FROM domain_events
WHERE status = 'pending'
  AND (pool = ANY($pools) OR $pools IS NULL)
ORDER BY occurred_at ASC
LIMIT $batchSize
FOR UPDATE SKIP LOCKED
```

`EventsModule.forRoot()` gains optional `pools?: string[]` to restrict which pool lanes a given process drains.

### TypedEventBus facade

```ts
@Injectable()
export class TypedEventBus {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  async publish<T extends EventTypeName>(
    type: T,
    aggregateId: string,
    payload: PayloadOfType<T>,
    opts?: { tx?: DrizzleTransaction; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const meta = getEventMetadata(type);
    // Boundary validation (configurable via CODEGEN_EVENT_VALIDATE env flag)
    eventPayloadSchemas[type].parse(payload);
    await this.bus.publish({
      id: randomUUID(),
      type,
      aggregateId,
      aggregateType: meta.aggregate ?? meta.source ?? meta.destination ?? type,
      payload: payload as Record<string, unknown>,
      occurredAt: new Date(),
      metadata: { ...opts?.metadata, pool: meta.pool, direction: meta.direction, version: meta.version },
    }, opts?.tx);
  }

  subscribe<T extends EventTypeName>(
    type: T,
    handler: (event: EventOfType<T>) => Promise<void>,
  ): () => void {
    return this.bus.subscribe<EventOfType<T>>(type, handler);
  }
}
```

Key properties:
- `publish<T>()` typed: wrong `type` → compile error; wrong `payload` shape → compile error.
- Every publish stamps `metadata.pool` and `metadata.direction` from the registry.
- The bus protocol is unchanged; `TypedEventBus` is a pure wrapping layer.

### Entity `emits:` block

Phase C (EVT-7). Entities declare which change events they emit:

```yaml
# entities/contact.yaml
emits:
  - contact_created
  - contact_updated
  - contact_deleted
```

- If declared: each entry must resolve to `events/<type>.yaml` with `direction: change` and `aggregate: <entity_name>`. Missing → codegen hard error.
- If absent: untyped `lifecycle-events.ts` fallback, codegen warning.

Generated use-cases call `TypedEventBus.publish()` explicitly inside the transaction.

### Entity `events:` block desugaring

The existing entity `events:` block remains valid. At parse time the generator desugars each entry into the equivalent `events/<name>.yaml` file with `direction: change` and `aggregate: <entity>`. This means both declarations produce the same `eventRegistry` entry. The per-entity event *class* generation (the current template output) is replaced by the `src/generated/events/types.ts` union approach.

### No subscriber registry table

Unlike the `job` table (which materializes `@JobHandler` metadata at boot), there is no `event_subscriber` table. Reasons:

1. Events are broadcast — many subscribers per type, zero is valid (events accumulate until drained; no one needs to handle them).
2. The `eventRegistry` (generated from YAML) is the compile-time registry. No runtime upsert adds value.
3. Boot-time "every declared event has at least one subscriber" validation is not warranted — there are common patterns (event sourcing, audit logs) where events are declared but only a drain consumer reads the outbox directly.

### Multi-tenancy

Opt-in via `codegen.config.yaml: events.multi_tenant: true`. When enabled:
- `tenant_id` column appears on `domain_events`.
- `DrizzleEventBus.publish()` accepts and writes `tenantId` from event metadata.
- The drain loop filters by `tenantId` when the module is configured for it.

When disabled: column is omitted from schema, no `tenantId` parameter anywhere.

### Stale-event recovery

No dedicated sweeper. The polling loop's `FOR UPDATE SKIP LOCKED` within a transaction means: if the poll process crashes between dispatch and `status='processed'` update, the row remains `status='pending'` and is re-polled on the next cycle. The existing `MAX_RETRIES=3 → status='failed'` logic handles permanent handler failures. This is self-healing without a separate sweeper — unlike jobs' `claimed_at` pattern, there is no claimed-but-uncommitted state to recover.

### Versioning

`version` field exists on event YAML but schema-evolution coexistence (v1/v2 types in the same registry) is deferred. The field costs nothing; when versioning is needed it is the evolution hook.

## Phase roadmap

### Phase 1 — Events formalization (this ADR, EVT-1..EVT-8)

- `domain_events` schema upgrade (pool, direction, tenant_id columns + indexes)
- Event YAML parser + Zod schema (`EventDefinitionSchema`)
- Generated artifacts in `runtime/subsystems/events/generated/` (types, schemas, registry, TypedEventBus)
- Drizzle backend upgrade (pool columns at insert, pool-filtered drain)
- Memory backend upgrade (pool-aware assertions)
- `EventsModule.forRoot()` upgrade (TypedEventBus provider, multi-tenancy option)
- Entity `emits:` support + use-case template updates (Phase C)
- Scaffold templates + Atlas migration docs

### Phase 2 — Event-to-Job Bridge (ADR-023)

Reads `eventRegistry` to validate trigger references, extract typed scope from payloads, auto-assign pools. Blocked until EVT-3 (registry) is shipped.

### Phase 3 — Selective JobEvent broadcast (Phase B)

`job_event` entries selectively fanned to `IEventBus`. Blocked on ADR-026 (JobEvent observability).

## Resolved questions (EVT planning, 2026-04-20)

To be filled in after team-lead resolves with user. Stubs for the issues this ADR raises:

- **EVT-Q1** — `tenant_id` conditional emit mechanism (scaffold-time vs. runtime flag)
- **EVT-Q2** — Generated file location (`runtime/subsystems/events/generated/` vs. `src/generated/events/`)
- **EVT-Q3** — Top-level `events/*.yaml` vs. entity `events:` block — keep both with desugar?
- **EVT-Q4** — `emits:` required, optional with warning, or silent?
- **EVT-Q5** — Payload validation: dev-only, always-on, configurable?
- **EVT-Q6** — `TypedEventBus` replace `@Inject(EVENT_BUS)` in generated code?
- **EVT-Q7** — Pool inheritance for event-triggered jobs (`batch` default vs. source pool)?
- **EVT-Q8** — Versioning: defer?

## Consequences

**Positive:**
- Events become first-class declared entities: typed, routable, registerable. The app can answer "what events do we emit?" at codegen time.
- Lane isolation between inbound/change/outbound event drain becomes enforceable — `domain_events.pool` is indexed; the drain loop filters.
- `TypedEventBus.publish<'contact_created'>()` catches misspelled type names and wrong payload shapes at compile time.
- ADR-023 (bridge) unblocked.
- `events-codegen-plan.md` (the current plan draft) is superseded by this ADR. The plan becomes implementation input, not the authoritative design doc.

**Negative:**
- Every `events/*.yaml` file must be regenerated when a consumer adds a new event type. This is a new step in the developer workflow.
- The `TypedEventBus` class is generated code — consumers cannot hand-edit it. The correct response to wanting a custom publish behavior is an extension on the generated facade, not editing the file.
- Entity `emits:` validation introduces a new required connection between entity YAML and event YAML. Missing cross-reference → hard codegen error.

**Operating principle:** No backwards-compatibility until external users exist. `lifecycle-events.ts` untyped emission path is deprecated on install when `emits:` is declared. Replace cleanly.

## References

- ADR-008 (Subsystem Architecture) — Protocol → Backend → Factory pattern
- ADR-022 (Job Orchestration) — the three reserved `events_*` pools; JOB-7 Q5 resolution for generated file location
- `docs/specs/events-codegen-plan.md` — the pre-ADR design plan (superseded by this ADR once resolved questions are filled in)
- `runtime/subsystems/events/` — current runtime files
- `docs/specs/EVT-phase-1-issues.md` — issue breakdown for Phase 1
