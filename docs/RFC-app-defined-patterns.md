# RFC: App-Defined Patterns

**Status:** Draft — proposal for discussion
**Date:** 2026-04-18
**Author:** Doug + Claude
**Relates to:** `CODEGEN-EVOLUTION-PLAN.md`, `#59` (auth + integrations subsystem), `#60` (sync engine + `syncable:`), dealbrain-v2 CRM sync ADR-14

---

## Revision — 2026-04-19: Patterns are a parallel track, not a prerequisite

Dealbrain-v2 evidence (CRM epic, April 2026) confirms: subsystems can ship without patterns and retrofit cleanly when patterns land.

- **Integrations** (#59): adapter-per-provider (`ICrmPort` → `SalesforceCrmAdapter`) works today without a Patterns primitive. When patterns land, `patterns: [Integrations]` becomes an opt-in authoring surface; the runtime contract (`IAuthStrategy.resolve`, port/adapter dispatch) does not change.
- **Sync engine** (#60): `ExecuteSyncUseCase<T>` + `syncable:` annotation is an orthogonal feature. `patterns: [Sync]` would add nicer declarative syntax, not change runtime behavior.
- **EAV** (in `src/modules/crm/` today): hand-extended `FieldValueService.upsertFieldsTransactional` works. `patterns: [Eav]` when it lands replaces `eav: true` flag + ~15 LOC of hand extension. Real delta, but modest and non-structural.

**Implication for sequencing:** #59 and #60 do not wait on this RFC. Both ship with direct port/adapter patterns and gain an opt-in `patterns:` surface when Patterns land. The CrmEntityRepository/CrmEntityService hand-written base classes stay the "first app pattern" placeholder until the upstream primitive exists — they do not block it.

---

---

## Summary

Codegen-patterns today has two extension units: **families** (method-carrying base classes — `SyncedEntityRepository`, `ActivityEntityRepository`, etc.) and **behaviors** (column-adders + hooks — `timestamps`, `soft_delete`). Both are library-owned and closed-set. When a consumer needs a reusable abstraction that sits between the library's family bases and their concrete entities — e.g. a CRM app's `CrmEntityRepository<T>` that bundles EAV dual-write + canonical field routing — there is no seam. They hand-write it and drop out of the codegen contract.

This RFC proposes **Patterns** as a first-class, consumer-extensible primitive: composable semantic archetypes that bundle fields + methods + hooks + declarative config, designed to be inherited and composed by app code. Patterns would coexist with families and behaviors; they're the piece that lets apps recognize and build their own domain abstractions.

The model is lifted from Pattern Stack's Python library (`pattern_stack/atoms/patterns/`), which already ships `ActorPattern`, `EventPattern`, `CatalogPattern`, `CategoricalPattern`, `RelationalPattern` as composable, app-extensible archetypes. This RFC ports the idea to the TS codegen surface.

---

## Motivation

### The trigger case: dealbrain-v2 CRM sync

The CRM sync spec (`specs/2026-04-16-crm-sync-engine-overhaul.md` in dealbrain-v2) needs three entities — `opportunity`, `account`, `contact` — to share:

- EAV dual-write on `upsert` (write entity columns **and** `field_values` in one transaction)
- EAV merge on read (`findByIdWithFields` pulls custom fields alongside core columns)
- Configuration-driven upsert (conflict target, updatable columns, provider metadata)

The current plan is to hand-write `CrmEntityRepository<T>` and `CrmEntityService<T>` in the consumer's `src/shared/base-classes/`, then have the codegen-generated `OpportunityRepository` etc. extend those manually. This works — but:

1. **Generated repos need manual re-parenting** after every regen (currently via edits that get clobbered).
2. **The CRM-shaped abstraction is invisible to codegen** — it can't emit scaffolding that knows about EAV dual-write or canonical field routing.
3. **Nothing prevents the next app** (media library, ledger, ticketing) from reinventing the same pattern with slightly different shape.

### Why families don't solve it

Adding a `synced_crm` family upstream would solve the first problem but entrench the second and third. Families are library-shipped; every new domain abstraction requires a codegen-patterns PR. Consumers can't define their own families — and they shouldn't need to.

### Why behaviors don't solve it

Behaviors are column + hook adders. They can't contribute method signatures that take typed arguments, compose transactional logic, or carry per-use declarative config (like `class Pattern: states = {...}`). EAV dual-write needs all three.

---

## The Proposal

### Pattern, defined

A **Pattern** is:

1. A **domain-layer contract** — table columns + repository methods + service methods — that the pattern declares and codegen projects downstream. Patterns own the domain layer (entity + repo + service); controllers, DTOs, and frontend collections are derived from that contract, not owned by it. A pattern may omit part of the trio (a service-only `AuditablePattern` has no table), but it declares the contract explicitly rather than opting into layer slots.
2. A **declarative config surface** — a YAML block front-door backed by a Zod schema on `definePattern()` as the typed contract.
3. A **set of codegen hooks** that wire the inheritance, propagate column additions, and route method calls without the consumer writing glue.
4. **Composable** via explicit `extends: [PatternA, PatternB]`. Orthogonal patterns combine without conflict (e.g. `EventPattern + SyncedPattern + EavPattern`).

Patterns may be **library-shipped** (the initial set below) or **app-defined** (the key DX move).

**Per-entity metadata hand-off.** A pattern's base class often needs entity-specific metadata at runtime (e.g. `CrmEntityRepository` needs to know `opportunities`'s conflict-target columns and updatable column list). Codegen emits the concrete repo's constructor to pass that metadata into `super()` as a `patternConfig` argument. The base class receives it typed, carries it on `this`, and uses it generically. This keeps DI idiomatic, keeps types end-to-end, and avoids static-property or reflect-metadata ceremony.

### Library-shipped Patterns (initial set)

Port from Pattern Stack, adapted for NestJS + Drizzle:

| Pattern | Adds | Based on |
|---|---|---|
| `BasePattern` | `id`, `created_at`, `updated_at`, lifecycle event emission | Pattern Stack `BasePattern` |
| `EventPattern` | `state` column, state machine, transition hooks (`onEnterX`, `onExitX`), transition events | Pattern Stack `EventPattern` |
| `ActorPattern` | `display_name`, `actor_type`, contact fields, `reference_number` via mixin | Pattern Stack `ActorPattern` |
| `CatalogPattern` | Inventory fields, pricing, `adjust_stock`, `reserve_stock` | Pattern Stack `CatalogPattern` |
| `CategoricalPattern` | Flat classification (`name`, `slug`, `color`, `sort_order`) | Pattern Stack `CategoricalPattern` |
| `RelationalPattern` | `entity_a_type/id`, `entity_b_type/id`, `relationship_type` | Pattern Stack `RelationalPattern` |
| `SyncedPattern` | `external_id`, `provider`, `provider_metadata`, `syncUpsert`, `findByExternalId` | Today's `synced` family |

The current `synced` / `activity` / `knowledge` / `metadata` families fold directly into Patterns — no backward-compat aliases. Per the repo's "no backwards compatibility until we have users" principle (CLAUDE.md), the old `family:` key is deleted in the same change that introduces `patterns:`.

### App-defined Patterns (the key move)

An app — e.g. dealbrain — declares its own Pattern in `src/patterns/`:

```ts
// src/patterns/crm-entity.pattern.ts
export class CrmEntityRepository<T> extends SyncedRepository<T> {
  // EAV dual-write on upsert
  async syncUpsert(userId: string, inputs: UpsertInput[]) {
    return this.db.transaction(async (tx) => {
      const records = await super.syncUpsert(userId, inputs, tx);
      await this.eavService.writeBatch(userId, this.entityType, /* ... */, tx);
      return records;
    });
  }
}

export class CrmEntityService<T> extends SyncedService<T> {
  async findByIdWithFields(id: string, userId: string) {
    const entity = await this.repo.findById(id);
    const fields = await this.eavService.readMerged(userId, this.entityType, id);
    return entity ? { ...entity, fields } : null;
  }
}

export const CrmEntityPattern = definePattern({
  name: 'CrmEntity',
  extends: ['Synced'],
  repository: CrmEntityRepository,
  service: CrmEntityService,
  behaviors: ['external_id_tracking'],
  config: z.object({
    entityType: z.enum(['opportunity', 'account', 'contact']),
  }),
});
```

Entities then use it like any library pattern:

```yaml
# entities/opportunity.yaml
entity:
  name: opportunity
  pattern: CrmEntity              # app-defined, codegen resolves from src/patterns/
  config:
    entityType: opportunity
behaviors:
  - timestamps
  - soft_delete
```

Codegen scans `src/patterns/*.pattern.ts` during `project init` and at `entity new`, validates the config against the pattern's Zod schema, emits a concrete repo/service that extends the pattern's base classes, and wires NestJS DI.

### Composition

Multi-pattern composition mirrors Pattern Stack's Python multi-inherit:

```yaml
entity:
  name: deal
  patterns: [CrmEntity, Event]
  config:
    CrmEntity: { entityType: opportunity }
    Event:
      states:
        qualifying: [developing, closed_lost]
        developing: [proposing, closed_lost]
        proposing: [negotiating, closed_lost]
        negotiating: [closed_won, closed_lost]
      initial_state: qualifying
```

Conflict resolution: two patterns contributing the same column name is a generation-time error. Two patterns contributing the same method name is a TypeScript mixin conflict and the app resolves it in their own code.

---

## Relationship to Existing Concepts

| Concept | Today | With Patterns |
|---|---|---|
| **Family** (`synced`, `activity`) | Library-shipped, closed set, method-carrying | Becomes a built-in Pattern; consumers can define their own |
| **Behavior** (`timestamps`) | Column-adder + hook | Unchanged; Patterns can require/include behaviors |
| **Subsystem** (events, jobs, cache) | Separate Protocol → Backend → Factory | Unchanged; Patterns may wire into subsystems |
| **Junction / Relationship** | YAML-declared first-class | Unchanged; a Pattern could own a junction |

Patterns are **not** a replacement for behaviors or subsystems. They're the missing unit between "this column cluster always travels together" (behavior) and "this is a full domain archetype" (pattern).

---

## Agent-Assisted Discovery

Once Patterns are the DX primitive, they become a vocabulary agents can reason over:

> "This entity has state transitions and a close date — compose `EventPattern`. It needs external sync — add `SyncedPattern`. It has custom fields — your app's `EavPattern`. You'll end up with something shaped like your `CrmEntityPattern`."

That's legible to a developer and tractable for an agent. Families-as-today aren't — they're library internals. The pattern catalog (library + app-defined) is exactly the surface agents need to recommend, compose, and scaffold.

---

## Migration Path

**Phase 1 — Library port (codegen-patterns):**
1. Introduce `definePattern()` primitive + Pattern registry.
2. Port `synced` family to `SyncedPattern`; delete the `family:` key outright (no alias).
3. Port `EventPattern`, `ActorPattern` from Pattern Stack semantics (state machine + identity).
4. YAML schema: add `patterns:` + `config:` keys. `family:` is removed.
5. Codegen scans `<consumer>/src/patterns/*.pattern.ts` and merges app-defined Patterns into the registry.

**Phase 2 — First consumer (dealbrain-v2):**
1. Define `CrmEntityPattern` in `src/patterns/crm-entity.pattern.ts` (migrating the planned `src/shared/base-classes/` work).
2. Update `opportunity.yaml` / `account.yaml` / `contact.yaml` to use `pattern: CrmEntity`.
3. Regenerate; verify the hand-edits in `HANDOFF.md`'s "generated files that were hand-edited" list are now clean output.

**Phase 3 — Catalog expansion:**
1. Port remaining Pattern Stack patterns (`CatalogPattern`, `CategoricalPattern`, `RelationalPattern`).
2. Document app-defined Pattern conventions.
3. Explore agent-assisted Pattern discovery (`codegen pattern suggest <yaml>`).

---

## Resolved Decisions

_Decisions made 2026-04-19 based on dealbrain-v2 evidence and the operating principles in CLAUDE.md._

1. **Pattern discovery — scan, not manifest.** Codegen scans `src/patterns/*.pattern.ts` at generation time. Zero-config matches how entities and subsystems already work; a manifest surface is over-engineering for a directory of `*.pattern.ts` files.
2. **Config surface — YAML front door + Zod typed contract.** The YAML `config:` block is the authoring surface; the Zod schema on `definePattern({ config })` is the validated typed contract. No inner-class config.
3. **Layer ownership — domain-layer contract, downstream is derivation.** Patterns own the entity + repository + service trio (may omit parts). Controllers, DTOs, and frontend collections are projected downstream by codegen from that contract, not owned by the pattern. See "Pattern, defined" above for the explicit contract shape.
4. **Metadata hand-off — constructor injection.** Codegen emits the concrete repo's constructor passing `patternConfig` into `super()`. Typed, DI-idiomatic, no static property or reflect-metadata. See "Pattern, defined" above.
5. **Family migration — clean cut, no aliases.** Per CLAUDE.md "no backwards compatibility until users" — the `family:` key is deleted in the same change that introduces `patterns:`. No deprecation window.
6. **Pattern Stack parity — TS-idiomatic subset, expand on demand.** Start with the semantic core (state machine for `EventPattern`, identity fields for `ActorPattern`, etc.); defer DB-sequence reference numbers, full change tracking, and Python-idiom features until a consumer needs them.

---

## Open Questions (for the implementation ADR)

1. **Minimum viable domain-layer contract shape.** What exactly does `definePattern()` accept for the entity/repo/service contributions? Some candidate shape:
   ```ts
   definePattern({
     name: 'CrmEntity',
     extends: ['Synced'],
     columns?: ColumnsContribution,       // additive columns on the entity table
     repository?: RepoContribution,       // base class + method signatures it adds
     service?: ServiceContribution,       // base class + method signatures it adds
     behaviors?: BehaviorName[],          // behaviors the pattern requires
     config: ZodSchema,                   // per-use config validated at codegen time
   });
   ```
   At least one of `columns` / `repository` / `service` must be present. The ADR should lock the exact shapes and the composition rules (two patterns contributing the same column name is a generation error; same method name is a TS mixin conflict and the app resolves it).
2. **`patternConfig` shape per pattern.** What metadata does each library-shipped pattern need at runtime, and how does codegen infer it from the entity YAML? For `CrmEntityPattern`: conflict target columns, updatable column list, `external_id` column name. Some of this is derivable from entity YAML; some may need explicit declaration in the `config:` block. The ADR should enumerate the fields for each library-shipped pattern to verify the constructor-injection contract actually carries the necessary info.

---

## Not in Scope

- Frontend Pattern surface (React hooks, collection types). If/when patterns extend to frontend, this RFC is the foundation, but the first pass is backend-only.
- Runtime Pattern resolution (dynamic pattern lookup at request time). Patterns are compile/codegen-time constructs.
- Pattern versioning / semver contracts. Treated as part of codegen-patterns itself initially.

---

## Next Steps

1. Discuss this RFC; lock the core primitive (`definePattern`, YAML surface).
2. Prototype the primitive in a codegen-patterns branch with `SyncedPattern` + `CrmEntityPattern` as the first consumer demo.
3. Validate against dealbrain-v2's CRM sync stack (Stack 1 of the CRM spec).
4. Iterate; then port `EventPattern` / `ActorPattern` for broader reach.
