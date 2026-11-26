# TGT-0 — Field facts apart from column text, and the `target: { database, orm }` key

**Status:** implemented · **Decision:** ADR-047 · **Issue:** none

## Problem

`processFields` (`templates/entity/new/backend/entity-locals.js`) turned a field's YAML into one record that held
three kinds of thing at once:
- **facts** about the field: name, type, nullability, default, enum names, length bounds;
- the **Drizzle-on-Postgres column builder** (`drizzleType`, `drizzleChain`);
- the **Zod and TypeScript type text** (`zodType`, `tsType`).

No second target could render a field without copying the facts out of a Drizzle-shaped record. And the project had
no way to say which target it is.

## Decision

The record is now composed from two parts, and a config key picks the second:

```
YAML field ──► deriveFieldFacts()                src/derived/columns/fields.ts   (pure: no Drizzle, no Zod)
                  ├─► columnRendererFor(target)        src/targets/columns.ts (COLUMN_RENDERERS, from TARGET_PAIRS)
                  │      └─ 'drizzle/postgres' → drizzleType, drizzleChain, tsType, importFor
                  │                                     src/targets/drizzle/postgres/columns.ts
                  └─► zodValueFor(facts)               entity-locals.js (Zod is shared by every target)

processFields(fields, { entityName, enumResolver, columns }) = facts + render(facts) + zodType
```

| Piece | Holds | Never holds |
|---|---|---|
| `FieldFacts` (`src/derived/columns/types.ts`) | `name`, `camelName`, `type`, `elementType`, `isArray`, `nullable`, `required`, `hasDefault`, `default`, `withTimezone`, `choices`, `hasChoices`, `enumName`, `enumDbName`, `enumImport`, `minLength`, `maxLength` | builder text, Zod chains, TypeScript type strings, SQL |
| `drizzlePostgresColumns` (`src/targets/drizzle/postgres/columns.ts`) | the type maps, `buildDrizzleChain`, `renderColumnDefault`, `varcharColumn`, the select-model `tsType`, and `importFor(builder)` (the `pg-core` import a builder needs, read by `collectDrizzleImports`) | facts it could derive itself |
| `TARGET_PAIRS` (`src/targets/pairs.ts`) | the supported `(orm, database)` pairs, each with its descriptions and renderer — the one list | a pair without a renderer |
| `target:` (`codegen.config.yaml`) | `{ database: postgres, orm: drizzle }`, the default and only supported pair | `http`, `wiring`, `runtime` or a driver (ADR-047 §5–6) |

- **`tsType` is rendered by the target.** It is TypeScript, but its values are the data layer's: `decimal` is
  `string` because Drizzle returns pg `numeric` as a string, and `date` is `Date` because the builder is written
  `mode: 'date'`.
- **Zod stays shared.** Every target validates the same payloads, and the Zod 4 move rewrites that mapping
  separately.
- **One owner per rule, moved rather than copied:**
  - `stringLengthBounds` now sits beside the rule that validates the keys, in `src/schema/field-length.ts`.
  - `enumTypeNames` (an enum's database and export names) now sits with the other name rules, in
    `src/derived/api/names.ts`, which `templates/_shared/inheritance.mjs` imports.
  - The relationship prompt imports `renderColumnDefault` / `varcharColumn` from the renderer.
- **One table of pairs.** `TargetConfigSchema` is a union of strict per-pair objects derived from `TARGET_PAIRS`,
  with each key's literal described for editors. `COLUMN_RENDERERS` is built from the same rows. Both the schema and
  `columnRendererFor` refuse a pair the table lacks, naming the supported pairs. A written `target:` needs both keys;
  a missing one says so. `src/__tests__/targets/target-pairs-docs.test.ts` holds the "Supported pairs:" lists in the
  README, the consumer setup guide and the codegen skill to the table.
- **The target is required.** `prompt.js` passes `target: getProjectConfig().target`, the way it passes
  `behaviorsTimezone`. `buildBackendLocals` and the junction prompt call `columnRendererFor(target, caller)`, which
  throws on an absent target or an unsupported pair. Test helpers spread `PROJECT_CONFIG_LOCALS`, which carries
  `DEFAULT_CODEGEN_CONFIG.target`.
- **Deleted:** `behaviorRegistry`, `resolveBehaviors` and `normalizeBehaviorConfig` in
  `templates/entity/new/prompt.js`. Nothing called them; the live registry is `src/behaviors/`.

## Invariants (charter §4)

- **I1, declare once.** Facts come from the YAML through one function. Nothing reads generated output.
- **I2.** Every generated file is still complete and `@generated`. No template changed.
- **I7, no backwards compatibility.** There are no re-exports at the helpers' old paths; every importer was moved.
  `processFields` takes an options object in place of its positional parameters.
- **I9, honest gates.** Every golden passes unchanged. The new tests can fail on their own subject (below).
- **I10.** No consumer is named.
- **I11.** `templates/entity/new/backend/` is still the one backend pipeline.

## Proof of byte-identity

- **No pinned output file changes.** `git diff --stat origin/main --` over `test/baseline`, `test/render-golden`,
  `test/api-surface-golden`, `test/frontend-golden`, `test/frontend-graph-golden`, `test/relations-golden`,
  `test/semantic-golden`, `test/junction/__snapshots__` and `test/integration-emit/__snapshots__` is empty.
- **`just test-all` passes** with no update flag set.
- **The full record is unchanged.** For a 16-field matrix (every type, bounded strings, each kind of default, both
  time zones, arrays, enums and an enum array), `processFields` on `main` and on this branch print the same record
  JSON, key for key and in the same order.
- **`src/__tests__/derived/columns/field-facts.test.ts`** keeps that matrix as a test:
  - each field's `[drizzleType, drizzleChain, tsType]` as `main` rendered it;
  - no fact carries source text;
  - every pair in `TARGET_PAIRS` parses, has a renderer and renders every field shape;
  - a pair not in the table is refused by the schema and by `columnRendererFor`;
  - an absent target throws, in `columnRendererFor`, `processFields` and `buildBackendLocals`.
- **`src/__tests__/config/project-config.test.ts`** covers the key:
  - the `target:` default;
  - an unsupported pair, on either key, with the message naming the supported pairs;
  - a missing key;
  - a premature key (`target.http`);
  - a bare string.

## Differs from the plan

- **The relationship pipeline keeps its own field processor.** It was planned to share the facts and the renderer,
  but its copy (`templates/relationship/new/prompt.js`, `processFields` / `buildDrizzleChain`) differs from the
  entity one in output:
  - `decimal` is typed `number` and validated `z.number()`, though Drizzle returns `numeric` as a string;
  - `date` is built without `mode: 'date'`, but typed `Date`;
  - `json` is `z.record(z.unknown())`;
  - a field with `choices:` gets its own `pgEnum` (named `<relationship>_<field>`), but the template declares it
    beside the column rather than through `drizzleChain`. Its exported const is `<field>Enum`, not namespaced by the
    relationship as the entity pipeline's is (`enumTypeNames`).

  Sharing the entity's rules would change those bytes, which is a behaviour change and not this refactor. The copy is
  the next cut, alongside #679, which collapses `relationship:` into the junction concept. Its first two differences
  look like bugs.
- **Constraints are not moved.** `processFieldFeatures` still appends `.references(…)` to `drizzleChain` in place
  and builds `index(…)` text. `processUniqueIndexes` and the table-constraints block are unchanged. They are the next
  `TGT-N`: the constraint facts (target table, owned or host-owned, index columns) are already resolved there and need
  the same split.
- **`src/behaviors/*.ts` still carry `drizzleType` / `zodType` / `drizzleImports`.** Only tests read them
  (`resolveBehaviors`, `resolveBehaviorDrizzleImports`), and an open stack is editing those files, so they are left
  for a follow-up and not deleted here.

## Next

1. **Constraints.** Split FK, index, unique and check facts from their text (`processFieldFeatures`,
   `processUniqueIndexes`, the constraints block), and move `timestampColumn`
   (`src/schema/field-timestamp.ts`) behind the renderer.
2. **The relationship pipeline's copy.** Decide on its decimal, date, json and enum-naming differences, then make it
   read the shared facts. Until then it is `drizzle/postgres` only and does not go through the target: it imports
   `renderColumnDefault` / `varcharColumn` from `src/targets/drizzle/postgres/columns.ts` directly and keeps its own
   `DRIZZLE_IMPORT_MAP`.
3. **A second pair** (`{ database: sqlite, orm: drizzle }`). It needs a row in `TARGET_PAIRS`, its renderer at
   `src/targets/drizzle/sqlite/columns.ts`, and the parts of the repository template and the base classes that are
   typed on `PgTable`.
4. ~~A JSON Schema for `codegen.config.yaml`~~: done in TGT-0b, below.

## TGT-0b — the pair, and editor completion (2026-11-26)

#940 merged `target: { data: drizzle-pg }`. The pair amendment was written before the merge and landed after it, so
it ships as its own PR, together with the editor schema:

- **The pair.** `target: { database: postgres, orm: drizzle }`, read from `TARGET_PAIRS` (ADR-047 as revised). No
  release carried `data:`, so it gets no shim: it is an unknown key, and the same parse error asks for `database` and
  `orm`, naming the supported pairs (`codegen-config-json-schema.test.ts` refuses it in both schemas).
- **`src/schema/codegen-config.schema.json`**, generated from `CodegenConfigObjectSchema` by
  `src/schema/codegen-config.json-schema.ts` (`just gen-config-schema`), shipped in `files` and checked by the tarball
  smoke. Consumers point `# yaml-language-server: $schema=…` at it (`docs/CONSUMER-SETUP.md` › Editor completion).
  - It describes the file as written: keys with defaults are optional, and the `patterns` default is not in it.
    Refinements that span keys (`superRefine`) are not expressible, so the generator's parse stays the gate.
  - `zod-to-json-schema` (a devDependency) converts while the repo is on Zod 3. The entity schema's generator still
    restates its shapes by hand on `zod/v4` (#696), which is out of scope here.
- **Ready for a second row.** `targetConfigSchemaFor(pairs)` builds `target:` from any pair table: one strict object
  for one row, or a `z.union` for more, whose single `invalid_union` issue gets a message worked out from the value.
  The message says the same things the one-row schema says per key: unknown key, both keys required, or not a
  supported pair, naming the pairs. The loader's `unknown key (expected one of: …)` hint reads a union's keys
  (`objectSchemaKeys`). `TargetConfig` is one member per row, never the cross product. `target-config-schema.test.ts`
  holds all of this over a two-row table.
- **Tests.** The committed file equals a fresh build. The `target` alternatives equal the table's rows, with their
  descriptions. Every row passes both schemas, and every off-table pair fails both. Every config the generator
  writes (fixtures, subsystem blocks, `project init`, `project scan`) passes the JSON Schema as well as the parse.
- Byte-identical: no golden or snapshot changes.
