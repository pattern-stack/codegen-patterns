# ZOD-0 — Codegen's own code on Zod 4; the generated code unchanged

**Status:** implemented · **Issue:** closes #696 · **Step 1 of 2** (step 2, the generated code on Zod 4, is a major
release that follows this directly: in a full codegen project codegen owns the app's dependencies)

## Problem

Every schema codegen owns (the entity, relationship, junction, event, job and provider YAML schemas, the
`codegen.config.yaml` schema, the library patterns' config schemas) was written on Zod 3. Two symptoms:

- **Editor schemas could not be generated.** `z.toJSONSchema` is Zod 4. The entity schema's generator kept a second,
  hand-copied Zod 4 schema just to call it, which covered seven of the entity's twenty top-level keys and drifted
  (ARCH-1 hand-edited the JSON, #696). TGT-0b added `zod-to-json-schema` to build the config's.
- **Codegen and the apps it emits were tied to one Zod.** The emitted code (`runtime/`, `templates/`) runs in the
  consumer's app on the consumer's `zod`, so codegen's own code could not move without moving theirs.

## Decision

Two Zods, one boundary, held by a test (`src/__tests__/schema/zod-boundary.test.ts`; **temporary scaffolding**, step 2
deletes it):

| Code | Zod | Imported as |
|---|---|---|
| Codegen's side, everything that runs inside the generator: `src/**` (schemas, config and YAML loaders, Studio server, library patterns) and the generation-time JS under `templates/` (`prompt.js`, `entity-locals.js`, `_shared/*.mjs`, which import codegen's schemas) | **Zod 4** (4.6) | `import { z } from '<…>/schema/zod'`, the only importer of the `zod4` dependency |
| The emitted side, what generated apps import: `runtime/**` and the `.ejs.t` templates' text (plus the two generators that print `import { z } from 'zod'` as text) | **Zod 3** | `zod`, unchanged |
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
- **`src/schema/zod.ts` is codegen's Zod.** It re-exports `z` from `zod4`, and owns `codegenMessages`, the one
  message rule codegen adds: an enum refusal names the value it refused,
  `Invalid option: expected one of "string"|"integer"|…, received "strng"` (scalars only; a value it can't quote, such
  as a cyclic YAML alias, gets Zod's message unchanged). It is passed **per parse**
  (`safeParse(data, { error: codegenMessages })`) where codegen reports issues to an author: the six YAML loaders, the
  config loader, Studio and the junction prompt. Never `z.config`: Zod 4 keeps that on `globalThis`, shared by every
  Zod 4 copy in the process, a consumer's pattern schemas included. Every other message is Zod 4's own wording or
  codegen's `message:` text. It also owns `editorHints`, a Zod registry the JSON Schema builder reads (below).
- **A runtime Zod 3 schema inside a codegen Zod 4 schema** goes through `fromZod3` (`src/schema/zod3-schema.ts`): the
  value parses with the runtime's own schema (one owner, its defaults and messages), and each Zod 3 issue passes up
  with its code, message, path and `keys` (Zod 3's codes and wording, reaching callers typed against Zod 4). Today:
  `DetectionConfigSchema` under an entity's `detection:` and a job arm's `read:`. Delete it in step 2.
- **The package root's schema exports are Zod 4 objects now** (`JunctionDefinitionSchema`, the error from
  `safeValidateJunctionDefinition`, the library patterns' `configSchema`). Composing one into a Zod 3 schema fails;
  there are no such consumers, and step 2 moves consumers to Zod 4 anyway.

## What changed in the schemas

- `.default({})` on an object block → **`.prefault({})`**. Zod 4's `.default` returns its value as-is; Zod 3 parsed it,
  so `paths: {}` picked up `backend_src`'s default. `.prefault` is Zod 3's `.default`. Fully-spelled defaults are
  unchanged.
- One-argument `z.record(v)` → `z.record(z.string(), v)`.
- `errorMap` / `invalid_type_error` → `error`. `ctx.data` → `issue.input`.
- `ZodError.errors` → `.issues`. `project-config.ts`'s `unwrap` reads Zod 4's classes (`ZodPrefault`, `ZodPipe.in`)
  instead of `ZodEffects` / `_def.innerType`.
- `OnDeleteActionSchema` (relationship `on_delete_from` / `on_delete_to`) loses its `.default('restrict')`. Both keys
  wrap it in `.optional()`, which Zod 3 read as "absent stays absent", so the default never applied; Zod 4 would apply
  it. The readers' `?? 'restrict'` stays the one owner and the parsed output is what it was.
- A differential fuzz of the seven schema kinds (≈27,000 mutated inputs, Zod 3 at the base vs this branch) found the
  same accept/refuse verdicts, the same issue paths and the same parsed data, apart from the relationship default
  just fixed.

## The editor schemas

One converter, `editorJsonSchema` (`src/schema/editor-json-schema.ts`): `z.toJSONSchema`, input side (a key with a
default is optional), draft 07 (what yaml-language-server and `ajv` read without setup; the hand copy declared
2020-12), inlined. **Editor hints** (`editorHints` in `src/schema/zod.ts`, a Zod registry) replace the JSON Schema of a
schema Zod can't express; each hint is derived from its owner, and the parse never reads it.

- **`entity-definition.schema.json`** is generated from the real `EntityDefinitionSchema`
  (`src/schema/entity-definition.json-schema.ts`, `just gen-entity-schema`). The hand copy is deleted. Against the
  old file: all twenty top-level keys instead of seven (`analytics`, `api`, `detection`, `eav*`, `emits`, `events`,
  `generate`, `integration`, `queries`, `roles`, `tenant_scoped` are new), every `entity:` / field / relationship key
  the schema declares, and unknown top-level keys refused (`additionalProperties: false`; the copy accepted them).
  `entity.expose` offers `electric` (the real enum has it; the copy had fallen behind). The copy's 48 hover
  descriptions are kept: 46 as `.describe()` on the real schema, plus `Behavior name` / `Behavior options` on the
  behavior entry.
  - **Behavior names**: `behaviors:` offers the behavior registry's names, each with its description
    (`src/behaviors/`), as an editor hint. The parse still takes any string, as before.
  - **`detection:`** (new to the editor; the copy had no such key) and a job arm's `read:` are a described object
    whose keys, required keys (`mode`, `mapping`) and `mode` values are read by `fromZod3` from the runtime's Zod 3
    schema, so they can't drift from it. Values below the top level are open until step 2 makes the schema Zod 4.
  - A test fails when the committed file and a fresh build differ, and runs every entity YAML in the repo that the
    generator accepts (fixtures, examples, the scaffold, smoke and Studio demo sets: over 100 files) through the JSON
    Schema too (`entity-definition-json-schema.test.ts`).
- **`codegen-config.schema.json`** (TGT-0b) switches converter; `zod-to-json-schema` is gone. Against
  `zod-to-json-schema`'s output: `target` is unchanged (per-pair `const` + description, `additionalProperties:
  false`); integers carry Zod 4's safe-integer bounds; records state `propertyNames: string`; and `frontend.auth`,
  `frontend.catalog` and `frontend.sync` no longer carry `additionalProperties: false`, because they are
  non-strict objects that the generator strips, not refuses. The old file underlined keys the generator accepts.
  Whether those three blocks should be `.strict()` (the loader's "never a silent default" argues yes) is a parse
  change, not part of a Zod move; filed as a follow-up rather than done here.

## Zod's own wording (decision d8, codegen-targets board)

Zod 4 words its default messages differently: `Invalid input: expected string, received number` for
`Expected string, received number`; `Unrecognized key: "config"` for `Unrecognized key(s) in object: 'config'`;
`Invalid input: expected array, received undefined` for `Required`. Codegen takes Zod 4's wording (a compatibility
error map would be the shim the repo rules out); the tests that pinned Zod 3's wording now pin Zod 4's. Every message
codegen wrote itself is unchanged. Studio no longer reads unknown keys out of the message text: the server passes
Zod's `issue.keys` through (`ZodIssueLike.keys`) and `yaml-issues.ts` reads that. `codegenMessages` is tested on its
own (`codegen-messages.test.ts`: names the value, per parse only, nothing global, never throws).

## Proof

- Every golden and snapshot is byte-identical (`test/baseline`, `test/render-golden`, `test/frontend-golden`,
  `test/frontend-graph-golden`, `test/api-surface-golden`, the junction and integration-emit snapshots): `just
  test-all` and `just test-integration` pass with no golden change, and the PR diff touches no file under `test/`
  outside `test/studio/run-studio-e2e.ts` (its expected issue code, `invalid_enum_value` → `invalid_value`).
- The pattern `configSchema` tests run once with a Zod 3 schema and once with a Zod 4 one.
- The boundary test reads imports with Bun's scanner (multi-line, re-exports, `import()`, `require()`, any extension),
  and fails on a seeded violation of each of its rules.

## Step 2 (not here)

Move the emitted side to Zod 4: `runtime/`, the `.ejs.t` templates (the generated DTOs, `ListQuerySchema`), the
detection schema and the event schemas. Consumers then need Zod 4, so it is a major, with migration notes for apps
already generated. Then `zod` becomes `^4`, `src/schema/zod.ts` imports `zod`, and the `zod4` alias, `fromZod3` and
its editor-shape reader, and `zod-boundary.test.ts` are deleted. `PatternConfigSchema` can become Zod 4's type.
Also then: the deprecated `z.ZodIssueCode.custom` (27 uses) and `.merge()` give way to `code: 'custom'` and
`.extend()`.

## Diff Review — Adherence
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=adherence -->

**Target:** `git diff 2d6718a3..9976d239` (commit 9976d239 only; d512953e landed on the branch during the review and was not reviewed)
**Against:** `docs/specs/ZOD-0.md`, with the brief `docs/BRIEF-zod4-internal.md` (codegen-targets) and CLAUDE.md
**Verdict:** REVISE

Checked against an exact export of 9976d239 (`git archive`); the worktree had uncommitted edits while the review ran.

**Blockers (2):**
- [`src/schema/zod.ts:12-13`, § Decision ("global to the `zod4` copy, which only codegen imports")] The message rule
  is not limited to codegen's copy of Zod. Zod 4.6.7 keeps its config on `globalThis.__zod_globalConfig`
  (`node_modules/zod4/v4/core/core.js:135-136`), so every Zod 4 copy in the same process reads it. Reproduced with a
  separate copy of zod@4.6.7 standing in for a consumer's. That copy's enum refusal changed from
  `…"alpha"|"beta"` to `…"alpha"|"beta", received "gamma"` as soon as `src/schema/zod.ts` loaded. In the other
  direction, the consumer's `z.config({ customError })` replaced codegen's rule, and codegen's own enum message
  became the consumer's text. This happens in two places: the consumer's `*.pattern.ts` files, which
  `loadAppPatterns` imports into codegen's process (`src/patterns/registry.ts:357`), and any process that imports
  the package root (`src/index.ts:21` → `codegen-config.schema.js` → `zod.js`). The brief says step 1 should be
  invisible to consumers, and this is visible to them.
  _Fix:_ either keep the rule off the global config (put it on codegen's own enum schemas, or pass it when codegen
  parses), or correct the spec and the comment to say the rule applies to the whole process for Zod ≥4.6 and that a
  consumer's `z.config` replaces it. Add a test for whichever you choose.
- [`src/__tests__/schema/zod-boundary.test.ts:20`, `:32`/`:41`, `:52`] The test that holds the boundary misses
  common import forms, which breaks CLAUDE.md's rule that a gate must be able to fail on its own subject. It reads
  each line on its own, so a multi-line `import {\n z,\n} from 'zod'` is never seen. 72 non-test files under `src/`
  already use multi-line imports. I added each of the following to a copy of the commit, and the test still
  passed (7/7):
  - a multi-line import from `zod` in `src/cli`;
  - a multi-line import from `zod4` outside `zod.ts`;
  - `await import('zod')`;
  - an `.mjs` file under `src` importing `zod`. `src/config/*.mjs` is codegen's own shipped code, and it is never
    scanned;
  - `runtime/` importing `../../src/schema/zod.ts`. The regex accepts only `zod` and `zod.js`.

  The single-line forms do fail it, so the test can fail; it just has holes.
  _Fix:_ collect imports with a real scanner instead of a per-line regex: `new Bun.Transpiler({ loader: 'ts' }).scanImports`,
  plus a check for type-only imports. Scan `src/**/*.{ts,mts,js,mjs}`, and match `src/schema/zod` with any extension.

**Notes (5):**
- [§ Decision table row 2, `CLAUDE.md:448`, `zod-boundary.test.ts:48`] (major) `templates/**` is sorted entirely as
  "what emitted apps import", but code under it serves both sides. The EJS bodies are emitted. The prompt and locals
  JS runs inside codegen and already uses Zod 4 through other modules:
  - `templates/junction/new/prompt.js:21` parses with the Zod 4 `JunctionDefinitionSchema`;
  - `_shared/entity-naming.mjs:28` and `relationship/new/prompt.js:24` import `project-config`;
  - `entity/new/backend/entity-locals.js:34` imports the library patterns.

  The brief says that when a module serves both sides, the spec should keep the emitted side on Zod 3 and say so.
  The spec doesn't say so, and the test rule calls these files "emitted apps' code". The test forbids them from
  importing codegen's Zod and does not stop them importing bare `zod`. A generation-time helper that needs `z` would
  therefore end up on Zod 3, the opposite of the decision.
- [`src/index.ts:175-181`, `:205`] (minor) The package root now exports Zod 4 objects: `JunctionDefinitionSchema`,
  the error returned by `safeValidateJunctionDefinition`, and the library patterns' `configSchema`. The spec doesn't
  mention this. Verified: wrapping one in a Zod 3 object throws (`keyValidator._parse is not a function`), and the
  error fails a Zod 3 `instanceof ZodError` check. Acceptable while there are no users, but the spec should say so.
- [`src/__tests__/studio/files.test.ts:98`] (minor) The comment says Zod 4's enum message "does not quote the
  input". It does: `…, received "strng"`, from the `z.config` rule. The `toContain('strng')` assertion was dropped,
  so no unit test covers the rule any more. Only `test/studio/run-studio-e2e.ts` in `test-studio` asserts it.
- [§ The editor schemas, line 67] (minor) The spec says "47 hover descriptions now live on the real schema". At
  9976d239 the commit adds 46 `.describe()` calls, and 46 of the copy's 48 key descriptions appear in the generated
  JSON. `Behavior name` and `Behavior options` are dropped, and the spec doesn't list them among what the copy
  offered.
- [§ The editor schemas, line 70; `entity-definition-json-schema.test.ts:29`] (minor) The spec says the test "runs
  every fixture entity the generator accepts". The test's glob (`test/fixtures/**`) covers 36 of the 146 entity
  YAMLs that Zod accepts. The 110 it skips include scaffold, smoke, frontend smoke, golden inputs and the Studio demo.
  I ran all 146 through the committed JSON Schema with ajv and none were refused, so nothing is broken today; the
  claim is broader than the test.

**Nits (4):**
- [§ The editor schemas, line 69; `src/schema/entity-definition.json-schema.ts:10`] The copy had no `detection:` key
  (its top-level keys were entity, fields, relationships, behaviors, inherits, discriminator and unique_indexes), so
  it cannot have offered "`detection:` values beyond an object". The comment says the editor sees "any object", but
  the JSON gives the values `{}`, which allows any value.
- [`entity-definition-json-schema.test.ts:39`] `expect(validate.errors ?? []).toEqual([])` runs before `validate(data)`.
  It checks the previous case's errors and never shows the current file's.
- [§ The editor schemas] The brief asked for every change against the old file to be explained. Two are not: the
  draft changed from 2020-12 to draft-07, and `entity.expose` now offers `electric`.
- [`docs/rfcs/RFC-0006-joined-table-inheritance.md:1290`, `docs/specs/CAP-2.md:314`, `docs/specs/SEM-1.md:274,375`]
  These still describe the deleted `generate-json-schema.ts` as current. RFC-0006's as-built notes are the record
  CLAUDE.md treats as authoritative.

**Out of scope:** d512953e restores the behavior names and the `detection:` keys, but lines 67-70 of this spec still
say the schema does not offer them. Update the spec with that commit.

**Verified to hold:**
- `zod.ts` is the only importer of `zod4`.
- `fromZod3` is used in two places (entity `detection:`, job `read:`), and issues come back with their code,
  message and path (for example `detection.hubspot.mode`).
- The `.prefault` conversions are complete. The `.default({…})` calls left are either fully spelled out or on a
  record.
- No one-argument `z.record` remains, and `errorMap` / `invalid_type_error` are gone.
- Codegen's own messages are unchanged (`table_name`, `generate.analytics`, `target:`).
- The config JSON differs from the old file only as the spec says: three `additionalProperties` removed, two
  `propertyNames` added, eight safe-integer maximums added, and `target` untouched.
- `zod-to-json-schema` is gone from `package.json`. `bun.lock` is gitignored, and the local copy no longer contains
  it.
- Studio reads `issue.keys`: the server sends `keys`, and the `yaml-issues` tests pass (36).
- Under `test/`, the diff touches only `run-studio-e2e.ts`.
- The Zod 3 and Zod 4 `configSchema` test loop runs, and `tsc` accepts both kinds as `PatternConfigSchema`.
- All three claims about `zod/v4` in Zod 3.25 vs Zod 4.6 reproduce.
- Typecheck is clean on the export, and 160 targeted tests pass.

**Reviewed by:** reviewer agent · 2026-11-26T20:22:00Z

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=quality (spec-blind; section written by the /sdlc:review lead) -->

**Target:** `git diff 2d6718a3..9976d239` (commit 9976d239 only; probes ran on an exact export of it)
**Against:** quality canvas + CLAUDE.md (spec not read)
**Verdict:** PASS_WITH_NOTES

A differential fuzz compared the seven codegen schema kinds on Zod 3 (2d6718a3) and Zod 4 (9976d239), about 27,000
mutated inputs in all. Both sides accepted and refused the same inputs, reported the same issue paths, and produced
the same parsed data, except for note 2 below.

**Notes (4, minor):**
- [`src/schema/zod.ts:25`] The message rule calls `JSON.stringify(issue.input)` inside `customError`. For a cyclic
  value, `safeParse` therefore throws instead of returning `{ success: false }`. A cyclic value takes only a YAML
  anchor (`type: &t [*t]`). A BigInt input throws the same way. `loadEntityFromYaml` and Studio's `validateContent`
  both throw `TypeError: JSON.stringify cannot serialize cyclic structures`, where Zod 3 returned an issue.
  _Fix:_ append `received …` only when stringifying succeeds (or only for primitives), and add a unit test for the
  rule.
- [`src/schema/relationship-definition.schema.ts:97-99`, `:168`, `:171`] `OnDeleteActionSchema` is
  `.default('restrict')`, and the schema uses it as `.optional()`. On Zod 4 that fills the default; on Zod 3 it left
  the key absent. Every parsed relationship now carries `on_delete_from` and `on_delete_to`, so the readers'
  `?? 'restrict'` fallbacks are dead code (`src/parser/load-entities.ts:546-547`,
  `templates/relationship/new/prompt.js:423-424`). Generated output is unchanged.
  _Fix:_ keep one owner of the default. Either drop `.default` or drop `.optional()` and the fallbacks.
- [`src/schema/codegen-config.schema.ts:326`, `:351`, `:374`] `frontend.auth`, `frontend.sync` and `frontend.catalog`
  are non-strict. The new editor schema no longer underlines a typo under them, and the parse strips it silently.
  For example, `frontend.auth.fucntion: null` leaves auth on. The parse stripped these on Zod 3 too, so only the
  editor's warning is new loss; the spec's § The editor schemas records this as intended. It conflicts with
  `project-config.ts:10-12` ("never a silent default").
  _Fix:_ add `.strict()` to the three objects and regenerate.
- [`src/__tests__/studio/files.test.ts:98-100`] With the `z.config` rule removed, the test's assertions still pass,
  so no unit test fails without the rule. Only the e2e test (`test/studio/run-studio-e2e.ts:517`) checks it.
  _Fix:_ assert `toContain('received "strng"')`.

**Nits (6):**
- `src/schema/entity-definition.schema.ts:1113-1115` gives the ZodEffects limit as a reason, but that limit is
  Zod 3's.
- `docs/specs/STUDIO-0.md:405` still says the e2e asserts `invalid_enum_value` and `received 'strng'`.
- `src/schema/zod3-schema.ts:9` says issues are "passed up unchanged", but `:24` overwrites `input` with the whole
  hosted value. Zod 3 codes and wording also reach callers typed against Zod 4, and the comment should say so.
- `src/schema/zod.ts:6` says that after step 2 "nothing else changes". Step 2 also deletes `zod3-schema.ts` and its
  call sites, and changes the boundary test.
- The two issue-code styles are mixed: deprecated `z.ZodIssueCode.custom` appears 27 times, beside 14
  `code: 'custom'`. `.merge()` is still used at `entity-definition.schema.ts:269-270`.
- `tools/studio/src/inspector/yaml-issues.ts:266` uses `issue.keys ?? []`, a silent fallback. A
  `ZodIssueLike` union in which `unrecognized_keys` requires `keys` would remove it.

**Reviewed by:** reviewer agent · 2026-11-26

## Review resolution (2026-11-26, after both lenses)

Every finding was verified and taken except where noted.

- **Blocker: the message rule was process-global.** Now `codegenMessages`, passed per parse; nothing goes through
  `z.config`. A test asserts that `globalThis.__zod_globalConfig` gets no `customError`.
- **Blocker: the boundary test had holes.** It now reads imports with `Bun.Transpiler.scanImports` over
  `src/**/*.{ts,mts,js,mjs}` and the generation-time `templates/**/*.{ts,js,mjs}`. It matches `schema/zod` with any
  extension, and checks the `.ejs.t` text separately. A self-test feeds it multi-line, dynamic, `require` and `.ts`
  forms. Each rule failed on a seeded violation (a multi-line `zod4` import, a `require('zod')` in a prompt, and
  `runtime/` re-exporting `schema/zod.ts`). Type-only imports load nothing and are not counted, so TGT-1's
  `import type { OnDelete }` is fine.
- **Generation-time template JS** is classed as codegen's side in the table, CLAUDE.md and the test.
- **Package-root exports, numbers, wording, draft and `expose`**: written into the sections above.
- **Cyclic/BigInt input**: the rule appends `received …` only for scalars. A test covers a cyclic value.
- **Relationship `on_delete_*` default**: dropped (it never applied on Zod 3). The readers' fallback is the one owner.
- **Unit coverage of the rule**: `files.test.ts` asserts `received "strng"` again, and `codegen-messages.test.ts`
  covers the rule itself.
- **`frontend.auth` / `.sync` / `.catalog` `.strict()`**: *not taken here.* It changes what the parse accepts and has
  nothing to do with the Zod move. It is a follow-up, noted in § The editor schemas.
- **Nits**: the test now checks `ajv`'s errors after validating, the `detection:` wording is fixed, and the stale docs
  are updated or marked superseded (RFC-0006, CAP-2, SEM-1, STUDIO-0). The Zod 3-limit comment and the
  `zod3-schema.ts` / `zod.ts` comments are corrected. `ZodIssueCode` / `.merge()` are deferred to step 2. The
  `issue.keys ?? []` in Studio stays: `ZodIssueLike` is one wire shape for every code.
