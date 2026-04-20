# EVT-7 — Entity `emits:` Support + Use-Case Template Updates

**Issue:** EVT-7
**Status:** Implemented (2026-04-20)
**Phase:** ADR-024 Phase 1 (Phase C per events-codegen-plan.md — independent, may slip to Phase 2 without blocking ADR-023)
**Depends on:** EVT-2 (event YAML parser, for cross-validation), EVT-3 (TypedEventBus import), EVT-6 (module must be wired).
**Blocks:** Nothing in Phase 1. Enables typed auto-emission in entity use cases.

## 2026-04-20 Implementation Notes

The plan is preserved above for historical reading. The corrections below
are drift captured during implementation — they reflect what actually shipped.

1. **Schema target is `EntityDefinitionSchema`, not `EntityConfigSchema`.** The
   field was added to `EntityDefinitionSchema` in `src/schema/entity-definition.schema.ts`
   with a regex guard on snake_case names:
   `z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).optional()`.
2. **Cross-validation lives in `src/parser/validate-emits.ts`, not inside `load-entities.ts`.**
   The parser only mirrors the raw array into `ParsedEntity.emits`. The CLI
   command (`src/cli/commands/entity.ts`) runs `validateEntityEmits()` as a
   pre-flight, after `collectMergedEvents()` merges top-level `events/*.yaml`
   with the inline desugar. This keeps the hot path in `load-entities.ts`
   free of registry cross-referencing.
3. **Three-valued semantics.** `emits` is not just "optional" — it is
   `undefined` (fallback + warning), `[]` (explicit opt-out, no warning),
   or `string[]` (typed emission). The `|| null` shortcut is explicitly
   avoided in the parser and prompt so `[]` is preserved.
4. **Template DI is via the injection token, not a property name.** Generated
   use cases read `@Inject(TYPED_EVENT_BUS) private readonly typedEvents: TypedEventBus`
   (not `this.events`). The `DRIZZLE` token is imported from
   `@shared/constants/tokens` alongside a `DrizzleClient` type from
   `@shared/types/drizzle` — the CLP precedent. `@shared/events` re-exports
   `TYPED_EVENT_BUS`, `TypedEventBus`, and `DrizzleTransaction`.
5. **Repository `tx?` is per-op, not blanket.** The clean-arch repository
   interface + inline repo templates append `tx?: DrizzleTransaction` only to
   the specific create/update/delete signatures whose corresponding
   `<entity>_<op>` event is declared. Non-emitting entities and non-emitting
   operations remain byte-stable. The `base_class` strategy already inherits
   tx-accepting CRUD from `BaseRepository` and needs no template change.
6. **Warnings are stderr, errors gate generation.** The CLI pre-flight treats
   validation results as two buckets: `error` (`missing`, `wrong_direction`,
   `wrong_aggregate`) and `warning` (`no_emits`, `duplicate_emit`). Errors
   abort the run unless `--continue-on-error` is passed; warnings always
   print and never gate. A summary line reports counts.

## Overview

Add `emits:` field to entity YAML schema. Parse and cross-validate declared events. Update entity use-case templates to inject `TypedEventBus` and call `publish()` inside the Drizzle transaction. Emit a codegen warning for entities without `emits:`. Mark `lifecycle-events.ts` as a fallback path.

## Context

**What exists.** Entity templates call `BaseService` lifecycle hooks which auto-emit untyped events via `runtime/base-classes/lifecycle-events.ts`. Event strings are `${entityName}.created`, `${entityName}.updated`, etc. — no registry knowledge, no typing, no `tx` guarantee.

**What this PR adds.** Opt-in typed emission via `emits:` block. Entities that declare `emits:` get generated use-cases that call `TypedEventBus.publish(type, aggregateId, payload, { tx })` explicitly inside the Drizzle transaction. Entities without `emits:` keep the current fallback path with a warning.

**Phase C context.** The events-codegen-plan.md calls this "Phase C — independent of jobs, can slip freely." It is included in EVT Phase 1 because it completes the picture, but it does NOT block ADR-023 (the bridge depends on EVT-3's registry, not on entity auto-emission).

## Architecture

```
entities/contact.yaml
  emits:
    - contact_created
    - contact_updated

  At parse time:
    ├── validate: events/contact_created.yaml exists with direction:change, aggregate:contact
    ├── validate: events/contact_updated.yaml exists with direction:change, aggregate:contact
    └── error if any declared event is missing or misconfigured

  At codegen time (use-case template):
    create-contact.use-case.ts
      async execute(input): Promise<Contact> {
        return this.db.transaction(async (tx) => {
          const contact = await this.contacts.create(input, tx);
          await this.events.publish('contact_created', contact.id, {
            contactId: contact.id,
            accountId: contact.accountId,
            createdBy: input.actorId,
          }, { tx });   ← CRITICAL: tx passed explicitly
          return contact;
        });
      }
```

Entity `events:` block desugaring (existing syntax preserved):

```yaml
# Entity events: block (inline sugar)
events:
  - type: contact_created
    payload:
      contact_id: { type: uuid }
      account_id: { type: uuid, nullable: true }
```

This desugars to an `EventDefinition` with `direction: change` and `aggregate: contact`, identically to a top-level `events/contact_created.yaml`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/entity-definition.schema.ts` | modify | Add `emits: z.array(z.string()).optional()` field |
| `src/parser/load-entities.ts` | modify | Cross-validate `emits` entries against event registry |
| Entity use-case templates (`templates/entity/new/*/`) | modify | Inject `TypedEventBus`, call `publish()` inside `tx` when `emits:` declared |
| `runtime/base-classes/lifecycle-events.ts` | modify | Add deprecation comment; remains as fallback for entities without `emits:` |
| `src/__tests__/schema/entity-definition.schema.test.ts` | modify | Add `emits` field tests |

## Implementation Steps

1. Add `emits: z.array(z.string()).optional()` to `EntityConfigSchema` in `entity-definition.schema.ts`.
2. In entity parser, after loading events, cross-validate: for each `emits:` entry, check that `events/<type>.yaml` exists with `direction: 'change'` and `aggregate === entity.name`. Fail hard with the missing filename + mismatch details.
3. In the codegen pipeline, check if the entity has `emits:` declared. If yes, add `TypedEventBus` injection to the generated use-case module. If no, emit a warning to stdout: `Entity <name> has no emits: block. Falling back to untyped lifecycle events.`
4. Update use-case templates: when `emits:` is declared, generate `this.events.publish(...)` call inside the transaction. The payload fields come from the `EventDefinition.payload` map.
5. For entity `events:` block: wire the desugaring from EVT-2's `desugarEntityEvents()` into the entity parse step (likely already called from there — confirm and test).
6. Add deprecation marker to `lifecycle-events.ts`: `@deprecated Use entity emits: block + TypedEventBus.publish() instead.`
7. Update baseline snapshots; `just test-baseline` passes.

## Acceptance Criteria

- [ ] `emits: [contact_created]` in entity YAML passes Zod validation; absence also passes.
- [ ] A declared `emits:` entry with no matching `events/<type>.yaml` → hard codegen error.
- [ ] A declared `emits:` entry where the matching YAML has wrong `direction` or wrong `aggregate` → hard codegen error.
- [ ] Generated use-case for an entity with `emits:` injects `TypedEventBus`; the `execute` method calls `this.events.publish(type, ...)` with `{ tx }` inside the transaction.
- [ ] Entity without `emits:` still generates (fallback); codegen prints a warning to stdout.
- [ ] Entity `events:` block (inline sugar) still works and produces the same registry entries as a top-level `events/*.yaml`.
- [ ] `lifecycle-events.ts` has `@deprecated` annotation on the auto-emit path.
- [ ] Baseline snapshot test updated; `just test-baseline` passes.

## Testing Strategy

- Parser unit tests: entity with valid `emits:`, invalid (missing event file), and mismatched aggregate.
- Template snapshot tests: generated use-case with `emits:` declared includes `TypedEventBus` injection and `publish()` call.
- Warning integration test: entity without `emits:` triggers warning output (capture stdout).

## Resolved Questions (at implementation)

- **EVT-Q3** (entity `events:` block vs. top-level YAML): both are accepted.
  `collectMergedEvents()` merges them with top-level winning on collision.
  The inline `events:` block is desugared to the same `EventDefinition` shape.
- **EVT-Q4** (`emits:` required vs. optional): optional, three-valued.
  Absence → warning + fallback. `[]` → silent opt-out. Non-empty → typed.
- **EVT-Q9** (pool inheritance for triggered jobs): unchanged — not gated by EVT-7.
- **Payload mapping**: five-rule fallback resolved inline in `prompt.js`'s
  `resolveEmitsEvents()`:
  1. `<entity>_id` or `<camelName>Id` → `entity.id`.
  2. `created_by` / `updated_by` → `dto.createdBy` / `dto.updatedBy` if
     present; else `null as unknown as T` with a TODO.
  3. Any other key present on the just-created entity → `entity.<camelKey>`.
  4. Else, if present on the DTO → `dto.<camelKey>`.
  5. Otherwise `null as unknown as T` with a TODO comment on the generated line.
  Every generated `publish()` block is preceded by a
  `// TODO: verify payload mapping against events/<type>.yaml` comment so
  the developer is nudged to audit before shipping.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"Entity emits: block"
- `docs/specs/events-codegen-plan.md` §4 — auto-emission design
- `.claude/skills/events/event-codegen.md` §"Entity emits: block (required for typed auto-emission)"
- `.claude/skills/events/outbox-and-transactions.md` — why `tx` must be passed
- `runtime/base-classes/lifecycle-events.ts` — current auto-emission (fallback path)
