# GATE-1 — Make the three out-of-CI gates honest

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #599 · **Epic:** #579 · **Project:** #578
**Depends on:** DRZ-1 (#583) · **Blocks:** DRZ-2 (#584)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · CLAUDE.md

## Why

Three gates are red on `main` and none of them is in CI, so each rotted silently:

| Gate | Symptom on `origin/main` @ `2b5d5ec` |
|---|---|
| `bun run typecheck` | exit 2 — 4 × `TS2339` |
| `just test-smoke-junction-clean` | exit 1 — "21 typecheck errors in consumer-emitted code" |
| `just test-integration` | exit 1 — `error: Script not found "codegen"` |

CI runs `just test-all` only (`.github/workflows/ci.yml:39`) and none of the three is in it. DRZ-2 (#584) moves
`drizzle-orm` to the 1.0 line and its acceptance is "typecheck green, no filtered error classes" — which cannot be
evaluated on top of red gates, because the bump's real errors would be indistinguishable from the pre-existing ones.
Charter **I9** (gates are honest) is the binding invariant: no `any` casts, no filters, no skipped steps.

## Charter invariants this PR touches

- **I9 honest gates** — the point of the PR. Every fix is at the root; nothing is filtered, cast away or skipped. Where
  a gate cannot be made green inside this project's scope, its status is made **explicit and tracked**, not hidden.
- **I7 no backwards compat** — a dead, unreachable config override is deleted rather than made to work "just in case".
- **I11 scope discipline** — the full `clean` backend pipeline is out of scope for this project (charter §5 non-goals:
  "The full `clean` backend pipeline (ADR-041 defers it; follow-up after this project)"). Failure (2) turns out to live
  entirely there. See "Blocked — proposed split".

## Failure 1 — `bun run typecheck` (4 × TS2339)

Two independent root causes.

### 1a. A junction `name` / `table` override that three readers implement and the validator forbids

```
src/cli/commands/junction.ts:58    def.name  ?? `${def.between[0]}_${def.between[1]}`
src/cli/commands/junction.ts:190   def.name  ?? `${def.between[0]}_${def.between[1]}`
src/cli/shared/barrel-generator.ts:212  def.table ?? pluralize(name)
```

`JunctionDefinitionSchema` (`src/schema/junction-definition.schema.ts:60`) declares neither key **and is `.strict()`**,
so a junction YAML that sets them is rejected at load:

```
JunctionDefinitionSchema.safeParse({ pattern:'Junction', between:['opportunity','contact'], name:'oc', table:'ocs' })
→ success: false — "Unrecognized key(s) in object: 'name', 'table'"
```

`templates/junction/new/prompt.js:75,79` implements the same two `??` fallbacks. So the override is implemented in
**four** places and reachable from **none**: `codegen junction new` validates through the strict schema before hygen
runs. No fixture declares `name:` or `table:`; no doc, skill or README documents them.

**Fix (root):** delete the dead override at all four sites. A junction's identity is its pairing — `name` derives from
`between`, `table` from `pluralize(name)`. The schema stays `.strict()` and stays the single source of truth.

*Alternative considered and rejected:* add `name` / `table` as optional schema keys to "make the override work". That
adds config surface nobody has asked for, on the strength of code that has never executed. Under I7 the predecessor
exists for no reason other than having been written; delete it. If junction name/table overrides are ever wanted, they
are a feature with their own issue, spec and tests — not a byproduct of a typecheck fix.

### 1b. A second, hand-maintained copy of the config `paths` type that drifted

```
src/cli/shared/jobs-path.ts:24    config?.paths?.jobs_dir
```

There are two definitions of the `paths` block:

- `PathsConfigSchema` (`src/schema/codegen-config.schema.ts:79`) — the Zod source of truth. **Has `jobs_dir`.**
- `CodegenConfig['paths']` (`src/cli/shared/context.ts:16`) — a hand-written interface the whole CLI actually uses.
  **Does not have `jobs_dir`**; it was never updated when RFC-0005 added the key to the schema.

The same drift is already being worked around elsewhere rather than fixed — `src/cli/shared/subsystem-detect.ts:232`
(`as string | undefined`), `:312` (`as { … }`), `src/cli/commands/project.ts:88`
(`as { generated?: string } | undefined`) and `src/cli/shared/auth-integrations-scaffold-locals.ts:124`
(`as Record<string, unknown>`) all cast around keys the interface omits. Those casts are why only `jobs_dir` surfaced
as an error: it is the one site nobody had cast yet.

**Fix (root):** one definition. Declare on `PathsConfigSchema` every `paths.*` key the codebase actually reads
(`backend_src`, `frontend_src`, `entities`, `entities_dir`, `events_dir`, `jobs_dir`, `subsystems`, `providers`,
`orchestration_src`, `generated`), keep `.passthrough()` for genuinely unknown legacy keys, and derive
`CodegenConfig['paths']` from it as `z.input<typeof PathsConfigSchema>` (input, not output: the CLI reads raw YAML that
has not been through `.parse()`, so defaulted keys must stay optional). Delete the casts that existed only to route
around the gap — they are the same defect, pre-emptively silenced.

This is the "cannot rot again" half of the fix: a new `paths.*` key can no longer be added to the schema and forgotten
in the CLI, because there is only one type.

## Failure 2 — `just test-smoke-junction-clean` — **BLOCKED, out of scope**

### What the number "21" actually is

`run-smoke-junction.ts:104 filterConsumerErrors()` drops error lines matching `../`, `node_modules/`, `TS5101`,
`*.schema.ts`, several `Property '…'` shapes and `@pattern-stack/codegen/*`. The gate reports what survives that
filter. Raw `tsc --noEmit --skipLibCheck` on the same generated project:

| Architecture | Raw tsc errors | Reported by the gate |
|---|---|---|
| `clean-lite-ps` (in `test-all`, green) | **2** | 0 |
| `clean` (this gate, red) | **120** | 21 |

So the filter is the difference between "21 import-path errors" and "a backend pipeline that does not compile". Raw
census for `clean`: 112 × `TS2307` (unresolved module) + 8 × `TS7006` (implicit any, cascading from the failed type
imports). Unresolved specifiers, by count:

```
 36  ../../../domain                      16  ../../../constants
  6  ../../schemas                         6  ../../application/schemas
  3  ../../../constants/tokens             3  ../../constants/tokens
  3  ../database.module                    3  ../database/database.module
  3  ../../domain                          3  ../../core/pipes/zod-validation.pipe
  3  @repo/db/server/schema                3  @mguay/nestjs-trpc
  3  ../opportunities/opportunity.entity   3  ../contacts/contact.entity
  4  ../infrastructure/persistence/drizzle/{accounts,contacts,opportunities,opportunity-contacts}.schema
  5  ./opportunity_contact.{entity,repository,service}, ./opportunity_contacts.module, ./accounts.schema
  …
```

Only **15 of 120** are the junction pipeline's own self-imports (the four junction templates hard-code
`'./<name>.entity'`, `'./<name>.repository'`, `'./<name>.service'`, `'./<plural>.module'`, which is correct only for
the flat `clean-lite-ps` layout; under `clean` the five files are spread across `domain/`, `application/` and
`infrastructure/`, and `resolveOutputPaths()` in `templates/junction/new/prompt.js:163` already knows this — it
computes the cross-entity parent imports correctly and simply never computes its own). That part is a mechanical fix.

The other **105** are not junction at all. They are the `clean` entity pipeline:

- the `domain/` and `constants/` barrels it imports but does not emit (52 errors);
- the DTO `schemas` barrel (12);
- `database.module` / `zod-validation.pipe` / cross-entity entity files (15);
- `src/generated/schema.ts` re-exporting **plural** schema filenames (`accounts.schema`) when the pipeline emits
  **singular** ones (`account.schema.ts`) — the generated barrel points at files that do not exist (4);
- `@repo/db/server/schema` — `templates/entity/new/backend/database/repository.ejs.t:17,25` imports the Drizzle tables
  from `locations.dbSchemaServer.import`, whose default (`src/config/locations.mjs:41`) is a monorepo alias, while the
  schema is emitted locally to `infrastructure/persistence/drizzle/`. Which location owns the tables in the `clean`
  pipeline is an unanswered design question, not a path typo (3);
- `@mguay/nestjs-trpc` — emitted by the trpc module template; not installed in the smoke project (3).

### Why this is not repaired here

The `clean` backend pipeline has never been typechecked anywhere. The baseline gate compiles
`packages/api/src/domain/**/*` **only** (`test/tsconfig.baseline.json:"include"`), so `infrastructure/`,
`application/` and `presentation/` — where 105 of the 120 errors live — are outside every existing gate. Making this
gate green means repairing the barrels, the DTO layout, the schema-location contract and the trpc dependency of a
pipeline the charter explicitly defers (§5 non-goals; I11). That is a project, not an item in a gate-hygiene PR, and
#599 says so: *"do not sink days into an out-of-scope pipeline."*

### What is done instead

Per #599's fallback — *"make the gate's status explicit, not hide it"*:

- The gate is **not** added to `just test-all` / CI. A known-red gate in CI is not honesty, it is a broken window that
  trains reviewers to ignore red.
- Nothing is filtered, skipped or suppressed to make it look better. `filterConsumerErrors` is left exactly as it is
  (it belongs to #576) — but its masking ratio is recorded above and in the epic, because "21" materially understates
  the problem and #576's scope should know that.
- CLAUDE.md › Testing gains an explicit "Known-red gates" entry naming the gate, the real error count and the
  tracking issue.

**Proposed split (for the owner to file):** *"The `clean` backend pipeline does not typecheck — 120 unresolved module
specifiers"*, carrying the census above, the junction self-import fix (15), and a first gate that actually compiles
`clean` output (extend `test/tsconfig.baseline.json`'s `include` beyond `domain/`). Not filed by this PR — filing is
the owner's call, as with #599 itself.

## Failure 3 — `just test-integration`

`test/scaffold/run-integration.ts:61` runs:

```ts
await $`cd ${REPO_ROOT} && bun codegen entity test/scaffold/contact-scaffold.yaml`.quiet();
```

Three separate pieces of rot, each fatal on its own:

1. **`bun codegen` resolves a package script that does not exist.** `package.json` declares `cdp`, not `codegen`
   (`codegen` is a published *bin*, not a script). Every other harness invokes `bun src/cli/index.ts`. The same stale
   invocation survives in `justfile`'s `scan` recipe (`bun codegen scan {{path}}`) — fixed here too, since it is the
   identical defect and would be the next thing to fail.
2. **The command shape is pre-noun-verb.** `codegen entity <file>` is the old CLI; the current form is
   `entity new <file>`.
3. **The config the harness writes does not match the layout the scaffold's aliases expect.** It writes only
   `generate.architecture`, so output lands in `app/backend/src/modules/contacts/`, while `test/scaffold/schema.ts`
   imports `@gen/modules/contacts/contact.entity` and `@gen/*` maps to the repo root (`tsconfig.json`). It also never
   installs the events / jobs / cache subsystems that `test/scaffold/schema.ts` re-exports
   (`@gen/shared/subsystems/…`), and those are only vendored under ADR-037 `runtime: vendored`, which the config does
   not set either.

**Fix (root):** the harness writes a config that matches the scaffold's own alias contract — `runtime: vendored`,
`paths.backend_src: .`, `paths.subsystems: shared/subsystems`, `generate.architecture: clean-lite-ps`,
`generate.frontend: false` — invokes the CLI the way every other harness does (`bun src/cli/index.ts entity new …`),
and installs the three subsystems the scaffold schema re-exports before pushing. The config swap/restore around the
repo-root `codegen.config.yaml` stays as-is.

## Putting them where they cannot rot again

| Gate | Where it goes | Why |
|---|---|---|
| `bun run typecheck` | into `just test-all` | `test-all` is what CI runs; typecheck is fast and Docker-free |
| `just test-smoke-junction-clean` | **not** added — documented as known-red with its tracking issue | cannot pass inside this project's scope (Failure 2) |
| `just test-integration` | its own CI job, not `test-all` | needs Docker. `ubuntu-latest` has it, so CI can run it; keeping it out of `test-all` keeps the local/default suite Docker-free, and a Docker flake then fails its own job instead of masking `test-all` |

CLAUDE.md's description of `test-all` is already stale ("test-unit + test-baseline + test-smoke") — it has run ten
recipes since. Corrected in the same PR, together with the new Known-red gates entry and the local-gate note for
`test-integration`.

## Out of scope

- Repairing the `clean` backend pipeline (Failure 2 — proposed split above).
- `filterConsumerErrors` and the smoke error filters generally (#576 → DRZ-2). Its masking ratio is *reported* here;
  the filter itself is not touched.
- Any `drizzle-orm` version change (DRZ-2).
- Adding junction `name` / `table` overrides as a real feature (see 1a).

## Implementation order

1. Failure 1a + 1b. `bun run typecheck` → exit 0.
2. Failure 3: harness config + invocation + subsystem install; `justfile` `scan` recipe. `just test-integration` → exit 0.
3. Wiring: `typecheck` into `just test-all`; `test-integration` as its own CI job.
4. Docs: CLAUDE.md `test-all` description, Known-red gates entry, `test-integration` local-gate note.
5. Full gates from a clean tree, after the last edit.

## Acceptance

- `bun run typecheck` exit 0.
- `just test-integration` exit 0 (Docker present).
- `just test-all` exit 0 **and** it runs `bun run typecheck`.
- `just test-smoke-junction-clean` still exits 1, unchanged, with its status documented and a split proposed — no
  filter, skip or suppression added anywhere.
- No `any` cast introduced; the casts deleted in 1b are removals, not replacements.

## Risks

- **Deleting the junction `name`/`table` override breaks a consumer that relies on it** → impossible: the strict schema
  rejects it at load, so no YAML in existence can be using it. Covered by the junction smokes + snapshots.
- **Widening `PathsConfigSchema` changes validation behaviour** → the block keeps `.passthrough()`, so previously
  accepted configs stay accepted; the added keys are all `.optional()`. Covered by `just test-all`.
- **`test-integration` in CI is flaky (Docker/compose)** → it gets its own job, so a flake cannot mask `test-all`.

## Definition of done (charter §9)

Gates green from the run after the last edit (except the documented known-red one) · this spec corrected to
post-implementation truth and marked `Implemented` · epic #579 body + log entry updated · board Status moved.

## Open questions

None blocking. One decision deferred to the owner: whether to file the proposed `clean`-pipeline split issue now or
after DRZ-2.
