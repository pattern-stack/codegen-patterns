# ZOD-1 — The generated code on Zod 4

**Status:** ZOD-1a implemented; ZOD-1b planned · **Follows:** ZOD-0 (#945) · **Plan:** codegen-targets
`docs/PLAN-zod4-generated.md`

ZOD-0 moved codegen's own code to Zod 4 and left the emitted side (`runtime/**`, the `.ejs.t` templates' text) on
Zod 3. ZOD-1 moves the emitted side. In a full codegen project codegen owns the app's dependencies, so the move is a
breaking release (0.35.0, decision d15) with migration notes. It ships in two PRs:

- **ZOD-1a (this PR):** the generated code is still Zod 3. It fixes a Zod 4 behaviour difference ahead of the move, so
  the fix reads apart from the golden churn.
- **ZOD-1b:** `zod ^4`, the runtime and templates on Zod 4, native OpenAPI, `z.guid()` (d14), Zod 4's issue codes in
  400 bodies (d17), ZOD-0's scaffolding deleted, migration notes, and the version bump.

## ZOD-1a: a PATCH leaves an omitted field as it is

### Problem

Every update DTO was built from the create schema: `Create.partial()` (a family base: `Create.omit({ kind }).partial()`;
a family child: its own `Create.partial()`, where its create extends the base's create). A create chain that fills a
default when the field is omitted (today, a boolean with a YAML `default:`: `z.boolean().default(false)`) is
carried into the update. Zod 3 ignores a `.default()` inside `.optional()`, so `Update.parse({})` is `{}`. Zod 4
applies it, so `Update.parse({})` is `{ active: true }`, and a PATCH that leaves `active` out would reset it.
Measured on zod 4.6.7.

### Decision

- **One rule says which create chains apply a default:** `createChainAppliesDefault(field)` (`entity-locals.js`, and
  the relationship pipeline's copy in `relationship/new/prompt.js`, which has its own chain helpers). The create
  chain reads it to add `.default(…)`, and the update reads it to restate exactly those fields.
- **`zodChainForUpdate(field)`** is the create chain made optional, without its default. It accepts exactly what
  `Create.partial()` accepted for the field: a defaulted boolean was never `.nullable()` on create, so it isn't on
  update either.
- **The update DTO** (entity and relationship) stays `Create.partial()` and adds
  `.extend({ <defaulted fields, update chains> })` when there are any. With none, the bytes are unchanged, as they are
  for every baseline entity today.
- **A family child's update extends its base's update** (`UpdateToteSchema.extend({ <child fields, update chains> })`),
  as its create extends the base's create (RFC-0006 §5). The base's update then owns the base's fields, defaults
  included. The field set is what it was: base fields without the kind, plus the child's own, all optional.
  `familyReads` gains `baseUpdateSchema` / `baseUpdateImportPath`.

### Proof

- `src/__tests__/backend/update-dto-defaults.test.ts` loads the generated DTOs of the render-matrix case
  `matrix-update-defaults` (a plain entity, a family base and its child, each with a defaulted boolean) and parses
  them once with `zod` (Zod 3) and once with Zod 4:
  - `Update.parse({})` is `{}`;
  - a set field passes through;
  - `null` is refused where `Create.partial()` refused it;
  - the relationship update the template prints parses `{}` to `{}`.
- Golden changes:
  - the two family children's update DTOs in the baseline (`email`, `meeting`) and three in the render goldens
    (`crate`, `air_freight`, `sea_freight`): `Create.partial()` → `BaseUpdate.extend({…})`;
  - the new `matrix-update-defaults` case (render goldens plus its two API-surface snapshots).

  Nothing else changes.

### Found while implementing

- **A boolean's DTO default was always `false`.** `processFields` (both pipelines) carried `hasDefault` but not the
  value, so `.default(${field.default ?? false})` printed `false` even for `default: true`, while the Drizzle column
  said `.default(true)`. A create that omitted the field stored `false`. Fixed in this PR as its own commit: the
  record carries `default`. No fixture had a `default: true` boolean, so no golden changed except the new case.

## ZOD-1b

See the plan. This section becomes the as-built record when ZOD-1b lands.
