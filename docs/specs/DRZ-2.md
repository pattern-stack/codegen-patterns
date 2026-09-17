# DRZ-2 — drizzle-orm 1.0.0-rc.4: generator, runtime, scaffold, harnesses

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #584 · **Epic:** #579 · **Project:** #578
**Depends on:** DRZ-1 (#583), GATE-1 (#599) · **Blocks:** TEN-1, REL-1, SEM-1, CAP-1 (after the checkpoint)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §4.3–4.4

## Why

`defineRelations()` (relations v2) exists only on the Drizzle 1.0 line, and every later unit of the project builds on
it. Building the generator on the prerelease is operator-approved (charter §7). Scope is the **generator and what it
emits** — not consumer migration history, not a consumer production pin (charter §5).

## Charter invariants this PR touches

- **I9 honest gates** — the whole point of §5. No `any` / `as unknown as` introduced to silence 1.0's types, no
  loosened assertions, no filters. The measured residual surface is reported, and anything not fixed here gets an
  issue plus a named single-purpose expectation — never a broad filter.
- **I7 no backwards compat** — `drizzle(pool, { schema })` and `getTableColumns` are replaced, not paralleled. No
  dual-version support, no `drizzle-orm@0.45` fallback path anywhere.
- **I11 scope discipline** — the `clean` backend pipeline stays out of scope. `just test-smoke-junction-clean` is a
  documented known-red gate (#602); this PR must not add filters for it and must not try to repair it.

## Spike result — re-measured on this stack (2026-09-17)

Measured on `dugshub/599-honest-gates` @ `5d6180e` (DRZ-1 + GATE-1 both in), with **only** the dependency swapped to
`drizzle-orm@1.0.0-rc.4` / `drizzle-kit@1.0.0-rc.4`. GATE-1 made `bun run typecheck` exit 0 at baseline, so the
numbers below are attributable to the bump alone — which is exactly why GATE-1 had to land first.

**`bun run typecheck`: 3 errors, one class.**

```
runtime/base-classes/base-repository.ts(194,12):              error TS7053
runtime/base-classes/integrated-entity-repository.ts(131,21): error TS7053
runtime/base-classes/junction-integration-repository.ts(96,21): error TS7053
  Element implicitly has an 'any' type because expression of type '0' can't be used to index
  type 'any[] | QueryResult<never>'.
```

All three are `rows[0]` after `insert(this.table).values(...).returning()`. Root cause, traced through the 1.0
typings:

- `BaseRepository.table` is declared `PgTableWithColumns<any>` (`base-repository.ts:55`).
- `PgTableWithColumns<T> = PgTable<T> & T['columns'] & {…}` (`pg-core/table.d.ts:21`), so with `T = any` the whole
  intersection collapses to `any` and `TTable['$inferSelect']` is `any`.
- 1.0's `returning()` returns `PgInsertReturningAll<this, TDynamic>`, whose `TReturning` is
  `TTable['$inferSelect']` (`pg-core/query-builders/insert.d.ts:84`), and the awaited result is
  `TReturning extends undefined ? PgQueryResultKind<TQueryResult, never> : TReturning[]`
  (`insert.d.ts:96`). With `TReturning = any` that conditional distributes to the union
  `any[] | QueryResult<never>`, which is not indexable.

`update().set().returning()` is unaffected because 1.0's `PgUpdateReturningAll` computes `TReturning` from
`SelectResult<…>` (`update.d.ts:64`), a concrete mapped type — hence only the three *insert* sites fail. This is a
type-inference change, not a behaviour change.

**`bun test src/__tests__/runtime`: 4 failures / 1119 pass.**

| Spec | Test |
|---|---|
| `integration-cursor-store.drizzle-backend.spec.ts:59` | `PostgresCursorStore › get › SELECTs cursor scoped by id only` |
| `integration-cursor-store.drizzle-backend.spec.ts:114` | `PostgresCursorStore › put › UPDATEs cursor, last_integration_at, and updated_at in one statement` |
| `integration-run-recorder.drizzle-backend.spec.ts:86` | `DrizzleIntegrationRunRecorder › startRun › passes cursor_before through when provided` |
| `integration-run-recorder.drizzle-backend.spec.ts:133` | `DrizzleIntegrationRunRecorder › recordItem › INSERTs a row with valid changedFields` |

All four are one root cause, diagnosed (not assumed) by probing rc.4 from inside the repo — 1.0 replaced per-column
`mapToDriverValue` / `mapFromDriverValue` with a **codec** system (`pg-core/codecs.js`; `jsonb` columns now carry
`codec: 'jsonb'`, `dataType: 'object json'`), and `drizzle-orm/pg-proxy` no longer applies JSON serialization itself:

| Direction | 0.45 (what the specs encode) | 1.0.0-rc.4 (measured) |
|---|---|---|
| jsonb **param** out | pre-stringified: `'{"systemModstamp":"x"}'` | raw JS object: `{ systemModstamp: 'x' }` |
| jsonb **value** in | a JSON *string* row value was `JSON.parse`d | passed through unchanged |

`pg` itself serializes JS objects for `json`/`jsonb` bind params and parses `jsonb` columns into objects, so 1.0's
pass-through is correct and the **runtime code is right**. What was wrong is the pg-proxy test harness: its fixtures
encoded 0.45's driver-value mapping as if it were the wire contract (the file's own header comment says so —
"pg-proxy serializes params to strings before handing them to the callback"). The fix is therefore an
assertion/fixture correction to the new truth, and it lands **stronger** than what it replaces:

- param assertions go from "some param is a string containing the substring `systemModstamp`" to
  `toEqual({ systemModstamp: … })` on the actual param;
- the `get` fixture returns the parsed object a real `pg` driver returns, instead of a JSON string.

No assertion becomes an existence check; no `toBeDefined` survives where a value assertion is possible.

**Not exercised by the spike** (expect findings; they are gates in §Acceptance): the emitted `database.module.ts`,
the four smoke harness projects, the scaffold integration suite, the tarball smoke.

## Scope

### 1. Dependency shape (`package.json`)

- `drizzle-orm` moves from `dependencies` to `peerDependencies` `"^1.0.0-rc.4"` (npm semver: admits later 1.0.0
  prereleases and GA `1.0.0`), **plus** `devDependencies` pinned exactly `"1.0.0-rc.4"` for this repo's own compile and
  tests. Rationale: in `runtime: package` mode the consumer resolves the runtime base classes from this package, so a
  bundled `drizzle-orm` reproduces exactly the dual-type-identity hazard documented at
  `src/cli/shared/init-scaffold.ts:119-129`. One drizzle copy per consumer is the contract.
- `drizzle-orm` is a **required** peer — it must *not* be listed in `peerDependenciesMeta`.
- `drizzle-kit` devDependency `^0.31.0` → exact `1.0.0-rc.4`. Both plain (hash-free) versions are published on npm;
  verified.
- **Verified:** no other package in the repo declares `drizzle-orm` or `drizzle-kit`
  (`packages/{codegen-calendar,codegen-crm,codegen-mail,codegen-messaging,codegen-transcript,graph-components}` —
  none). So "same treatment for every other publishable package" is a no-op here; recorded so a future reader does
  not re-hunt.
- The 0.45.2 copy in `bun.lock` arrives transitively via a published `@pattern-stack/codegen@0.30.0` dependency of a
  workspace package. Confirm it disappears (or is harmless) after the swap; a second physical drizzle in the repo's
  own `node_modules` is the exact hazard this PR closes.

### 2. Runtime (`runtime/**`)

- Fix the three TS7053 sites **at the declaration**, not the use site: narrow
  `BaseRepository.table` from `PgTableWithColumns<any>` to `PgTableWithColumns<TableConfig>`. That gives
  `$inferSelect` a concrete object type, so `returning()` resolves to `TReturning[]` and `rows[0]` type-checks at all
  three sites. This **removes** an `any` (and its `eslint-disable`) rather than adding one. Verified: the single
  change clears all three errors and `bun run typecheck` exits 0.
  - The other `PgTableWithColumns<any>` occurrences (`base-repository.ts:356`, `integrated-entity-repository.ts:281`,
    `junction-integration-repository.ts:25,28,213,233`, `integration-upsert-config.ts:37`,
    `metadata-entity-repository.ts:22`) are not part of this error class. Narrow them only if free; do not widen the
    diff chasing them.
- Correct the 4 runtime specs to the measured 1.0 param/row contract (per §Spike). The affected specs' header
  comments document the old contract and must be corrected too, or the next reader re-learns it the hard way.
- `getTableColumns` → `getColumns`. 1.0 still exports `getTableColumns` but marks it `@deprecated`
  (`drizzle-orm/utils.d.ts:50-54`), so this is I7 hygiene rather than a compile break. **Four** spec files, not the
  three PLAN §4.3 lists: `src/__tests__/runtime/subsystems/{integration-audit,job-orchestration,bridge-delivery,domain-events}.schema.spec.ts`.
- `runtime/types/drizzle.ts` — `NodePgDatabase<any>` compiles on 1.0 (1.0's generic is
  `TRelations extends AnyRelations = EmptyRelations`). Tighten to the default (`NodePgDatabase`) only if free; the
  `any` is pre-existing, and REL-1 is what gives it a real relations type.

### 3. Emitted scaffold (`src/cli/shared/init-scaffold.ts`, `databaseModuleContent`, `:201-236`)

- `drizzle(pool, { schema })` → `drizzle({ client: pool })`. 1.0's pg config is
  `Omit<DrizzleConfig<…>, 'schema'>` (`pg-core/utils.d.ts:55`) — `schema` is *removed*, not renamed; the slot 1.0
  offers is `relations`, which REL-1 fills. Leave one clearly-named seam comment; emit **no** placeholder.
- `export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>` → the driver type without the schema generic
  (`NodePgDatabase` from `drizzle-orm/node-postgres`).
- `import * as schema from '../../schema'` becomes unused in the emitted module once the config drops it — remove it,
  or the generated file ships a dead import (and the smoke's unused-import surface will say so).
- Whatever dependency list the scaffold writes into a new project's `package.json` moves to the 1.0 line for
  `drizzle-orm` / `drizzle-kit`.

### 4. Harness pins — **four** sites, not two

PLAN §4.3 and the design draft list two; there are four `'drizzle-orm@0.45'` literals:

| File | Line |
|---|---|
| `test/smoke/run-smoke.ts` | `:96` (`RUNTIME_DEPS`) |
| `test/smoke/run-smoke-subsystems.ts` | `:50` |
| `test/smoke-integration/run.ts` | `:85` |
| `test/junction/_helpers.ts` | `:52` |

All four → `drizzle-orm@1.0.0-rc.4` (exact; prerelease pins are exact in harnesses, charter §8). The comments beside
them that explain the 0.45 pin are corrected in the same edit.

**`test/scaffold/package.json` needs no pin.** GATE-1 item 4 emptied it deliberately — the scaffold declares *no*
dependencies and resolves everything by walking up to the repo's `node_modules`, because two physical copies of
`drizzle-orm` broke table construction. So the scaffold follows the root pin automatically. What *does* need changing
in the scaffold is the 1.0 API:

- `test/scaffold/shared/database/database.module.ts:21,34` — same `drizzle(pool, { schema })` /
  `ReturnType<typeof drizzle<typeof schema>>` pair as the emitted module.
- `test/scaffold/tests/setup.ts:17,23` — same pair.
- `test/scaffold/drizzle.config.ts` — `defineConfig` from `drizzle-kit` 1.0; the harness runs `drizzle-kit push`
  against it, so this is load-bearing for `just test-integration`.

`test/post-publish/run-tarball-smoke.ts` hard-codes no drizzle version; it must resolve the new peer range (npm
auto-installs peers). Verify, don't assume.

### 5. Delete the smoke error filters (closes #576)

Three near-duplicate `filterConsumerErrors` copies exist: `test/smoke/run-smoke.ts:167`,
`test/smoke/run-smoke-subsystems.ts:90`, `test/smoke/run-smoke-junction.ts:104`. Between them they drop:

| Exclusion | Present in | Verdict |
|---|---|---|
| any line containing `../` or `/codegen-patterns/runtime/` | all 3 | **delete** — this is #576: it matches the error *message*, so `Cannot find module '../x'` in generated code can never fail a smoke |
| any line containing `node_modules/` | all 3 | **delete** — same defect |
| `/\.schema\.ts\(\d+,\d+\): error/` | all 3 | **delete** — it exists only for the 0.30↔0.45 mismatch class this PR retires |
| `Property 'table' … not assignable` | all 3 | **delete** — same, it *is* the version-mismatch class |
| `Cannot assign an abstract constructor` / `Constructor<{}>` / `Property 'findByX…'` (mixin erasure) | all 3 | **delete**; measure what remains and triage (§below) |
| `'@pattern-stack/codegen/` | junction only | **delete**; triage what remains |
| `modules/connections/{adapters,facade,oauth,…}` (vendored auth starter) | run-smoke only | keep **only** if it survives triage as a genuinely separate, already-documented class; otherwise delete |
| `TS5101` (deprecated `baseUrl` warning) | all 3 | keep — it is a *warning* about the harness's own tsconfig, not an error in generated code |

What replaces them is a **location** check, not a message check: keep an error only if its reported file location is
inside the generated project and outside `node_modules`. That is scoping the gate to its subject (consumer-emitted
code), which is what the filter was always *meant* to be; it is not an error-class filter, and it is what #576's own
"Fix" section asks for.

Then fix what tsc truly reports. Two known targets:

- **#575** — vendored events: `generated/bus.ts` imports `'../events-errors'`, which `VENDORED_RUNTIME_FILES`
  (`init-scaffold.ts:146-199`) does not vendor; `runtime/subsystems/events/event-scheduler.ts` imports
  `'./events-errors'` and has the same gap. If it is the one-file vendoring omission #575 describes, fix it here and
  close #575.
- **The 2 errors GATE-1 measured on the green `clean-lite-ps` path** (GATE-1 §Failure 2: raw tsc = 2, reported = 0).
  Identify and fix both.

A residual class that genuinely cannot be fixed here gets its own issue **and** a named, single-purpose, commented
expectation in the harness — never a broad filter (I9). `just test-smoke-junction-clean` is explicitly excluded from
this work: it is known-red on #602, it is in neither `test-all` nor CI, and this PR neither repairs it nor filters
for it.

### 6. drizzle-kit

The generator never runs kit except `src/cli/commands/dev.ts:284` (`bunx drizzle-kit push --config …`) and the
scaffold integration harness (`drizzle-kit push` against `test/scaffold/drizzle.config.ts`). Verify push still works
on kit 1.0 — `just test-integration` is the gate that proves it. Document the rc.4 `generate` output layout
(`<timestamp>_<name>/{migration.sql,snapshot.json}`, snapshot `version: "8"`, no `meta/_journal.json`) under
`docs/consumer/` so a consumer knows what changed; **verify the layout against the installed kit before writing it
down**, do not copy the draft's numbers.

### 7. Docs + version

- `CHANGELOG.md` — extend the existing `[Unreleased] — 0.31.0` block (DRZ-1 already opened it): Drizzle 1.0 line is
  now required; `drizzle-orm` is a peer dependency; emitted `database.module.ts` uses `drizzle({ client })`.
- `docs/CONSUMER-SETUP.md` — `:15` prerequisite (`drizzle-orm@^0.30`), the `database.module.ts` example at `:85-115`,
  requirement 4 at `:123` ("client constructed with full schema" — no longer true), and the troubleshooting section:
  **replace** the "Type errors referencing `shouldInlineParams` or `PgColumn`" entry (`:764-769`) whose advice is
  "pin `drizzle-orm@^0.30.x`", and keep/retarget the separate two-copies entry (`:771`) — add the linked-package caveat
  (a `bun link`-ed codegen still resolves its own dev copy; fix on the consumer side via tsconfig `paths` /
  `preserveSymlinks`, or install from a tarball).
- `README.md` has **no** dependency table and no drizzle version (verified) — the draft's README item is dropped.
- `consumer-skills/` mentions no `drizzle-orm` version (verified) — no change.
- `CLAUDE.md` › Known-red gates — the row still tracks `test-smoke-junction-clean` to #599; the split issue has since
  been filed as **#602**. Correct it (living documentation).
- **No version bump in this PR.** 0.31.0 is already open in `[Unreleased]`; cutting the release is the owner's call
  and merging a bump publishes (CLAUDE.md › Release). Open question below.

## Out of scope

`defineRelations()` / any v2 relations emission (REL-1); consumer migration-history continuity; any consumer
production pin; the `clean` backend pipeline and its known-red gate (#602).

## 1.0 API surface we depend on — checklist for the next RC / GA bump

Re-verify each row when moving off `1.0.0-rc.4`. Each is load-bearing somewhere in this repo.

| # | Surface | Shape we depend on | Where it bites |
|---|---|---|---|
| A1 | `drizzle()` (node-postgres) | `drizzle({ client: pool })`; config is `Omit<DrizzleConfig, 'schema'>` + `codecs?`; `relations` is the slot REL-1 fills | emitted `database.module.ts`; scaffold `database.module.ts` + `tests/setup.ts`; `docs/CONSUMER-SETUP.md` |
| A2 | `NodePgDatabase<TRelations extends AnyRelations = EmptyRelations>` | usable unparameterised and with `any` | `runtime/types/drizzle.ts`; emitted `DrizzleDB` |
| A3 | insert `.returning()` typing | `TReturning = TTable['$inferSelect']`, result `TReturning extends undefined ? QueryResult<never> : TReturning[]` — so the table type must not be `any` | the 3 TS7053 sites; `BaseRepository.table: PgTableWithColumns<TableConfig>` |
| A4 | `PgTableWithColumns<TableConfig>` | assignable from a concrete `pgTable(...)`; index access yields `PgColumn` | `BaseRepository.table`, every generated repository's `table` property |
| A5 | `getColumns` | exported from the root; `getTableColumns` deprecated | 4 schema specs |
| A6 | pg codecs / pg-proxy param mapping | jsonb params reach the driver callback as **objects**; jsonb row values pass through **unparsed** | the 4 integration runtime specs (cursor store, run recorder) |
| A7 | `relations` **absent** from the root export | nothing imports it | guarded by DRZ-1's `src/__tests__/templates/no-v1-relations-emission.test.ts` |
| A8 | `pgTable(name, cols, cb)` extraConfig | the object-returning form still type-checks (array form is the 1.0 shape) | `runtime/subsystems/**/*.schema.ts`, generated schemas — if the object form is dropped in a later RC this becomes a wide mechanical change |
| A9 | `drizzle-kit push` + `defineConfig` | unchanged invocation on kit 1.0 | `src/cli/commands/dev.ts:284`; `just test-integration` |

## Acceptance

Output from the run made **after the last edit** (charter I9).

- `bun run typecheck && bun run build && bun run test` green.
- `just test-all` green — after GATE-1 that is `typecheck` + `test-unit` + `test-baseline` + `test-smoke` +
  `test-smoke-subsystems` + `test-smoke-relationship` + `test-smoke-junction` + `test-smoke-junction-cross-domain` +
  `test-junction` + `test-integration-emit` + `test-smoke-integration`. It does **not** include
  `test-smoke-junction-clean` (known-red, #602).
- `just test-integration` green (Docker).
- `just test-post-publish` green (tarball peer range resolves).
- **No filtered error classes** in any smoke: the only exclusions left are location-scoping and `TS5101`.
- Generated project boots and serves `/docs-json` with non-empty component schemas
  (`test/smoke/verify-openapi.ts`).
- `grep -rn "drizzle-orm@0\|drizzle-kit@0\|drizzle-orm@\^0\|drizzle-kit@\^0\|\^0\.45\|0\.30↔0\.45"` over tracked
  files → nothing that describes current state (CHANGELOG history and prior specs are history, not current state).
- `grep -rn "drizzle(pool"` over tracked files → no emitter, runtime, scaffold or doc hit.
- #576 closed by this PR; #575 closed or explicitly carried with a reason.

## Risks

- **rc.4 → GA drift.** Mitigated by the checklist above and by exact pins in every harness.
- **Deleting the filters exposes more than #575 + the 2 known errors.** Time-box; split with issues and named
  single-purpose expectations rather than re-filtering. Report every residual class in this spec.
- **Narrowing `BaseRepository.table` breaks a generated repository's assignment.** `PgTableWithColumns<TableConfig>`
  must accept a concrete `pgTable(...)`. Typecheck proves the runtime; the four smokes + the baseline prove the
  generated side. If a concrete table is rejected, fall back to constraining the generic on the class rather than
  re-introducing `any`.
- **Two drizzle copies in this repo's own `node_modules`.** If the transitive 0.45.2 survives the swap, the
  dual-identity failure mode moves from consumers into our own harnesses.

## After merge — mandatory checkpoint (charter §6)

Post a checkpoint entry on #578 and revise `PLAN.md` / the charter against what this PR actually surfaced, before
TEN-1 / REL-1 / SEM-1 / CAP-1 start.

## Implementation order

1. Dependency shape (§1). `bun install`.
2. Runtime type fix + the 4 spec corrections + `getColumns` (§2). `bun run typecheck && bun test src/__tests__/runtime`.
3. Emitted scaffold (§3) + harness pins and scaffold API (§4). `just test-smoke` first, then the rest.
4. Delete the filters (§5); measure; fix #575 and the 2 masked `clean-lite-ps` errors; triage residuals.
5. drizzle-kit verification + `docs/consumer/` layout note (§6).
6. Docs (§7).
7. Full gates from a clean tree, after the last edit.

## Open questions

- **Version bump in this PR?** Default: **no**. `[Unreleased] — 0.31.0` stays open; merging a bump publishes, so
  cutting the release is the owner's call. Resolve at review if the owner wants 0.31.0 cut with this PR.
