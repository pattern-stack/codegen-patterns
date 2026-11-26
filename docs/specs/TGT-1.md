# TGT-1 — Constraint facts apart from constraint text

**Status:** implemented · **Decision:** ADR-047 · **Issue:** none · **Follows:** TGT-0, TGT-0b

## Problem

TGT-0 split a field's column facts from its column text. The constraints around those columns were still one thing:
`entity-locals.js` worked out each constraint's facts in the same breath as the Drizzle-on-Postgres text that prints
them. The facts are target table, owned or host-owned (#636), names, columns, `on_delete`, partial, NULLS NOT DISTINCT,
tenant scope and the predicate. This applied to the field `foreign_key:` `.references(…)`, `index: true`, `belongs_to`
and junction endpoint FKs, `unique` and `unique_indexes`, and the RFC-0006 composite FKs, `unique(id, …)` targets and
checks. `timestampColumn` was Drizzle text living in `src/schema/`. A second pair could not render a constraint
without reading it back out of Drizzle text.

## Decision

```
YAML ──► constraint facts     src/derived/constraints/    types.ts (ColumnReferenceFact, IndexFact, UniqueFact,
            │                                              ForeignKeyFact, CheckFact), predicate.ts (tokenizePredicate),
            │                                              on-delete.ts (onDeleteAction)
            └─► renderersFor(target).constraints          src/targets/drizzle/postgres/constraints.ts
                   columnReference / index / unique / foreignKey / check / predicate

entity-locals.js and the junction prompt compose facts + text into the SAME records as before
(tableConstraints[].{expr, builder, comment}, processedFields[].drizzleChain, belongsToReferences, …).
```

- **Facts hold no source text.** `src/derived/constraints/types.ts` is types only. Each fact names tables, columns
  and properties. A `where:` predicate and a CHECK are **segments**: `{ text }` copied as written, or
  `{ column, prop }`.
- **`onDeleteAction`** is the one YAML `on_delete:` → SQL referential action mapping. It replaces the entity's
  `mapOnDelete` and the junction's `ON_DELETE_MAP`. `'set null'` is SQL's spelling, so it is a fact.
- **The predicate rules** moved verbatim from `templates/_shared/sql-predicate.mjs` (now deleted) into
  `tokenizePredicate`. The renderer escapes text for a template literal and writes a column as `${tCols.<prop>}`.
  Unquoted text can't contain the escaped characters, so only quoted strings change, exactly as before.
- **The pair decides the builder.** `unique()` returns `{ expr, builder, comment }`. The choices are a partial
  `uniqueIndex(…).where(sql…)`, the `unique()` table constraint for NULLS NOT DISTINCT or a referenced composite-FK
  target, and a plain `uniqueIndex`. Two of those choices exist because of drizzle-orm rc.4 limits. The NULL-tenant
  notes are the pair's too.
- **`timestampColumn`** moved into `drizzle/postgres/columns.ts` and joined `ColumnRenderer`. `field-timestamp.ts`
  keeps the timezone rules.
- **The binding.** `TARGET_RENDERERS` (`src/targets/renderers.ts`) maps each pair to `{ columns, constraints }`. It
  is typed `{ [P in TargetPair]: PairRenderers }`, so `tsc` refuses a row with no renderers. `TARGET_PAIRS` is rows
  only, so the config schema imports no renderer. `renderersFor(target, caller)` holds both refusals: no target, or a
  pair with no renderers. `columnRendererFor` and `constraintRendererFor` are its two halves.
- **Required everywhere.** `processFieldFeatures` takes the constraint renderer as an argument and throws without
  it. `processBelongsTo` keeps its signature. The `belongs_to` `.references` suffixes are a separate local,
  `belongsToReferences[field]`.

## Not moved (named)

| What | Where | Why | When |
|---|---|---|---|
| `external_id_tracking` unique (`uq_<table>_[tenant_]provider_external_id`) | `entity-locals.js`, table-constraints block | the open #917 stack (s7b) rewrites this block | **TGT-1b**, after #917 lands |
| `builder` names on the records (`index`, `unique`, `uniqueIndex`, `foreignKey`, `check`) | read by C3–C5 (`assertDistinctConstraints`) and the Drizzle import set | they are Drizzle's import names; per-pair imports come with the second pair | TGT-2b |
| `PG_IDENTIFIER_MAX_BYTES` (C5, 63 bytes) | `entity-locals.js` | a Postgres fact; becomes per-database with the sqlite pair | TGT-2a |
| The relationship pipeline's constraints (its `ON_DELETE_MAP`, the field `foreign_key` with no FK, the `table.` callback parameter) | `templates/relationship/new/` | that pipeline's copy is cut whole (TGT-0 § Next 2, #679, #942–#944) | with that cut |
| The junction's `primaryKey(…)`; the inherited / `match`-derived column lines | junction template; `entity-locals.js` | column text, not constraints | the behavior-columns TGT-N |

## Proof of byte-identity

- At every commit, unit (render goldens, inheritance DDL, tenant-scoping and column-feature text tests), the
  baseline and the junction snapshots are unchanged. `just test-all` and `just test-integration` pass at the head.
- No pinned output changed: the TGT-0 golden-directory `git diff --stat` against the base is empty.
- New tests that can fail on their own subject:
  - `drizzle-postgres-constraints.test.ts`: every reference, index, unique (plain, NULLS NOT DISTINCT, partial,
    referenced, tenant notes), composite FK and check shape, as exact text;
  - `processFieldFeatures` throws without a renderer;
  - `predicate.test.ts`: every case of the old renderer, unchanged, through the tokenizer and renderer, plus segment
    cases;
  - `on-delete.test.ts`.

## Differs from the plan

- **C4 still reads `builder`**, not a neutral `kind`. The builder names stay on the records for the import set
  anyway, and moving C3–C5 to facts belongs with per-pair imports.
- **The renderer owns the rc.4 decision that a partial unique is never NULLS NOT DISTINCT.** The facts carry the
  requested `nullsNotDistinct` and the `where`; the renderer applies the limit.
- **The kind CHECK's value is now escaped** for a template literal, like every predicate text segment. Enum choices
  hold no backtick, backslash or `${`, so the bytes are the same. A value that did hold one would now compile
  instead of breaking the generated file.
