# EVT-2 — YAML Parser and Zod Schema for `events/*.yaml`

**Issue:** EVT-2
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** Nothing — parallel with EVT-1.
**Blocks:** EVT-3 (generated artifacts), EVT-7 (emits: cross-validation).

## Overview

Add `EventDefinitionSchema` (Zod) and a `loadEvents()` parser that reads all `events/*.yaml` files, validates them, cross-references `change` events against known entity names, and returns a typed `EventDefinition[]`. Also handles entity `events:` block desugaring — inline event declarations from entity YAML are synthesized into `EventDefinition` objects at parse time.

## Context

**What exists.** The entity YAML parser (`src/parser/load-entities.ts`) loads entity definitions and already handles cross-references between entities. Events have no equivalent — event types are currently free strings with no schema or centralized declaration.

**What this PR adds.** A parallel event loader that gives events the same first-class treatment as entities. The `EventDefinitionSchema` is the authoritative contract for what is valid in an `events/*.yaml` file. The loader is consumed by the code generator (EVT-3) and by the `emits:` validator (EVT-7).

## Architecture

```
events/*.yaml files
        │
        ▼
loadEvents(eventsDir, parsedEntities)
  ├── readdir events/*.yaml
  ├── validate each with EventDefinitionSchema
  ├── cross-validate: change events → aggregate must be a known entity name
  ├── derive default pool from direction (inbound→events_inbound, etc.)
  └── returns EventDefinition[]

Entity YAML (events: block)
        │
        ▼
desugarEntityEvents(entity)
  └── synthesizes EventDefinition[] with direction:change, aggregate:<entity>
      (called by entity parser, result merged with top-level events)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/event-definition.schema.ts` | new | `EventDefinitionSchema`, `EventDefinition` type, field-type enum |
| `src/parser/load-events.ts` | new | `loadEvents()` function, `desugarEntityEvents()` helper |
| `src/__tests__/schema/event-definition.schema.test.ts` | new | Zod schema unit tests |
| `src/__tests__/parser/load-events.test.ts` | new | Parser unit tests |

## Interfaces

```ts
// src/schema/event-definition.schema.ts

export type EventDirection = 'inbound' | 'change' | 'outbound';
export type EventFieldType = 'uuid' | 'string' | 'number' | 'boolean' | 'date' | 'json';
export type EventPool = 'events_inbound' | 'events_change' | 'events_outbound';

export interface EventPayloadField {
  type: EventFieldType;
  nullable?: boolean;
  description?: string;
}

export interface EventDefinition {
  type: string;
  direction: EventDirection;
  pool: EventPool;         // derived from direction unless overridden
  aggregate?: string;
  source?: string;
  destination?: string;
  payload: Record<string, EventPayloadField>;
  retry: { attempts: number; backoff: 'linear' | 'exponential' };
  version: number;
  description?: string;
}

// src/parser/load-events.ts
export function loadEvents(eventsDir: string, entityNames: string[]): EventDefinition[];
export function desugarEntityEvents(entity: EntityDefinition): EventDefinition[];
```

## Implementation Steps

1. Write `EventDefinitionSchema` using Zod. Apply `.strict()` to catch unknown fields early.
2. Add `direction → pool` derivation as a Zod `.transform()` or post-parse step: if `pool` is not declared, derive from `direction`.
3. Add cross-field validation: `change` events require `aggregate`; `inbound` events may have `source`; `outbound` events may have `destination`.
4. Add pool consistency validation: if `pool` is explicitly overridden, it must match the direction category (a `change` event cannot declare `pool: events_inbound`).
5. Write `loadEvents()`: reads `events/*.yaml` using `glob`, validates each with `EventDefinitionSchema`, validates `aggregate` against `entityNames` param, throws descriptive error listing filename + field on failure.
6. Write `desugarEntityEvents()`: for each entry in `entity.events`, produces an `EventDefinition` with `direction: 'change'`, `aggregate: entity.name`, and the payload fields from the inline block.
7. Write unit tests: valid YAML parses correctly; invalid direction/aggregate fails; pool override inconsistency fails; desugaring produces correct output.

## Acceptance Criteria

- [ ] `EventDefinitionSchema` validates all documented fields; `.strict()` rejects unknown keys.
- [ ] `type` field must match `/^[a-z][a-z0-9_]*$/`.
- [ ] `aggregate` required when `direction === 'change'`; Zod refinement.
- [ ] `pool` when present must be consistent with `direction`; cross-field Zod refinement.
- [ ] `retry` defaults: `{ attempts: 3, backoff: 'exponential' }`.
- [ ] `version` defaults to `1`.
- [ ] `loadEvents()` returns `EventDefinition[]` where each item has `pool` populated (derived or explicit).
- [ ] A `change` event with `aggregate: 'nonexistent_entity'` throws with descriptive message.
- [ ] Entity `events:` block desugaring produces `EventDefinition` with correct `direction: 'change'` and `aggregate`.
- [ ] All tests pass in `just test-unit` (no Docker, no filesystem — use fixtures).

## Testing Strategy

Fixture-based unit tests in `src/__tests__/parser/load-events.test.ts`. Use inline YAML strings (not filesystem reads) for the schema tests. For the loader tests, use a temp directory with fixture YAML files.

## Open Questions

None — EVT-Q3 (keep both top-level + entity sugar with desugar) resolved before implementation.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Event YAML shape"
- `docs/specs/events-codegen-plan.md` §1 and §2 — original schema design (plan is superseded by ADR-024 for resolved questions)
- `src/schema/entity-definition.schema.ts` — reference for Zod schema style
- `src/parser/load-entities.ts` — reference for parser pattern
