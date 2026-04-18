# EAV Starter: Field Definition + Field Value

A two-entity Entity-Attribute-Value pattern for apps that need dynamic, per-tenant custom fields on top of typed entity columns. Common use cases: CRM custom fields synced from Salesforce/HubSpot, user-defined metadata on content, org-configurable attributes on any synced entity.

## What ships here

- `field_definition.yaml` — schema record describing a custom field (one row per `(entity_type, key, provider)`)
- `field_value.yaml` — stored value for one `(entity_id, field_definition_id)` cell

Both use `family: metadata`, which gives you the library's `upsertMany`, `findByEntityIdAndType`, and `listHistory` methods out of the box.

## How to use

1. Copy both YAMLs into your project's `entities/` directory.
2. Customize the `entity_type` enum in both files — replace the example `[opportunity, account, contact]` with the entity types in your app that should support EAV.
3. If you're single-tenant, remove the `user_id` field (it's included for multi-tenant scoping).
4. Run `codegen entity new --all` (or your project's generation command).

## What you still have to wire by hand

The generated repositories give you typed CRUD on both tables, but **dual-write semantics** — writing to an entity's core columns AND to `field_values` in one transaction, and merging on read — still has to live in your service layer. You'll typically:

- Extend your synced-entity service with a `upsertWithFields()` that calls `entityRepo.upsert()` + `fieldValueRepo.upsertMany()` inside a transaction
- Add a `findByIdWithFields()` that joins `field_values` onto the entity row on read
- Route between entity columns and EAV based on whether a field is declared in `field_definition`

This is the same pattern `dealbrain-v2` hand-writes today in its `CrmEntityRepository<T>` + `CrmEntityService<T>` base classes.

## TODO: promote to a first-class `EavPattern`

The hand-wiring above is exactly what the **app-defined Patterns** proposal (see `docs/RFC-app-defined-patterns.md`) is designed to eliminate. Once Patterns land as a primitive, this starter becomes:

```yaml
# entities/opportunity.yaml
entity:
  name: opportunity
  patterns: [Synced, Eav]
  config:
    Eav:
      definitions_table: field_definitions
      values_table: field_values
```

With `EavPattern` shipped as a library pattern, consumers would no longer copy these YAMLs or hand-write dual-write — they'd opt into `Eav` and the base class would contribute `upsertWithFields`, `findByIdWithFields`, and read-merge automatically.

**Tracking:** RFC `docs/RFC-app-defined-patterns.md`. This starter is Tier 1 (ship entities as a scaffold); the RFC is Tier 3 (ship as a composable Pattern).
