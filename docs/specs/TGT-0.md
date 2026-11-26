# TGT-0 — Field facts apart from column text, and a target key with one value

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
                  ├─► COLUMN_RENDERERS[target.data]   src/targets/columns.ts
                  │      └─ 'drizzle-pg' → drizzleType, drizzleChain, tsType   src/targets/drizzle-pg/columns.ts
                  └─► zodValueFor(facts)               entity-locals.js (Zod is shared by every target)

processFields(fields, { entityName, enumResolver, columns }) = facts + render(facts) + zodType
```

| Piece | Holds | Never holds |
|---|---|---|
| `FieldFacts` (`src/derived/columns/types.ts`) | `name`, `camelName`, `type`, `elementType`, `isArray`, `nullable`, `required`, `hasDefault`, `default`, `withTimezone`, `choices`, `hasChoices`, `enumName`, `enumDbName`, `enumImport`, `minLength`, `maxLength` | builder text, Zod chains, TypeScript type strings, SQL |
| `drizzlePgColumns` (`src/targets/drizzle-pg/columns.ts`) | the type maps, `buildDrizzleChain`, `renderColumnDefault`, `varcharColumn`, the select-model `tsType`, and `importFor(builder)` (the `pg-core` import a builder needs, read by `collectDrizzleImports`) | facts it could derive itself |
| `target:` (`codegen.config.yaml`) | `{ data: drizzle-pg }`, the default and only value | any other axis (ADR-047 §2) |

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
- **The target is required.** `prompt.js` passes `target: getProjectConfig().target`, the way it passes
  `behaviorsTimezone`. `buildBackendLocals` and the junction prompt call `columnRendererFor(target, caller)`, which
  throws on an absent or unknown value. Test helpers spread `PROJECT_CONFIG_LOCALS`, which carries
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
  - an absent or unknown target throws, in `columnRendererFor`, `processFields` and `buildBackendLocals`.
- **`src/__tests__/config/project-config.test.ts`** covers the key:
  - the `target:` default;
  - an unknown value;
  - an unknown axis (`target.composition`);
  - a bare string.

## Differs from the plan

- **The relationship pipeline keeps its own field processor.** It was planned to share the facts and the renderer,
  but its copy (`templates/relationship/new/prompt.js`, `processFields` / `buildDrizzleChain`) differs from the
  entity one in output:
  - `decimal` is typed `number` and validated `z.number()`, though Drizzle returns `numeric` as a string;
  - `date` is built without `mode: 'date'`, but typed `Date`;
  - `json` is `z.record(z.unknown())`;
  - a field with `choices:` is a plain `text` column with no enum.

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
2. **The relationship pipeline's copy.** Decide on its decimal, date, json and choices differences, then make it
   read the shared facts. Until then it is drizzle-pg only and does not go through the target: it imports
   `renderColumnDefault` / `varcharColumn` from `src/targets/drizzle-pg/columns.ts` directly and keeps its own
   `DRIZZLE_IMPORT_MAP`.
3. **A second `DataTarget`.** It needs its renderer, plus the parts of the repository template and the base classes
   that are typed on `PgTable`.
