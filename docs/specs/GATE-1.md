# GATE-1 — Make the three out-of-CI gates honest

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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

**Fix (root):** one definition. Declare on `PathsConfigSchema` every `paths.*` key the codebase actually reads —
**10 of them** today: `backend_src`, `frontend_src`, `entities`, `events_dir`, `jobs_dir`, `providers`, `subsystems`,
`modules_dir`, `orchestration_src`, `generated` (`modules_dir` was missed at design time; its readers are
`auth-integrations-scaffold-locals.ts` and `subsystem-detect.ts`). GATE-1 declared 11: the eleventh, `entities_dir`,
was deleted by CLI-0 (#634). *Revised 2026-09-18 (CFG-0, #640):* the schema is now `.strict()` and parsed at runtime,
and `CodegenConfig` is its parsed output (`z.infer` of `CodegenConfigSchema`); the `.passthrough()` and
`z.input<typeof PathsConfigSchema>` this fix originally kept are gone. Delete the casts that
existed only to route around the gap — they are the same defect, pre-emptively silenced.

**15 cast sites were removed**, not the 4 the design enumerated: `subsystem-detect.ts` (×3, one of them
`as Record<string, unknown>`), `project.ts`, `auth-integrations-scaffold-locals.ts` (×2), `entity.ts` (×4),
`events.ts` (×2), `barrel-generator.ts` (×2), `init-scaffold.ts`, `orchestration.ts`. After the change
`grep -rn "as { paths" src/` is empty.

Two limits of the guarantee, worth stating because the schema's doc comment could be read as stronger:

- **The `typeof === 'string'` guards stay.** They are not redundant with the type: `loadConfigFromPath` is
  `yaml.parse` output cast to `CodegenConfig`, so nothing enforces the shape at runtime and a blank `entities:` key is
  `null` however it is typed. One guard was dropped during implementation and restored after review.
- **`.passthrough()` makes the drift check one-directional.** `PathsConfigInput` carries a `[k: string]: unknown`
  index signature, so reading an *undeclared* key types as `unknown` rather than raising TS2339. Schema → CLI can no
  longer drift; CLI → schema is caught only because `unknown` cannot be used as a string without narrowing.

A third `paths` shape exists at `src/emitters/frontend/load-context.ts` (`FrontendConfigInput.paths`). It is not part
of the CLI's `Context` and was left alone; folding it into `PathsConfigInput` is a follow-up, not a gate fix.

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

  > **2026-09-20 (ARCH-1, #682):** moot, and the names above no longer exist. ARCH-0 deleted the `clean` templates;
  > ARCH-1 deleted `locations.dbSchemaServer` (no reader) and `src/config/locations.mjs` itself. The `locations:`
  > block is now the frontend emitter's three names, whose defaults live in
  > `src/emitters/frontend/load-context.ts`.
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

**Fix (root):** as designed for 1–3 — the harness invokes `bun src/cli/index.ts entity new … --force` and writes a
config matching the scaffold's alias contract (`runtime: vendored`, `paths.backend_src: .`,
`paths.generated: generated`, `generate.architecture: clean-lite-ps`, `generate.frontend: false`).

**Implementation found six more layers behind those three.** The gate had been dead long enough that every contract it
touches had moved:

| # | What was wrong | Fix |
|---|---|---|
| 4 | **Two copies of `drizzle-orm`.** The scaffold pinned `^0.30.0` (resolved 0.30.10) against the repo's 0.45.2; tables built by one and handed to `drizzle()` from the other threw `JSON Parse error: Unexpected identifier "undefined"`. The same shape with `@nestjs/common` — same version, two physical copies — made `instanceof HttpException` fail, so every `NotFoundException` surfaced as a 500. | `test/scaffold/package.json` now declares **no dependencies at all**; the scaffold resolves everything by walking up to the repo's `node_modules`. The four packages only it needed moved to the root devDeps. `just install` no longer runs a second `bun install`, and the harness's own install step is gone. |
| 5 | **`@shared/*` pointed at a hand-vendored copy.** `test/scaffold/shared/` held stale duplicates: `constants/tokens.ts` had no `EVENT_BUS`; the family base classes (activity / metadata / integrated) were never copied at all. | Both tsconfigs map `@shared/*` onto the real split runtime tree (`runtime/base-classes`, `runtime/subsystems`, `runtime/constants`, `runtime/types`, `runtime/shared`), with an exact `@shared/http/page → runtime/http/pagination` entry for the rename `project init` performs when vendoring. The stale `constants/` and `types/` copies are deleted. |
| 6 | **`schema.ts` re-exported a table the jobs subsystem stopped emitting** (`jobQueue` from `job-queue.schema`), and naming individual tables meant `drizzle-kit push` never created the pgEnums their columns reference — push aborted partway, silently leaving later tables (including the scaffold's own) uncreated. | `export *` from each subsystem schema, resolved through `@shared/*` (runtime) rather than a vendored copy — so nothing needs installing and nothing is left behind. |
| 7 | **`truncateAll()` named a hard-coded table list** including the removed `job_queue`, failing the whole `TRUNCATE`. | Derives the list from `pg_tables` at runtime. |
| 8 | **Three fixtures asserted contracts that had changed.** `helpers.ts` still exported `syncedEntityFactory` after the family was renamed Integrated; the event-bus suite published domain-tier events with no `pool`/`direction`, which `domain_events_tier_routing_check` rejects (the declared-events pipeline always populates them); the HTTP suite asserted a bare-array list body and a 200-with-empty-body for a missing id, where the generator now emits the `Page<T>` envelope and `NotFoundException`. | Each fixture corrected to the current contract. None was weakened: the HTTP suite now also asserts `total`, and the 404 assertion is strictly tighter than the 200 it replaced. |
| 9 | **The harness left its output in the repo root.** `subsystem install jobs` writes `src/worker.ts` at a fixed path regardless of `backend_src`, and `tsconfig.build.json` includes `src/**/*` — so after one `just test-integration`, `bun run typecheck` (and therefore `just test-all`) was red for everyone. The first implementation hid it with a `.gitignore` entry, which hides it from git but not from `tsc`. | Fixed at the cause: pointing `schema.ts` at `@shared/*` removed the vendoring step entirely, so no `src/worker.ts` and no `shared/` tree is emitted; and the harness's teardown now removes `modules/`, `generated/` and `shared/` from the repo root (skipped under `--skip-codegen`, which exists to iterate on an already-generated tree). |

The same `bun codegen …` invocation was also rotting six other justfile recipes (`validate-entities`, `analyze`,
`stats`, `doc`, `manifest`, `suggestions` — all documented in CLAUDE.md) and `scan`; all seven now call
`bun src/cli/index.ts <noun> <verb>`. `test-family` pointed at `crm-entity-repository.test.ts`, deleted when the family
was renamed. `test/scaffold/validate.sh` and its `just validate` recipe carried every one of these defects and
duplicate what `just test-integration` now does end to end; under I7 (replace, don't parallel) they are **deleted**
rather than repaired.

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

## Acceptance — all met

Output from the run made after the last edit:

| Gate | Before | After |
|---|---|---|
| `bun run typecheck` | exit 2 (4 × TS2339) | **exit 0** |
| `bun run build` | exit 0 | exit 0 |
| `bun run test` (baseline) | exit 0 | exit 0 |
| `just test-all` | exit 0, no typecheck | **exit 0, `typecheck` first** |
| `just test-integration` | exit 1 (`Script not found "codegen"`) | **exit 0** — 64 pass · 2 skip (pre-existing `test.skip` in `bridge-e2e.test.ts`) · 0 fail |
| `just test-smoke-junction-clean` | exit 1 | exit 1 — **unchanged, by design** (Failure 2) |

- `just test-smoke-junction-clean` exits 1 with nothing filtered, skipped or loosened: `test/smoke/` is untouched by
  this PR, the gate is in neither `test-all` nor CI, and its status is in CLAUDE.md › Testing › Known-red gates.
- No `any` introduced; the 15 casts removed in 1b are removals, not replacements (`grep -rn "as { paths" src/` → empty).
- `bun run typecheck` stays exit 0 **after** a `just test-integration` run — the harness cleans up after itself.

## Risks

- **Deleting the junction `name`/`table` override breaks a consumer that relies on it** → impossible: the strict schema
  rejects it at load, so no YAML in existence can be using it. Covered by the junction smokes + snapshots.
- **Widening `PathsConfigSchema` changes validation behaviour** → the block keeps `.passthrough()`, so previously
  accepted configs stay accepted; the added keys are all `.optional()`. Covered by `just test-all`.
- **`test-integration` in CI is flaky (Docker/compose)** → it gets its own job, so a flake cannot mask `test-all`.

## Review

Gate 2.5 ran before the final gate pass. Both lenses returned **REVISE**, and both were right:

- **The two honest gates broke each other.** `just test-integration` emitted `src/worker.ts` into the generator's own
  `src/`, which `tsconfig.build.json` includes — so `bun run typecheck`, which this PR had just added to `test-all`,
  was red for anyone who ran the integration gate first. The first implementation had added the file to `.gitignore`,
  which hides it from git but not from `tsc` — a filter in everything but name. Fixed at the cause (item 9 above).
- **The new `.gitignore` entries were unanchored.** Bare `generated/` and `shared/` match at every depth, so they
  swallowed `src/cli/shared/`, `runtime/shared/`, `test/scaffold/shared/` and `runtime/subsystems/*/generated/` — the
  last of which the same file explicitly says is committed. Any new file in those directories would have been
  invisible to `git add`. All entries are now root-anchored, including the pre-existing `modules/`.
- **The cast sweep was half-done** (8 sites left) and one runtime `typeof === 'string'` guard had been dropped in
  favour of the static type, which the raw-YAML reality does not support. Both fixed.
- A dangling `../types/drizzle` import into a deleted directory, and a comment that misattributed where the junction
  YAML is rejected, were also fixed.

## Definition of done (charter §9)

Gates green from the run after the last edit (except the documented known-red one) · this spec corrected to
post-implementation truth and marked `Implemented` · epic #579 body + log entry updated · board Status moved.

## Follow-ups

- **Proposed split (owner to file):** *"The `clean` backend pipeline does not typecheck — 120 unresolved module
  specifiers"* (Failure 2). Carries the census above, the 15-error junction self-import fix, and a gate that actually
  compiles `clean` output.
- `src/emitters/frontend/load-context.ts` holds a third `paths` shape; fold it into `PathsConfigInput`.
- `filterConsumerErrors` (#576) also masks 2 real errors on the *green* clean-lite-ps path.

## Open questions

None blocking. One decision deferred to the owner: whether to file the proposed `clean`-pipeline split issue now or
after DRZ-2.
