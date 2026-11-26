# ZOD-0 — Codegen's own code on Zod 4; the generated code unchanged

**Status:** implemented · **Issue:** closes #696 · **Step 1 of 2** (step 2, the generated code on Zod 4, is a major
release on its own timing)

## Problem

Every schema codegen owns (the entity, relationship, junction, event, job and provider YAML schemas, the
`codegen.config.yaml` schema, the library patterns' config schemas) was written on Zod 3. Two symptoms:

- **Editor schemas could not be generated.** `z.toJSONSchema` is Zod 4. The entity schema's generator kept a second,
  hand-copied Zod 4 schema just to call it, which covered seven of the entity's twenty top-level keys and drifted
  (ARCH-1 hand-edited the JSON, #696). TGT-0b added `zod-to-json-schema` to build the config's.
- **Codegen and the apps it emits were tied to one Zod.** The emitted code (`runtime/`, `templates/`) runs in the
  consumer's app on the consumer's `zod`, so codegen's own code could not move without moving theirs.

## Decision

Two Zods, one boundary, held by a test (`src/__tests__/schema/zod-boundary.test.ts`):

| Code | Zod | Imported as |
|---|---|---|
| Codegen's own code: `src/schema/*`, `src/config/project-config.ts`, `src/utils/yaml-loader.ts`, the Studio server, the library patterns | **Zod 4** (4.6) | `import { z } from '<…>/schema/zod'`, the only importer of the `zod4` dependency |
| What emitted apps import: `runtime/**`, `templates/**` (and the generators that print `import { z } from 'zod'` as text) | **Zod 3** | `zod`, unchanged |
| A pattern's `configSchema` (consumer-authored app patterns, ADR-031) | **the author's** | `PatternConfigSchema<T>` (`src/patterns/pattern-definition.ts`): structural (`safeParse` → `{ success, data }` or `{ error: { issues } }`), so a Zod 3 schema and a Zod 4 schema both satisfy it |

- **`zod4` is an npm alias, `"zod4": "npm:zod@^4.6.7"`**, beside `"zod": "^3.22.4"`. Zod 3.25 also ships an early Zod 4
  at `zod/v4`; it was tried first and rejected, because it differs from current Zod 4 in exactly the places the
  generator's error reports lean on (measured in this repo, 2026-11-26):
  - an unknown key under `.strict()` **aborts** its object, so the object's `refine`/`superRefine` rules are skipped
    and a file with a typo'd key and a cross-key mistake reports only the typo;
  - a `z.union` whose matching option fails reports one `invalid_union` ("Invalid input") instead of that option's
    issue (`'inherits' must name an entity in snake_case` became `Invalid input`);
  - an `.optional()` key whose value has issues is **dropped** from the parsed object, so a cross-key rule reading it
    sees it absent (the junction's `fields:` rules went silent).

  Zod 4.6 behaves as Zod 3 did on all three, so no compatibility code is needed.
- **`src/schema/zod.ts` is codegen's Zod.** It re-exports `z` from `zod4` and installs one message rule with
  `z.config` (global to the `zod4` copy, which only codegen imports): an enum refusal names the value it refused,
  `Invalid option: expected one of "string"|"integer"|…, received "strng"`. Every other message is Zod 4's own wording
  or codegen's `message:` text. Step 2 changes this file's import and nothing else.
- **A runtime Zod 3 schema inside a codegen Zod 4 schema** goes through `fromZod3` (`src/schema/zod3-schema.ts`): the
  value parses with the runtime's own schema (one owner, its defaults and messages), and each Zod 3 issue passes up
  with its code, message and `keys`. Today: `DetectionConfigSchema` under an entity's `detection:` and a job arm's
  `read:`. Delete it in step 2.

## What changed in the schemas

- `.default({})` on an object block → **`.prefault({})`**. Zod 4's `.default` returns its value as-is; Zod 3 parsed it,
  so `paths: {}` picked up `backend_src`'s default. `.prefault` is Zod 3's `.default`. Fully-spelled defaults are
  unchanged.
- One-argument `z.record(v)` → `z.record(z.string(), v)`.
- `errorMap` / `invalid_type_error` → `error`. `ctx.data` → `issue.input`.
- `ZodError.errors` → `.issues`. `project-config.ts`'s `unwrap` reads Zod 4's classes (`ZodPrefault`, `ZodPipe.in`)
  instead of `ZodEffects` / `_def.innerType`.

## The editor schemas

One converter, `editorJsonSchema` (`src/schema/editor-json-schema.ts`): `z.toJSONSchema`, input side (a key with a
default is optional), draft 07 (what yaml-language-server and `ajv` read without setup), inlined.

- **`entity-definition.schema.json`** is generated from the real `EntityDefinitionSchema`
  (`src/schema/entity-definition.json-schema.ts`, `just gen-entity-schema`). The hand copy is deleted. Against the
  old file: all twenty top-level keys instead of seven (`analytics`, `api`, `detection`, `eav*`, `emits`, `events`,
  `generate`, `integration`, `queries`, `roles`, `tenant_scoped` are new), every `entity:` / field / relationship key
  the schema declares, and unknown top-level keys refused (`additionalProperties: false`; the copy accepted them).
  The copy's 47 hover descriptions now live on the real schema as `.describe()`. Two things the copy offered that
  the schema does not: the behavior names as a closed list (`behaviors:` takes any string; the generator checks the
  names elsewhere), and `detection:` values beyond "an object" (they are the runtime's Zod 3 schema). A test fails
  when the committed file and a fresh build differ, and runs every fixture entity the generator accepts through the
  JSON Schema too (`entity-definition-json-schema.test.ts`).
- **`codegen-config.schema.json`** (TGT-0b) switches converter; `zod-to-json-schema` is gone. Against
  `zod-to-json-schema`'s output: `target` is unchanged (per-pair `const` + description, `additionalProperties:
  false`); integers carry Zod 4's safe-integer bounds; records state `propertyNames: string`; and `frontend.auth`,
  `frontend.catalog` and `frontend.sync` no longer carry `additionalProperties: false`, because they are
  non-strict objects that the generator strips, not refuses. The old file underlined keys the generator accepts.

## Zod's own wording (decision d8, codegen-targets board)

Zod 4 words its default messages differently: `Invalid input: expected string, received number` for
`Expected string, received number`; `Unrecognized key: "config"` for `Unrecognized key(s) in object: 'config'`;
`Invalid input: expected array, received undefined` for `Required`. Codegen takes Zod 4's wording (a compatibility
error map would be the shim the repo rules out); the tests that pinned Zod 3's wording now pin Zod 4's. Every message
codegen wrote itself is unchanged. Studio no longer reads unknown keys out of the message text: the server passes
Zod's `issue.keys` through (`ZodIssueLike.keys`) and `yaml-issues.ts` reads that.

## Proof

- Every golden and snapshot is byte-identical (`test/baseline`, `test/render-golden`, `test/frontend-golden`,
  `test/frontend-graph-golden`, `test/api-surface-golden`, the junction and integration-emit snapshots): `just
  test-all` and `just test-integration` pass with no golden change, and the PR diff touches no file under `test/`
  outside `test/studio/run-studio-e2e.ts` (its expected issue code, `invalid_enum_value` → `invalid_value`).
- The pattern `configSchema` tests run once with a Zod 3 schema and once with a Zod 4 one.

## Step 2 (not here)

Move `runtime/` and `templates/` to Zod 4: the generated DTOs, `ListQuerySchema`, the detection schema and the event
schemas. Consumers then need Zod 4, so it is a major. Then `zod` becomes `^4`, `src/schema/zod.ts` imports `zod`,
`zod4` and `fromZod3` are deleted, and `PatternConfigSchema` can become Zod 4's type if consumer patterns are Zod 4 too.
