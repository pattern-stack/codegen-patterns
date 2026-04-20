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
| `src/generators/event-codegen.ts` (or similar path) | new | Generator class/function |
| `runtime/subsystems/events/generated/types.ts` | generated | AppDomainEvent + interfaces |
| `runtime/subsystems/events/generated/schemas.ts` | generated | Zod schemas |
| `runtime/subsystems/events/generated/registry.ts` | generated | eventRegistry + EventMetadata |
| `runtime/subsystems/events/generated/bus.ts` | generated | TypedEventBus class |
| `runtime/subsystems/events/generated/index.ts` | generated | Re-exports |

The generator is wired into the existing CLI/pipeline (exact wiring TBD by implementing agent — follow the pattern used for entity code generation).

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
import type { EventTypeName, PayloadOfType } from './types';

@Injectable()
export class TypedEventBus {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  async publish<T extends EventTypeName>(
    type: T,
    aggregateId: string,
    payload: PayloadOfType<T>,
    opts?: { tx?: DrizzleTransaction; metadata?: Record<string, unknown> },
  ): Promise<void> { ... }

  subscribe<T extends EventTypeName>(
    type: T,
    handler: (event: EventOfType<T>) => Promise<void>,
  ): () => void { ... }
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

- [ ] `runtime/subsystems/events/generated/` exists and contains all five files after `just gen-all` on a project with `events/*.yaml` files.
- [ ] `AppDomainEvent` union contains exactly one member per declared event YAML.
- [ ] Each interface has correctly camelCased payload fields matching the YAML snake_case definitions.
- [ ] Zod schemas use `z.string().uuid()` for `uuid` fields, `z.coerce.date()` for `date`, etc.
- [ ] `eventRegistry['contact_created'].direction === 'change'` and `.pool === 'events_change'`.
- [ ] `TypedEventBus.publish<'contact_created'>()` compiles; wrong payload type → TS compile error.
- [ ] `TypedEventBus.subscribe<'contact_created'>()` — handler param is `ContactCreatedEvent`, not `DomainEvent`.
- [ ] All generated files carry `// Generated. Do not edit.` header.
- [ ] Empty project (no `events/*.yaml`) produces stub files; no TS errors.
- [ ] Baseline snapshot test updated; `just test-baseline` passes.

## Testing Strategy

- Snapshot test: run generator against fixture event YAMLs; compare output to committed snapshots.
- TypeScript compile test: the generated files for the fixture set compile without errors.
- Unit test: `generateTypes()` with a known set of definitions produces the expected union (string comparison or AST check).

## Open Questions

- EVT-Q2 (generated file location) must be resolved before implementation. Proposed: `runtime/subsystems/events/generated/`.
- EVT-Q5 (payload validation) affects the `generateBus()` step: whether to always call `.parse()`, call `.safeParse()` with logging, or gate on env flag.
- EVT-Q6 (TypedEventBus replaces EVENT_BUS in generated code) must be resolved to know if this file also needs to export `TYPED_EVENT_BUS` token.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Generated artifacts"
- `docs/specs/events-codegen-plan.md` §2 — original artifact designs (superseded by ADR-024)
- `docs/specs/JOB-7.md` — `ScopeEntityType` generator as a simpler analog
- `runtime/subsystems/events/event-bus.protocol.ts` — `DomainEvent` shape imported by generated types
