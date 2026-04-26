# EVT-3 — Generated Artifacts: `AppDomainEvent`, `eventRegistry`, `TypedEventBus`

**Issue:** EVT-3
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-2 (parser must produce `EventDefinition[]`).
**Blocks:** EVT-6 (module wires TypedEventBus), EVT-7 (use-case templates import TypedEventBus).

## Overview

Add a code generator step that reads `EventDefinition[]` (from EVT-2) and emits five files into `runtime/subsystems/events/generated/`. The five files are: typed interfaces + discriminated union (`types.ts`), Zod payload schemas (`schemas.ts`), runtime metadata registry (`registry.ts`), `TypedEventBus` injectable facade (`bus.ts`), and re-export surface (`index.ts`). The generator runs as part of the existing `just gen-all` pipeline.

## Context

**What exists.** The codegen pipeline processes entity YAML and emits Hygen templates. There is no event-specific generation step. `src/generated/events/` does not exist.

**What this PR adds.** A generator step parallel to the entity generator. The output path follows the JOB-7 Q5 resolution: `runtime/subsystems/events/generated/` (not `src/generated/events/` as the original plan drafted — see EVT-Q2 resolution).

**Why `TypedEventBus` is generated.** Its `publish<T>()` signature is constrained to the project's `AppDomainEvent`, which is per-project. The class body is mostly boilerplate; only the import of `EventTypeName` and `eventPayloadSchemas` changes per project.

## Architecture

```
EventDefinition[]
  │
  ▼
EventCodeGenerator
  ├── generateTypes()   → types.ts   (interfaces, AppDomainEvent union, utility types)
  ├── generateSchemas() → schemas.ts (Zod per-event, eventPayloadSchemas map)
  ├── generateRegistry()→ registry.ts (eventRegistry const, getEventMetadata)
  ├── generateBus()     → bus.ts     (TypedEventBus class)
  └── generateIndex()   → index.ts   (re-exports)
```

All five files carry `// Generated. Do not edit.` headers and are reproducible from `events/*.yaml`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/shared/event-codegen-generator.ts` | new | Generator: pure `build*Content()` helpers + `generateEventCodegen()` orchestrator. Mirrors JOB-7's `scope-entity-type-generator.ts` layout exactly. |
| `src/__tests__/cli/event-codegen-generator.test.ts` | new | Unit tests for the pure content builders and the `generateEventCodegen` entrypoint. |
| `src/cli/commands/entity.ts` | modify | Wire `generateEventCodegen()` as a post-Hygen step in `EntityNewCommand`, mirroring the JOB-7 `generateScopeEntityType()` hook. |
| `runtime/subsystems/events/events.tokens.ts` | modify | Add `TYPED_EVENT_BUS` injection token (static — not generated). |
| `runtime/subsystems/events/index.ts` | modify | Re-export `TYPED_EVENT_BUS` and `TypedEventBus`. |
| `runtime/subsystems/events/generated/types.ts` | generated | `AppDomainEvent` + per-event interfaces + `EventTypeName` / `EventOfType<T>` / `PayloadOfType<T>`. |
| `runtime/subsystems/events/generated/schemas.ts` | generated | Zod payload schema per event + `eventPayloadSchemas` map. |
| `runtime/subsystems/events/generated/registry.ts` | generated | `EventMetadata` interface + `eventRegistry` const + `getEventMetadata<T>()`. |
| `runtime/subsystems/events/generated/bus.ts` | generated | `TypedEventBus` injectable facade. |
| `runtime/subsystems/events/generated/index.ts` | generated | Re-export barrel. |
| `test/run-test.ts` | modify | Register `runtime/subsystems/events/generated` in `OUTPUT_PATHS`; invoke `generateEventCodegen()` against `test/fixtures/events/` as a post-Hygen step. |

The generator is wired as a post-Hygen step in `EntityNewCommand.execute()`, peer to the JOB-7 `generateScopeEntityType()` call. Every `entity new` / `entity new --all` invocation fully regenerates the event artifacts — matching ADR-017's "full rescan on any entity change" invariant.

## Interfaces

### `types.ts` (generated shape)

```ts
// Generated. Do not edit.
import type { DomainEvent } from '../event-bus.protocol';

export interface ContactCreatedEvent extends DomainEvent {
  readonly type: 'contact_created';
  readonly aggregateType: 'contact';
  readonly payload: {
    contactId: string;
    accountId: string | null;
    createdBy: string;
  };
}
// ... one interface per event YAML

export type AppDomainEvent =
  | ContactCreatedEvent
  | StripePaymentReceivedEvent
  /* ... */;

export type EventTypeName = AppDomainEvent['type'];
export type EventOfType<T extends EventTypeName> = Extract<AppDomainEvent, { type: T }>;
export type PayloadOfType<T extends EventTypeName> = EventOfType<T>['payload'];
```

### `registry.ts` (generated shape)

```ts
export interface EventMetadata {
  type: EventTypeName;
  direction: 'inbound' | 'change' | 'outbound';
  pool: 'events_inbound' | 'events_change' | 'events_outbound';
  aggregate?: string;
  source?: string;
  destination?: string;
  version: number;
  retry: { attempts: number; backoff: 'linear' | 'exponential' };
}

export const eventRegistry: Record<EventTypeName, EventMetadata> = { /* ... */ } as const;
export function getEventMetadata<T extends EventTypeName>(type: T): EventMetadata { ... }
```

### `bus.ts` (generated shape)

```ts
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EVENT_BUS } from '../events.tokens';
import type { IEventBus, DrizzleTransaction } from '../event-bus.protocol';
import { eventPayloadSchemas } from './schemas';
import { getEventMetadata } from './registry';
import type { EventTypeName, EventOfType, PayloadOfType } from './types';

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

    // EVT-Q5: default-on, gated by CODEGEN_EVENT_VALIDATE. Uses safeParse +
    // console.warn so a bad publish doesn't crash a hot path.
    const flag = process.env['CODEGEN_EVENT_VALIDATE'];
    const shouldValidate =
      flag === undefined ? true : flag !== 'false' && flag !== '0';
    if (shouldValidate) {
      const check = eventPayloadSchemas[type].safeParse(payload);
      if (!check.success) {
        console.warn(
          `[TypedEventBus] payload validation failed for ${String(type)}:`,
          check.error.issues,
        );
      }
    }

    // EVT-4 contract: stamp pool/direction/version from registry into metadata
    // so DrizzleEventBus.publish() can populate the explicit columns.
    await this.bus.publish(
      {
        id: randomUUID(),
        type,
        aggregateId,
        aggregateType: meta.aggregate ?? meta.source ?? meta.destination ?? (type as string),
        payload: payload as Record<string, unknown>,
        occurredAt: new Date(),
        metadata: {
          ...(opts?.metadata ?? {}),
          pool: meta.pool,
          direction: meta.direction,
          version: meta.version,
        },
      },
      opts?.tx,
    );
  }

  subscribe<T extends EventTypeName>(
    type: T,
    handler: (event: EventOfType<T>) => Promise<void>,
  ): () => void {
    return this.bus.subscribe<EventOfType<T>>(type, handler as never);
  }
}
```

## Implementation Steps

1. Create `EventCodeGenerator` (class or set of functions) that accepts `EventDefinition[]` and returns file content strings.
2. Implement `generateTypes()`: for each definition, produce a typed interface. Derive TS types from `EventFieldType` (`uuid` → `string`, `date` → `Date`, `json` → `Record<string, unknown>`, etc.). Produce `AppDomainEvent` union at the bottom.
3. Implement `generateSchemas()`: produce one Zod schema per event. Map `EventFieldType` to Zod methods (`uuid` → `z.string().uuid()`, `date` → `z.coerce.date()`, etc.). Produce `eventPayloadSchemas` map.
4. Implement `generateRegistry()`: produce `eventRegistry` const and `getEventMetadata`. Entries come directly from `EventDefinition` fields.
5. Implement `generateBus()`: the class body is largely static; only the imports of `EventTypeName`, `eventPayloadSchemas`, `getEventMetadata`, and the payload validation flag behavior change.
6. Implement `generateIndex()`: re-export everything.
7. Handle empty event set gracefully: emit stub files with empty union (`type AppDomainEvent = never`) and empty registry so consumers compile even before any events are declared.
8. Wire generator into the codegen pipeline (parallel to entity generator or as a post-entity step).
9. Update baseline snapshots; `just test-baseline` passes.

## Acceptance Criteria

- [x] `runtime/subsystems/events/generated/` exists and contains all five files after `just gen-all` on a project with `events/*.yaml` files.
- [x] `AppDomainEvent` union contains exactly one member per declared event YAML (merged with entity `events:` block desugaring; top-level wins on `type` collision).
- [x] Each interface has correctly camelCased payload fields matching the YAML snake_case definitions.
- [x] Zod schemas use `z.string().uuid()` for `uuid` fields, `z.coerce.date()` for `date`, etc.
- [x] `eventRegistry['contact_created'].direction === 'change'` and `.pool === 'events_change'`.
- [x] `TypedEventBus.publish<'contact_created'>()` compiles; wrong payload type → TS compile error.
- [x] `TypedEventBus.subscribe<'contact_created'>()` — handler param is `ContactCreatedEvent`, not `DomainEvent`.
- [x] `TypedEventBus.publish()` stamps `pool`, `direction`, and `version` from the registry into `event.metadata` before delegating to `IEventBus.publish()`. This is the contract EVT-4 reads when populating the explicit `domain_events` columns.
- [x] All generated files carry the `// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.` header (consistent with barrel-generator / scope-entity-type-generator).
- [x] Empty project (no `events/*.yaml`) produces stub files; no TS errors. `EventTypeName = string` in the empty case so downstream code referencing `EventTypeName` (e.g. drain filters) still compiles.
- [x] Baseline snapshot test updated; `just test-baseline` passes.

## Testing Strategy

- Snapshot test: run generator against fixture event YAMLs; compare output to committed snapshots.
- TypeScript compile test: the generated files for the fixture set compile without errors.
- Unit test: `generateTypes()` with a known set of definitions produces the expected union (string comparison or AST check).

## Open Questions

All resolved 2026-04-20 — see `docs/specs/EVT-phase-1-issues.md` §Resolved Questions for the full text.

- **EVT-Q2 (generated file location).** Resolved: `runtime/subsystems/events/generated/`.
- **EVT-Q5 (payload validation).** Resolved: `CODEGEN_EVENT_VALIDATE` env flag, default on, `.safeParse()` + `console.warn` — never throws.
- **EVT-Q6 (`TypedEventBus` replaces `EVENT_BUS` in generated code).** Resolved: generated code uses `TypedEventBus` exclusively; `TYPED_EVENT_BUS` injection token lives in the static `events.tokens.ts` (not generated) since the token is a stable runtime-library symbol and should remain importable even when `generated/` is empty-stubbed.
- **EVT-Q8 (versioning coexistence).** Resolved: deferred. `version` field is captured in the registry; no v1/v2 coexistence logic in Phase 1.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Generated artifacts"
- `docs/specs/events-codegen-plan.md` §2 — original artifact designs (superseded by ADR-024)
- `docs/specs/JOB-7.md` — `ScopeEntityType` generator as a simpler analog
- `runtime/subsystems/events/event-bus.protocol.ts` — `DomainEvent` shape imported by generated types

## Revision — 2026-04-26 (AUDIT-2)

The codegen contract gains **audit-tier validation**. Generator and bridge-generator now surface three hard errors with templated messages (see `ai-docs/specs/issue-242/plan.md` §AUDIT-2):

1. `tier: 'audit'` with a `pool` field — `EventDefinitionSchema` rejects with
   `Event '<type>' is tier:audit; pool MUST be omitted (got '<X>'). Audit events have no pool. See ai-docs/specs/issue-242/plan.md §AUDIT-2.`
2. `tier: 'audit'` with a `direction` field — analogous wording.
3. `@JobHandler('<jobType>')` trigger referencing an audit-tier event — `bridge-registry-generator` raises `AuditEventTriggerError`.

The emitted `registry.ts` interface widens accordingly: every entry has `tier: 'domain' | 'audit'`; `direction` and `pool` are now `... | null` to accommodate audit entries whose registry rows are emitted as `direction: null, pool: null`. Domain entries are unchanged in shape (string literals).

Implementation: `src/cli/shared/event-codegen-generator.ts` (`buildRegistryContent`, `REGISTRY_INTERFACE`), `src/cli/shared/bridge-registry-generator.ts` (`AuditEventTriggerError`, `readEventTiers`, `validateNoAuditTriggers`), `src/schema/event-definition.schema.ts` (refinement messages).
