# PW-EAV: EAV under `wiring: pattern-stack`

**Status:** implemented · **Follows:** PW-4

## Problem

PW-3a refused `eav: true` and `eav_value_table: true` under pattern-stack wiring, by name. The class graph (PW-1)
already had the EAV edges, but nothing used them:
- the EAV create and update use cases still imported `@nestjs/common` and took `@Inject(DRIZZLE) db`;
- `<entity>.wiring.ts` built the repository with `db` alone, and the service and use cases without
  `FieldValueService`;
- the composition built every repository before any service. An EAV entity's repository takes
  `FieldValueService`, which is a service, so the order could not hold it.

## Decision

### The templates

- The EAV `create` and `update` use cases drop the Nest import, the `DRIZZLE` token import and `@Inject(DRIZZLE)`
  under pattern-stack; `db` is a plain constructor parameter. The Nest text is unchanged byte for byte.
- The EAV repository and the with-fields use cases were already decorator-free under pattern-stack.

### `<entity>.wiring.ts`

`patternStackWiringParts` gains two blocks, read by `wiring.ejs.t`:
- **`eav`** (an `eav: true` entity):
  - `create<Entity>Repository(db, fieldValues)`;
  - `<Entity>ServiceDeps` gains `fieldValues: FieldValueService` and `db`;
  - the service takes `fieldValues` after its repository, as the Nest constructor does;
  - the `create` and `update` use cases take `(service, fieldValues, db)`. Their one transaction writes both the row
    and the values.
- **What a use case's constructor takes is the class graph's.** Each `patternStackWiringParts.useCases` row carries
  `args`, built from `constructorParts(graph, useCase)` (its edges in order, then its systems), each mapped to the
  argument `<entity>.wiring.ts` passes; the template prints `new <UseCase>(<args>)` with no kind or EAV branch. The
  services-deps fields come from the same place: `fieldValues` (`FIELD_VALUES_DEPS_FIELD`) and one field per system
  any use case takes (`useCaseSystems`, named by `SYSTEM_DEPS_FIELD`), which the template declares and the
  composition fills, so `db` is passed because a use case takes it.
- **`eavDefinition`** (an `eav_value_table: true` entity whose definition entity no relationship composes): the
  service deps gain `<definition>Repo: <Definition>Repository`, keyed by `repositoryPropertyName`, the composition's
  one rule.
- The two use cases `find_by_id_with_fields` and `list_with_fields` are wired like any other (they take the service).
- The PW-3a check that the class graph and the service agree on composed repositories now counts the value table's
  definition repository too. The `eav_definition` edge is one, so it would otherwise disagree.

### The composition

- A class that takes FieldValueService gets `serviceRef(field_value)`. That is `fieldValue.service` in its own
  module, or `deps.<module>.fieldValue.service` in another, which then becomes a `dependsOn` like a composed
  repository.
- **Build order** (`buildOrder`): a module's lines come in dependency order over the class graph. A use case's needs
  count as its service's, since `create<Entity>Services` builds both. The old order (every repository, then the
  junction services, then the entity services) is kept as the priority, so a project without EAV builds in the same
  order. Only an EAV repository moves: it comes right after FieldValueService when that service is in the same module.
  The module's header comment now says so.
  A cycle among a module's classes is an error that names them (the class graph refuses cycles before this).

### EAV on a family member

The schema refuses `eav: true` on a family base or child (R9), so it never reaches the templates. PW-EAV first added a
pattern-stack refusal for EAV with `inherits:` too; it could never fire, and S-1 removed it.

## The gate

- `test-smoke-pattern-stack` adds an EAV set:
  - `lead` (`eav: true`, in crm);
  - `field_value` (`eav_value_table: true`, with the unique index `upsertCurrentValues` conflicts on);
  - `field_definition`, both in a `custom_fields` context.
  So crm depends on customFields through FieldValueService.
- The Postgres half creates a definition, creates a lead with `fields: { budget }`, reads it back with
  `findByIdWithFields`, updates the value, and finds it merged in `listWithFields`.
- `eav-pattern-stack.test.ts` covers the wiring parts (the FieldValueService block, the with-fields use cases, the
  value table's definition repository).
- `emit-composition.test.ts` pins:
  - the cross-module refs and `dependsOn`;
  - the value table's definition repository;
  - the single-module build order, where only the EAV repository moves.

## Found

An EAV entity needs a `user_id` column: its create and update use cases stamp each value with `core.userId` /
`entity.userId`. Nothing checks this before `tsc` (under Nest too); the smoke's `lead` declares one. Refusing it
by name at generation would be a separate change.
