# ADR-021 — On-Delete Semantics for Generated Relations

**Status:** Accepted
**Date:** 2026-04-14
**Owner:** Doug
**Related:** ADR-005 (Entity Family Base Classes), issue #34 (implementation)

## Context

Entity YAMLs declaring `belongs_to` generate a child-side UUID column and a Drizzle `relations()` helper. That helper is query-builder metadata only — it does not create a Postgres foreign key. The generated column has no `.references()` call and no `ON DELETE` action.

Bug site: `templates/entity/new/clean-lite-ps/entity.ejs.t:24–26`

```ejs
<%_ clpBelongsTo.forEach(rel => { _%>
    <%= rel.camelField %>: uuid('<%= rel.field %>')<%= rel.nullable ? '' : '.notNull()' %>,
<%_ }) _%>
```

The parser (`src/parser/load-entities.ts`) already resolves `foreign_key`, `target`, and `nullable` across the entity graph and validates cross-references. That information is dropped on the floor before the template runs.

Observed consequences from dogfood (handoff writeup, E2E validation):

- Deleting a parent row leaves children behind. Aggregate queries (admin dashboards, usage totals) keep counting bytes and tokens that belong to deleted conversations.
- In the demo entity graph (`conversation → message → message_part`, `conversation → tool_call`, `message → tool_call`), a single `DELETE /conversations/:id` produced 2 orphan messages, 1 orphan tool_call, 1 orphan message_part. Nothing in the framework caught it.
- `soft_delete` complicates the picture. `BaseService.delete()` issues an `UPDATE … SET deleted_at = now()`; Postgres cascade rules never fire for a soft-delete because no DELETE statement is ever issued.

Two decisions are coupled here and must be made together:

1. **How we emit database-level foreign keys** for `belongs_to` relations.
2. **How soft-delete propagates** (or doesn't) through an entity tree when the parent is soft-deleted.

## Decision

### 1. YAML surface — optional `on_delete`

Extend the relationship schema with an optional `on_delete` value, defaulting to `restrict`.

```yaml
relationships:
  - belongs_to: conversation
    foreign_key: conversation_id
    nullable: false
    on_delete: restrict   # cascade | set_null | restrict | no_action
```

| Value       | Emitted Drizzle                                  | Meaning                                                                 |
|-------------|--------------------------------------------------|-------------------------------------------------------------------------|
| `restrict`  | `{ onDelete: 'restrict' }`                       | Parent DELETE fails if children exist. **Default.**                     |
| `cascade`   | `{ onDelete: 'cascade' }`                        | Parent DELETE removes children transactionally.                         |
| `set_null`  | `{ onDelete: 'set null' }`                       | Parent DELETE nulls the FK on children. Requires `nullable: true`.      |
| `no_action` | `{ onDelete: 'no action' }`                      | Deferred check. Rarely useful; documented for completeness.             |

The template emits `.references(() => <parent>.id, { onDelete: '<x>' })` unconditionally whenever the relation is present. When `on_delete` is omitted from YAML, the default `restrict` is applied during schema validation — the template sees an explicit value in every case.

Schema validation (new rule in `src/schema/entity-definition.schema.*`):

- `on_delete: set_null` with `nullable: false` is a parse error. Postgres cannot null a NOT NULL column; the generated migration would fail at apply time and we prefer to fail at validate time.

**Default is `restrict`, not `cascade`.** Restricting is the safe-by-default choice: it forces the developer to think about the tree before deletion succeeds, and it surfaces orphan-producing code paths as loud 500s during development instead of silent data loss in production. Teams that want cascading deletes must opt in per relation.

### 2. Soft-delete cascade — Option A (filter at query time)

When a parent is soft-deleted, children are not modified. Consumers that need to exclude rows whose parent is soft-deleted do so in the query layer via an `EXISTS` subquery.

`BaseRepository` gains a helper (to be implemented in issue #34):

```ts
protected activeParentFilter(parentTable: PgTable, parentFkColumn: PgColumn) {
  return sql`EXISTS (
    SELECT 1 FROM ${parentTable} p
    WHERE p.id = ${this.table}.${parentFkColumn}
      AND p.deleted_at IS NULL
  )`;
}
```

Repositories and aggregate queries opt in to the filter when they need parent-reachability semantics. The default `findAll`/`findById` behavior is unchanged: rows exist until they are soft-deleted themselves.

This is deliberately the least-magic option. Soft-delete is a single-table `UPDATE`; the framework does not reach outside that row. Atomicity and auditability both follow from that rule.

### 3. Interaction between DB foreign keys and soft-delete

This is the subtle one and must be stated explicitly:

**`on_delete` describes hard-delete behavior only.** When a soft-deleted entity is the parent, `BaseService.delete()` issues `UPDATE … SET deleted_at = now()`, not `DELETE`. Postgres cascade rules only fire on actual DELETE statements, so none of the `on_delete` actions apply in the soft-delete case.

Concretely:

- `on_delete: cascade` on `message.conversation_id` **does not** delete or mark messages when a conversation is soft-deleted. Messages are untouched.
- `on_delete: restrict` on `message.conversation_id` **does not** block a conversation from being soft-deleted, even if messages exist. The soft-delete proceeds.
- Hard-delete (e.g. during an admin purge, a test tearDown, or a future `BaseService.hardDelete()` call) is the only time `on_delete` rules fire. At that point `restrict` / `cascade` / `set_null` behave exactly as their Postgres semantics describe.

Consumers who want "when a conversation is soft-deleted, its messages should not appear in aggregate totals" reach for `activeParentFilter()` in the repository. They do not reach for `on_delete: cascade` — that would be a no-op for the soft-delete path and silent data loss for the hard-delete path.

## Consequences

### Positive

- **No silent orphans.** `restrict`-by-default turns orphan-producing code paths into immediate errors during development. Existing `DELETE /parents/:id` endpoints that worked by accident will return 500 the first time they're called against a parent with children; the fix is one of: delete the children first, change the relation to `cascade`, or soft-delete instead.
- **Clear separation of concerns.** Hard-delete semantics live in the DB. Soft-delete-aware reads live in the repository layer. Neither leaks into the other.
- **Atomic writes preserved.** `BaseService.delete()` remains a single-row `UPDATE`. No cascading writes, no N+1 in tree deletion, no ordering bugs between parent and child soft-deletes.
- **Information is already there.** The parser has `foreign_key`, `target`, and `nullable` resolved. Plumbing `on_delete` is additive — no changes to the analyzer or entity graph.

### Negative

- **Migration-breaking for existing dev databases.** Any dev or staging DB that currently contains orphans will refuse the migration that adds the FK constraint, because Postgres validates existing data when `ALTER TABLE … ADD FOREIGN KEY` is issued. Teams must clean up orphans (or run the migration with `NOT VALID` and backfill, a manual step) before the constraint applies. The issue #34 implementation PR will document the workaround.
- **Endpoints start failing loudly.** `DELETE /conversations/:id` against a conversation with messages will 500 with a Postgres `foreign_key_violation` under the `restrict` default. This is the correct behavior — silent orphaning was the bug — but it will surface as a new class of errors for consumers.
- **Consumers carry the `activeParentFilter()` burden.** Admin aggregates and "list all X reachable from active Y" queries must remember to opt in. This is a known ergonomic tax; the alternative (Option B) is a larger tax paid by the framework.
- **`on_delete: cascade` is a trap for the unwary.** A developer reading the YAML might reasonably expect "cascade" to also handle the soft-delete case. The ADR and the generated YAML comments will call this out; runtime behavior will not.

### Neutral

- `no_action` is supported for completeness but is effectively equivalent to `restrict` for single-statement transactions. Teams that want deferred checks are presumed to know why they want them.

## Alternatives Considered

### Option B — Propagate soft-delete through the tree

When a parent is soft-deleted, `BaseService.delete()` walks the child tables declared in the YAML graph and issues soft-deletes on each. The repository layer stays simple; aggregates "just work" because every row has its own `deleted_at`.

Rejected because:

- **Atomicity breaks.** A single API call produces N `UPDATE` statements across M tables. A partial failure leaves the tree in an inconsistent state. Wrapping in a transaction helps but does not eliminate reasoning costs (retry semantics, deadlocks, performance on wide trees).
- **Framework now knows the entity graph at runtime.** Today, `BaseService` is a per-entity class with no awareness of its position in the graph. Propagation requires injecting graph metadata — either generated into each service, or looked up from a registry. Both are possible; neither is free.
- **Retention divergence becomes impossible.** Some consumers want to soft-delete a conversation but keep the messages queryable for audit. Cascading propagation forecloses that.
- **No concrete use case yet.** The dogfood finding is "aggregates double-count after parent soft-delete." That is solvable with `activeParentFilter()` without touching write semantics.

Flagged as future work. The door is open to revisit if a real retention-divergence requirement appears with genuine teeth.

### Option C — No framework help; consumers write `EXISTS` everywhere

The framework does nothing. Repositories write their own joins when they need parent-reachability.

Rejected as a starting point. `activeParentFilter()` is five lines of helper code and removes the repeated boilerplate from every admin query. Option C is what you get if you ignore the helper; we provide the helper but do not force its use.

### Default `on_delete: cascade`

Emit cascade as the default because "that's what people usually want." Rejected: cascade is the right answer for some relations (message parts follow their message) and catastrophically wrong for others (an audit log that must outlive the user it describes). A cascading default silently encodes one answer. `restrict` makes the absence of an answer loud, which is the behavior we want from a code generator.

## Follow-ups

- **Issue #34** — implement the schema change, template change, and `activeParentFilter()` helper. Includes snapshot tests on generated `.entity.ts` asserting the FK constraint is emitted with the configured `onDelete` value, and an integration test covering parent-delete-with-children under each `on_delete` value.
- **Migration guidance doc** — short note in `docs/CONSUMER-SETUP.md` on cleaning up existing orphans before applying the migration that introduces FKs. To ship with the issue #34 PR.
- **`BaseService.hardDelete()`** — not covered here. Exists as a separate design question: if we ever need a true hard-delete path (admin purge, GDPR erasure), it will interact with `on_delete` in the obvious way. No work implied by this ADR.
- **Revisit Option B** — only if a concrete use case surfaces where single-statement soft-delete is insufficient and `activeParentFilter()` is not a reasonable answer.

## References

- `templates/entity/new/clean-lite-ps/entity.ejs.t` — bug site (lines 24–26).
- `src/parser/load-entities.ts` — parser already carries `foreign_key`, `target`, `nullable` (lines 59, 87, 138, 261–276).
- `src/schema/entity-definition.schema.*` — destination for the `on_delete` field.
- `runtime/base-classes/BaseRepository.ts` — destination for `activeParentFilter()`.
- Issue #34 — implementation tracker.
