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
(tableConstraints[].{expr, builder, comment}, processedFields[].drizzleChain, belongsToReference(field), …).
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
  it. `processBelongsTo` keeps its signature. The `belongs_to` `.references` suffixes come from a local
  function, `belongsToReference(field)`, which throws when one is missing (never an FK-less column).

## Not moved (named)

| What | Where | Why | When |
|---|---|---|---|
| `external_id_tracking` unique (`uq_<table>_[tenant_]provider_external_id`) | `entity-locals.js`, table-constraints block | the open #917 stack (s7b) rewrites this block | **TGT-1b**, after #917 lands |
| `builder` names on the records (`index`, `unique`, `uniqueIndex`, `foreignKey`, `check`) | read by C4 (`assertDistinctConstraints`, which also checks every record has one) and the Drizzle import set | they are Drizzle's import names; per-pair imports come with the second pair | TGT-2b |
| `PG_IDENTIFIER_MAX_BYTES` (C5, 63 bytes) | `entity-locals.js` | a Postgres fact; becomes per-database with the sqlite pair | TGT-2a |
| The relationship pipeline's constraints (its `ON_DELETE_MAP`, the field `foreign_key` with no FK, the `table.` callback parameter) | `templates/relationship/new/` | that pipeline's copy is cut whole (TGT-0 § Next 2, #679, #942–#944) | with that cut |
| The junction's `primaryKey(…)`; the inherited / `match`-derived column lines | junction template; `entity-locals.js` | column text, not constraints | the behavior-columns TGT-N |

## Proof of byte-identity

- At every commit, unit (render goldens, inheritance DDL, tenant-scoping and column-feature text tests), the
  baseline and the junction snapshots are unchanged. `just test-all` and `just test-integration` pass at the head.
- No pinned output changed: the TGT-0 golden-directory `git diff --stat` against the base is empty.
- New tests that can fail on their own subject:
  - `drizzle-postgres-constraints.test.ts`: every reference, index, unique (plain, NULLS NOT DISTINCT, partial,
    referenced), composite FK and check shape as exact text, the tenant notes by their key phrase, and the refusal of
    a partial NULLS NOT DISTINCT;
  - `processFieldFeatures` throws without a renderer;
  - `predicate.test.ts`: every case of the old renderer, unchanged, through the tokenizer and renderer, plus segment
    cases;
  - `on-delete.test.ts`.

## Differs from the plan

- **`processFieldFeatures` composes; it does not return facts.** The plan had it return facts for a later
  composition step. It takes the renderer instead and returns the same rendered records as before, because nothing
  yet reads the facts apart from their text, and a key nothing reads is deleted (CLAUDE.md). Its facts are built
  and handed to the renderer in place.
- **C4 still reads `builder`**, not a neutral `kind`. The builder names stay on the records for the import set
  anyway, and moving C4 to facts belongs with per-pair imports.
- **A partial unique is never NULLS NOT DISTINCT**, decided in the composer as before, so the fact says what the
  database enforces. The drizzle/postgres renderer refuses the combination (rc.4 can't write one) rather than
  silently dropping it.
- **The kind CHECK's value is now escaped** for a template literal, like every predicate text segment. The bytes
  can't change: the value is `inherits.as` or the entity name, both snake_case by schema
  (`entity-definition.schema.ts`, `SNAKE_NAME_PATTERN`).
- **No fixture round-trip of every `where:`.** The old renderer's unit cases moved unchanged, and the goldens and the
  column-feature / tenant-scoping text tests pin every `where:` the fixtures use.
- **`constraintRendererFor`'s refusals are tested through `renderersFor`** (via `columnRendererFor`, the same
  function); it has no refusal test of its own.

## Review (2026-11-26, /sdlc:review, Gate 2.5)

Joined verdict **PASS_WITH_NOTES**, 0 blockers. Adherence: PASS_WITH_NOTES (3 notes, 7 nits), with byte identity
confirmed by the unit suite at the base, every intermediate commit and the head. Quality: PASS_WITH_NOTES (5 notes,
8 nits). Fixed in the same PR: the partial-unique fact, `ColumnReferenceFact.targetProp` (it is printed as a
property), the on-delete map keyed by the schema's `OnDelete` enum (the SQL type renamed `ReferentialAction`),
`types.ts`'s rule on SQL text, a predicate test that asserted nothing, and stale mentions. Left by name:
- the junction prompt's `on_delete_left` / `on_delete_right` read (the junction schema is strict and declares
  neither, so both are always `restrict`; a separate change adds the keys or deletes the read);
- a field `foreign_key:` to a snake_case target column prints the column as a property (pre-existing; above);
- nits on the renderer interface's shape (`predicate` is used only through `unique` / `check` and tests, index
  names are built at four sites) — for the second pair to shape (ADR-047 decision 8).
