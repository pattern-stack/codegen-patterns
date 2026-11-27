# ADR-047 — The generation target: `target: { database, orm }`, one table of supported pairs

**Status:** Accepted
**Date:** 2026-11-25 (revised 2026-11-26 by TGT-0b, after #940 merged with `target: { data: drizzle-pg }`: the pair
shape, and the config JSON Schema)
**Owner:** Doug
**Related:** ADR-046 (derived once, templates print — the `columns/` slot), ADR-037 (runtime mode, the precedent
for a project-level switch resolved once), ADR-008 (core contract + opt-in extensions), CFG-0 (strict config)
**Specs:** `TGT-N` — TGT-0 (`docs/specs/TGT-0.md`) is the first

---

## Context

The generator writes one kind of app: NestJS modules over Drizzle on Postgres. Several separable choices are fused
in that output:

- the **database** (Postgres);
- the **ORM** the tables, columns and repositories are written in (Drizzle);
- the **wiring**: how the pieces are composed (Nest's DI container and per-entity modules);
- the **HTTP** layer (Nest controllers);
- the **runtime** (Node).

There is no switch for any of them. ARCH-0 and ARCH-1 deleted the last architecture switch (`generate.architecture`,
`database:`) because it selected a pipeline nobody maintained, not because a choice is wrong. A second data layer is
now wanted: Drizzle on SQLite, for a host application with no Postgres and no HTTP. Before anything can render it,
the field model has to stop holding one target's text (TGT-0 splits it). And the project needs somewhere to say which
target it is.

## Decision

1. **`target:` in `codegen.config.yaml` is one object with a key per choice.** Today:

   ```yaml
   target:
     database: postgres   # default
     orm: drizzle         # default
   ```

2. **The data layer is two keys, and they are validated as a pair.**
   - Database and ORM vary separately: Drizzle on SQLite changes the database and keeps the ORM; Kysely on Postgres
     would do the reverse. So each gets its own key, and neither is folded into a combined name such as
     `drizzle-pg`.
   - The column text belongs to the **pair**: Drizzle's `pg-core` and `sqlite-core` builders differ. So the pair
     selects the renderer.
   - Not every combination of a supported database and a supported ORM is a supported pair.
3. **One table, `TARGET_PAIRS` (`src/targets/pairs.ts`), is the only list of supported pairs.** Everything else
   derives from it:
   - The **config schema** is a union of the supported pairs, one strict object per row with each key described
     (`TargetConfigSchema`). Validation, and the editor completion built from that schema, offer exactly the
     supported pairs.
   - The **renderer table** (`COLUMN_RENDERERS`, `src/targets/columns.ts`) is the rows' renderers. A row is a pair
     *with* its renderer, so a pair cannot be accepted without one.
   - An **unsupported pair** is refused by the schema and by `columnRendererFor`, and both refusals name the
     table's rows.
   - The **docs** that list the pairs ("Supported pairs:" in the README, the consumer setup guide and the codegen
     skill) are held to the table by a test.
4. **A pair is added when its renderer exists and passes the same gates.** It is added as a row, never anywhere
   else. The default pair is the first row.
5. **`http`, `wiring` and `runtime` join `target:` when they have a second value.** Until then each is an unknown key
   (CFG-0 strict), so a misspelled or premature key is an error, not a silent default.
6. **The driver has no key.** node-postgres, `bun:sqlite` and the like follow from `database` plus `runtime`. A
   `driver` key is added only when someone needs to override that.
7. **Resolved once, required everywhere.** The hygen prompts read `target` from the parsed config, as
   `behaviorsTimezone` is read, and pass it into the locals. Every consumer that needs a renderer
   (`buildBackendLocals`, the junction prompt) throws on an absent target. A missing target means the caller skipped
   the prompt, and is never a reason to fall back to the default renderer.
8. **The renderer interface is what the one renderer needs.** `RenderedColumn` (`drizzleType` / `drizzleChain` /
   `tsType`) and `importFor` are the keys the templates print. They are not generalised until a second pair's
   renderer shows what the two share. Guessing that shape now would be the uniform interface CLAUDE.md warns against.
9. **`project init` does not write the key.** The schema owns the default, so a project names a target only when it
   wants a non-default one. When written, both keys are required.

## Consequences

- A second pair is a row in `TARGET_PAIRS`, a renderer at `src/targets/<orm>/<database>/columns.ts`, and the
  templates and base classes that renderer needs. It is never a fork of `entity-locals.js`, and never an edit to the
  schema, the docs list or the error text.
- `src/derived/api` does not read the target yet; no derived name depends on it. When wiring gets a second value, the
  `*Module` / `*Controller` class names (`src/derived/api/names.ts`) start to depend on it, and the derivation takes
  the resolved target as an **input**. The target is never a fact inside the derivation.
- The split is incremental. TGT-0 moves only the field column builder and its imports. The constraints (FK
  `.references`, indexes, uniques, checks), behavior columns, relations manifest, semantic model, repositories and base
  classes are still Drizzle-on-Postgres text outside `src/targets/`. Each moves in its own `TGT-N`.
- **Editor completion reads the same union (TGT-0b).** `src/schema/codegen-config.schema.json` is generated from
  `CodegenConfigObjectSchema` (`buildCodegenConfigJsonSchema`, `just gen-config-schema`) and ships in the package, so
  an editor pointed at it offers only the supported pairs, with each key's description, and underlines any other.
  A unit test fails when the committed file and a fresh build differ, so a new row cannot reach the editor late. Tests
  run every row, and every off-table pair, through both the Zod schema and the JSON Schema (ajv). The converter is
  Zod 4's `z.toJSONSchema` (ZOD-0).

## Revision — 2026-11-26 (TGT-0b)

#940 merged the first shape, `target: { data: drizzle-pg }`. TGT-0b replaced it with the pair before any release
carried it (0.34.0 predates #940), so there is no shim: `data:` is an unknown key, and the same error asks for
`database` and `orm` and names the supported pairs.

## Revision — 2026-11-26 (ZOD-0)

Codegen's own schemas moved to Zod 4 (`docs/specs/ZOD-0.md`), so the config's JSON Schema is built by Zod's own
`z.toJSONSchema` and `zod-to-json-schema` is gone. `target:` reads the same in it: one strict object per pair, its
keys `const` and described.

## Alternatives rejected

- **One combined string** (`target: nest-drizzle-pg`, or `data: drizzle-pg`). It multiplies with every choice, and
  its parts can't be validated, described or defaulted separately.
- **Independent enums with no pair check.** These would accept `{ database: sqlite, orm: drizzle }` before a
  renderer exists for it.
- **A template-root switch** (a second `templates/entity/new-<target>/` tree). This duplicates every decision the
  locals builder makes; the problem is who renders text, not which tree prints it (ADR-046 rejected the same move).
- **Detecting the target** from the project (the scanner already guesses a framework and an ORM). A guess is not a
  declaration, and the scanner's result feeds nothing today.

## Revision — 2026-11-26 (TGT-1)

- **A row carries no renderer.** Decision 3 said a `TARGET_PAIRS` row is "a pair *with* its renderer". TGT-1 adds a
  second renderer per pair (constraints), so the binding moved to `TARGET_RENDERERS` (`src/targets/renderers.ts`),
  typed `{ [P in TargetPair]: PairRenderers }`. The guarantee is the same, and now `tsc` checks it: a pair can't be
  accepted without its renderers. `TARGET_PAIRS` is rows only, so the config schema imports no renderer code.
  `COLUMN_RENDERERS` is gone; `renderersFor(target, caller)` holds the refusals.
- **Constraints are behind the target.** Their facts are in `src/derived/constraints/`, and the text is each pair's
  `constraints.ts` (`docs/specs/TGT-1.md`). The `external_id_tracking` unique follows in TGT-1b.
- **Decision 8 holds for constraints too.** `ConstraintRenderer` is what drizzle/postgres needs and the templates
  print (`columnReference`, `index`, `unique` → `{ expr, builder, comment }`, `foreignKey`, `check`, `predicate`); it
  is not generalised until a second pair's renderer shows what the two share. Decision 4's facts/text line is
  unchanged: SQL every SQL pair shares (a referential action's spelling, a predicate's text) is a fact; builder and
  template syntax is text.

## Revision — 2026-11-26 (TGT-2a)

- **A pair's renderers can exist before its row.** `ColumnRenderer` / `ConstraintRenderer` are generic over the pair
  key, so `drizzle/sqlite` is built and tested (`docs/specs/TGT-2a.md`) while `TARGET_PAIRS` still has one row.
  Decision 4 holds: the row lands with the templates that print the text and pass the same gates (TGT-2b).
- **A database-level renderer sits beside the pair renderers.** SQLite DDL (`src/targets/sqlite/`) depends on the
  database, not the ORM. Any ORM on SQLite shares it, and the DDL ↔ Drizzle parity gate holds the two together.
- **Drizzle text the dialects share** (`sql` predicates, `index`, `foreignKey`, `check`) lives once in
  `src/targets/drizzle/shared.ts`.
