# DRZ-2 — drizzle-orm 1.0.0-rc.4: generator, runtime, scaffold, harnesses

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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
- The 0.45.2 copy in `bun.lock` arrives transitively: the five surface packages under `packages/` peer-depend on
  `@pattern-stack/codegen` by RANGE (`>=0.20.0 <1.0.0`), so bun resolves that peer from npm (0.30.0), which still
  declares `drizzle-orm ^0.45.2`. **Verified harmless:** the copy exists only in bun's store under
  `.bun/@pattern-stack/codegen@0.30.0/`; `node_modules/@pattern-stack/` contains only workspace symlinks, there is no
  `node_modules/@pattern-stack/codegen`, and `node_modules/drizzle-orm` is 1.0.0-rc.4. Nothing in this repo resolves
  the old copy. (It did bite during the spike: a probe script placed in `/tmp` resolved `drizzle-orm` from outside the
  repo and silently picked up 0.45, producing a misleading result. Probe from inside the repo.)
- `bun.lock` is **gitignored** here, so the pins that travel are the ones in `package.json`. That is why the
  devDependency pin is exact rather than a caret.

### 2. Runtime (`runtime/**`)

- Fix the three TS7053 sites. **The design's fix was wrong and was replaced — see Found #1.** What shipped: a typed
  assertion on the awaited result (`as TEntity[]` / `as Record<string, unknown>[]`) at each of the three sites,
  replacing the element-level `rows[0] as TEntity` that was already there. No new `any`, no `as unknown as`; the
  assertion states a fact the 1.0 types cannot express while the table type is `any` (the union's non-array arm is
  unreachable because `.returning()` was called), and it is the same assertion the element-level cast always made.
  Each site carries a comment naming the cause and **#603**, which tracks the real fix.
  - The other `PgTableWithColumns<any>` occurrences (`base-repository.ts:356`, `integrated-entity-repository.ts:281`,
    `junction-integration-repository.ts:25,28,213,233`, `integration-upsert-config.ts:37`,
    `metadata-entity-repository.ts:22`) are the same class and are covered by #603. Not touched here.
- Correct the 4 runtime specs to the measured 1.0 param/row contract (per §Spike). The affected specs' header
  comments document the old contract and must be corrected too, or the next reader re-learns it the hard way.
- `getTableColumns` → `getColumns`. 1.0 still exports `getTableColumns` but marks it `@deprecated`
  (`drizzle-orm/utils.d.ts:50-54`), so this is I7 hygiene rather than a compile break. **Four** spec files, not the
  three PLAN §4.3 lists: `src/__tests__/runtime/subsystems/{integration-audit,job-orchestration,bridge-delivery,domain-events}.schema.spec.ts`.
- `runtime/types/drizzle.ts` — `NodePgDatabase<any>` compiles on 1.0 (1.0's generic is
  `TRelations extends AnyRelations = EmptyRelations`). **Left as-is**: the `any` is pre-existing, and REL-1 is what
  gives it a real relations type. Narrowing it to `EmptyRelations` now would have to be undone by REL-1.

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

What replaced them is **one shared helper**, `test/smoke/_consumer-errors.ts`, imported by all three harnesses
(the "kept narrow + duplicated intentionally" comment no longer holds: three copies of a subtle location parser is
exactly DRZ-1 Found #6's failure mode). It has **14 unit tests**
(`src/__tests__/smoke/consumer-errors.test.ts`) pinning that each previously-filtered message class now *fails* a
gate, and it keeps `tsc`'s indented elaboration lines attached to their diagnostic — without them a red TS2416 is
unreadable, which cost a diagnosis round-trip during implementation.

`TS5101` needed no exclusion after all: the scaffold stopped emitting `baseUrl` (GATE-1 era), so the deprecation
never fires. **Zero exclusions remain.**

**Measured surface after deletion, and what each class turned out to be** (main smoke, 14 errors):

| Class | n | Root cause | Outcome |
|---|---|---|---|
| `src/modules/connections/**` → `../connection.{service,entity}`, `./connections.module` | 13 | `subsystem install auth-integrations` vendors `connection.yaml` into `entities/` *after* step 5's `entity new --all`, and its own next-step output says to run `entity new connection`. The smoke stopped one command short of the documented consumer flow. | **Fixed by completing the flow** — new step 5.8 runs `entity new entities/connection.yaml --force` and asserts `connection.service.ts` exists. All 13 clear. The old comment's claim that this "surfaces a separate codegen enum literal-type bug" is no longer true. |
| `generated/bus.ts` → `'../events-errors'` | 1 | #575 | **Fixed**, see below |

Junction smoke (clean-lite-ps) then surfaced a sibling of #575: `generated/bus.ts` → `'../events.tokens'`.
`eventsRuntimeImports()` (`event-codegen-generator.ts:114-118`) is the closed list of the generated bus's three
vendored-mode sibling imports — protocol, tokens, errors — and only the protocol was in `VENDORED_RUNTIME_FILES`.
All three are now vendored, plus `subsystems/token-key.ts` (`events.tokens.ts`'s only relative import), with a
comment naming the closed list so a fourth import cannot be forgotten. **These two are exactly the "2 errors GATE-1
measured on the green `clean-lite-ps` path"** — confirmed by `just test-smoke-junction-clean` falling from GATE-1's
raw 120 to 118.

Subsystems smoke (package leg) surfaced one more: `src/worker.ts` →
`'@pattern-stack/codegen/runtime/subsystems/jobs/index'`, which the old junction/subsystems filters dropped by
matching `'@pattern-stack/codegen/`. The package is not installed in checkout mode. **Fixed by telling tsc where it
is** — the isolated check-dir tsconfig now maps `@pattern-stack/codegen/runtime/*` and friends onto this checkout's
own source. That is strictly stronger than the exclusion: the gate now proves the specifier resolves to a file that
exists, where before any wrong package specifier passed. It resolves against `runtime/` source rather than the
published `dist/`; the export-map contract is `just test-post-publish`'s job, and that gate is green.

**Residual, not fixed here, both tracked:**

- **#602** — `just test-smoke-junction-clean`. Untouched, no filter added, no repair attempted (charter §5 non-goal).
  It now reports its real number, 118, instead of 21 through a filter. `CLAUDE.md` › Known-red gates updated with the
  new number and retargeted from #599 to #602.
- **#604** — `just test-smoke-integration` scopes its pass/fail to `src/integrations/**` and *prints* the rest. That
  print is 7 errors: 6 × the list use-case emitting `desc(<table>.createdAt)` for entities with no `timestamps`
  behavior, plus one duplicate-`@nestjs/common` artifact of the harness. **Proven pre-existing**, not caused by the
  bump: reproduced byte-identically on a clean `dugshub/599-honest-gates` worktree at `drizzle-orm@0.45.2` (only the
  type printout differs, `PgColumn<…>` vs 1.0's `PgBuildColumn<…>`). Recorded in `CLAUDE.md` beside the known-red
  table.

### 6. drizzle-kit

The generator never runs kit except `src/cli/commands/dev.ts:284` (`bunx drizzle-kit push --config …`) and the
scaffold integration harness (`drizzle-kit push` against `test/scaffold/drizzle.config.ts`). `push` works unchanged
on kit 1.0 — `just test-integration` is green, including its `Schema pushed` step. `defineConfig` is unchanged.

The `generate` layout was **verified against the installed `drizzle-kit@1.0.0-rc.4`**, not copied from the draft
(the draft said `version: "8"`; it is the number `8`):

```
drizzle/20260917225701_goofy_the_santerians/
  migration.sql
  snapshot.json      # version: 8, dialect: "postgres",
                     # keys: ddl / dialect / id / prevIds / renames / version
```

One directory per migration, no `meta/_journal.json` — ordering comes from each snapshot's `prevIds`. Written up in
the new `docs/consumer/drizzle.md`, linked from CONSUMER-SETUP's reference list.

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
| A3 | insert `.returning()` typing | `TReturning = TTable['$inferSelect']` (`insert.d.ts:84`), result `TReturning extends undefined ? QueryResult<never> : TReturning[]` (`insert.d.ts:96`). While the table type is `any` this is a union, so the result needs an assertion. `update().set().returning()` is NOT affected — `PgUpdateReturningAll` builds `TReturning` from `SelectResult<…>` (`update.d.ts:64`). | the 3 insert sites in `runtime/base-classes/`; tracked properly by **#603** |
| A4 | `PgTableWithColumns<T>` | `= PgTable<T> & T['columns'] & {…}` (`pg-core/table.d.ts:21`). With `T = any` the intersection collapses to `any`. With `T = TableConfig` it is **not** a supertype of a concrete table (`TableConfig['columns']` is an index signature a concrete column map does not satisfy) and string-indexing it yields `PgColumn \| undefined` under `noUncheckedIndexedAccess`, which consumer tsconfigs set. | `BaseRepository.table` stays `<any>`; see Found #1 and **#603** |
| A5 | `getColumns` | exported from the root; `getTableColumns` deprecated | 4 schema specs |
| A6 | pg codecs / pg-proxy param mapping | jsonb params reach the driver callback as **objects**; jsonb row values pass through **unparsed**. `Date` params are still ISO-stringified by pg-proxy. The `drizzle(async (sql, params, method) => …)` callback signature itself is unchanged. | the 4 integration runtime specs (cursor store, run recorder), and any future spec asserting captured params for a jsonb column |
| A7 | `relations` **absent** from the root export | nothing imports it | guarded by DRZ-1's `src/__tests__/templates/no-v1-relations-emission.test.ts` |
| A8 | `pgTable(name, cols, cb)` extraConfig | the object-returning form still type-checks (array form is the 1.0 shape) | `runtime/subsystems/**/*.schema.ts`, generated schemas — if the object form is dropped in a later RC this becomes a wide mechanical change |
| A9 | `drizzle-kit push` + `defineConfig` | unchanged invocation on kit 1.0 (proven by `just test-integration`). `generate` writes `drizzle/<ts>_<name>/{migration.sql,snapshot.json}`, snapshot `version: 8`, no `meta/_journal.json`. | `src/cli/commands/dev.ts:284`; `test/scaffold/drizzle.config.ts`; `docs/consumer/drizzle.md` |
| A10 | plain `1.0.0-rc.N` versions exist on npm | both `drizzle-orm` and `drizzle-kit` publish hash-free `1.0.0-rc.*` alongside many `1.0.0-rc.N-<sha>` builds. Pin the **plain** one; `drizzle-kit@latest` is still `0.31.x`, and its `rc` dist-tag is what tracks the 1.0 line. | the exact pins in `package.json` and the four harness `RUNTIME_DEPS` lists |

## Found during implementation

Things the pre-implementation spec got wrong or missed. Each is reflected in the sections above.

1. **The designed fix for the 3 TS7053 errors was wrong.** Narrowing `BaseRepository.table` to
   `PgTableWithColumns<TableConfig>` does clear all three and makes `bun run typecheck` exit 0 — which is exactly why
   it looked right. It is wrong for *generated* code, and only the smoke gates say so:
   - 5 × `TS2416` on generated repositories — `PgTableWithColumns<concrete>` is not assignable to
     `PgTableWithColumns<TableConfig>`, because `TableConfig['columns']` is `Record<string, PgColumn>` and a concrete
     column map has no index signature ("Index signature for type 'string' is missing").
   - ~35 further errors in the vendored base classes — consumer tsconfigs set `noUncheckedIndexedAccess: true`, so
     `this.table['id']` becomes `PgColumn | undefined`.

   The repo's own `tsconfig.build.json` compiles no concrete subclass, so neither shows up in `bun run typecheck`.
   Shipped instead: a typed assertion on the awaited result at the three sites, and **#603** for the real fix
   (make the class generic over its table and read columns via `getColumns`) — which REL-2/REL-3 needs anyway.

2. **The 4 failing specs were not "assert SQL/params" in general — they were four instances of one jsonb mapping
   change**, and the diagnosis had to be done from *inside* the repo. A probe script written to the scratchpad
   resolved `drizzle-orm` from outside the repo and silently picked up the transitive 0.45.2 copy, producing a
   confident and wrong "behaviour unchanged" reading. Two of the four are read-side (a fixture that returned a JSON
   *string* where `pg` returns an object) and two are write-side (params).

3. **The smoke filters were three copies, and the `.schema.ts` / message-class exclusions were only half of it.**
   The real blocker for #576 was that the exclusions matched the error *message*. Replaced by one shared helper with
   unit tests rather than three synchronised copies.

4. **`TS5101` needed no exclusion.** The scaffold stopped emitting a deprecated `baseUrl`, so the diagnostic the
   filter was written for no longer fires. Zero exclusions remain, not one.

5. **Deleting the filters surfaced three classes, not the one the spec predicted** — and all three were fixable at
   the root rather than needing a named expectation: the smoke stopping one command short of the documented consumer
   flow (13 errors), #575 *plus an unlisted sibling* (`'../events.tokens'` — the generated bus has three vendored
   siblings, not two), and an unresolved package specifier that the subsystems smoke could simply be told how to
   resolve. See §5.

6. **`getTableColumns` appears in 4 spec files, not 3**, and `drizzle-orm@0.45` appears in 4 harnesses, not 2. Both
   counts came from PLAN §4.3 and were stale.

7. **`test/scaffold/package.json` needed no pin at all** (GATE-1 emptied it deliberately); the scaffold's actual 1.0
   work was its `database.module.ts`, `tests/setup.ts` and `schema.ts` header. The draft had this backwards.

8. **`drizzle(pool)` — the single positional form — is also gone in 1.0**, not just `drizzle(pool, { schema })`.
   Three `test/integration/*.drizzle.integration.test.ts` files used it. Those run outside `test-all`, so nothing
   would have caught them.

9. **The scoping helper had to keep `tsc`'s elaboration lines.** The first version returned primary lines only,
   which made a TS2416 unreadable and cost a diagnosis round-trip — the "why" is entirely in the indented chain.

## Acceptance — all met

Output from the run made **after the last edit** (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | **exit 0** |
| `bun run build` | **exit 0** |
| `bun run test` (baseline) | **exit 0** — all passed |
| `just test-all` | **exit 0** — typecheck · unit 3160/3160 · baseline · smoke · smoke-subsystems (vendored + package) · smoke-relationship · smoke-junction · smoke-junction-cross-domain · junction snapshots · integration-emit · smoke-integration |
| `just test-integration` | **exit 0** — 64 pass · 2 skip (pre-existing `test.skip` in `bridge-e2e.test.ts`) · 0 fail |
| `just test-post-publish` | **exit 0** — tarball contract + full consumer workflow from the tarball |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, unchanged by design; now reports its real 118 |

- **No filtered error classes** in any smoke. The only thing `test/smoke/_consumer-errors.ts` drops is a diagnostic
  whose *file location* is outside the generated project or inside `node_modules` — the gate's subject, not an error
  class. `TS5101` needed no carve-out.
- Generated project boots and serves `/docs-json` with non-empty component schemas: 19 schemas / 12 paths
  (`test/smoke/verify-openapi.ts`), plus the closed-by-default auth boot check.
- `git grep -nE "drizzle-orm@0|drizzle-kit@0|drizzle-orm@\^0|drizzle-kit@\^0"` → one hit, the `CLAUDE.md` line that
  *records* the 0.45.2 pre-existence proof for #604. Nothing describes current state.
- `git grep -n "drizzle(pool"` → two hits, both correct: the before/after table in `docs/consumer/drizzle.md`, and
  `src/__tests__/scanner/orm-detector.test.ts`'s sample-consumer fixture, which was also moved to the 1.0 form.
- **#576 closed** (the filters are gone, with unit tests pinning the behaviour). **#575 closed** (all three of the
  generated bus's vendored siblings, plus `token-key.ts`). **#603** and **#604** filed for what could not be fixed
  in scope.
- `drizzle-orm` as a required peer resolves end-to-end: the tarball smoke's `npm install` auto-installs it, and every
  `exports` entry imports under node — `./subsystems` would throw `ERR_MODULE_NOT_FOUND` otherwise.

## Risks — outcome

- **rc.4 → GA drift.** Open. Mitigated by the A1–A10 checklist and by exact pins in every harness.
- **Deleting the filters exposes more than #575 + the 2 known errors.** It did (§5, Found #5) — and all of it was
  fixable at the root. Nothing needed a named expectation.
- **Narrowing `BaseRepository.table` breaks a generated repository's assignment.** **This one happened** (Found #1),
  and only the smoke gates caught it — `bun run typecheck` was green with the broken narrowing, because the repo
  compiles no concrete subclass. Worth remembering: a runtime-type change is not validated by this repo's typecheck.
- **Two drizzle copies in this repo's own `node_modules`.** The transitive 0.45.2 survives in bun's store but is
  unreachable from anything this repo compiles (§1). It *did* mislead a spike probe written outside the repo
  (Found #2).

## After merge — mandatory checkpoint (charter §6)

Post a checkpoint entry on #578 and revise `PLAN.md` / the charter against what this PR actually surfaced, before
TEN-1 / REL-1 / SEM-1 / CAP-1 start.

## Implementation order — as executed

1. Dependency shape (§1). `bun install`.
2. Runtime fix + the 4 spec corrections + `getColumns` (§2). `bun run typecheck && bun test src/__tests__/runtime`.
3. Emitted scaffold (§3) + harness pins and scaffold API (§4).
4. Delete the filters (§5); measure; fix each class at its root; file #603/#604 for what could not be.
5. drizzle-kit verification + `docs/consumer/drizzle.md` (§6).
6. Docs (§7).
7. Full gates from a clean tree, after the last edit.

**One process note worth carrying forward:** step 2 was declared done on a green `bun run typecheck`, and step 4's
first smoke run is what revealed the fix was wrong. For anything touching `runtime/base-classes/**`, run
`just test-smoke` *before* believing typecheck.

## Open questions

**Resolved: no version bump in this PR.** `[Unreleased] — 0.31.0` stays open and now carries both DRZ-1's and DRZ-2's
entries. Merging a version bump publishes (CLAUDE.md › Release), so cutting 0.31.0 is the owner's call and should be
its own commit once the unit is done. Nothing in this PR depends on it.

No others.
