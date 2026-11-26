# Plan: the `{ database: sqlite, orm: drizzle }` pair crew needs (follow-up 3, board d1)

2026-11-26. Lead: this session. **A plan for a sequence of PRs, not one.** It changes output by design: new goldens,
plus a test against crew's store suites. It comes after TGT-1, which puts constraints behind the target. Crew facts
are from `~/Farm/crew/checkouts/crew/main` (DESIGN.md Settled 29, d44-d47; `src/modules/teams/**`).

## What crew needs, from its own code

- **The interface to emit against** (d46): `createSqlite<X>Store(sql: SqlHandle) → <X>Repositories`. It is async,
  cheap to build per transaction, and the use cases get `store: (tx) => <X>Repositories`.
  - `SqlHandle` is crew's raw SQL capability (`run`/`get`/`all`/`exec`, `src/core/database/database.protocol.ts`), not
    a Drizzle client.
  - Crew's conformance suites (`<module>/domain/testing/assert-<module>-repositories.ts`) take `within(fn)` and run
    each step in a transaction of its own.
- **The repositories are domain-shaped, not CRUD.** `AgentRepository` is `get(address)`, `onTeam(team)`,
  `add(agent)` and `move(next)`, where `move` is compare-and-set on `rev` and returns `undefined` when someone moved
  first.
- **The schemas are not codegen's shape** (`teams.sql`):
  - `teams_team` has a composite primary key `(project, id)` and no uuid `id`.
  - `teams_agent` has an autoincrement `seq` plus `UNIQUE (project, team, agent)`.
  - Times are `TEXT`, flags are `INTEGER`, and there is a `rev INTEGER`.
- **Zod-first.** Rows are checked against the domain Zod schemas on the way out. Crew is on Zod 4; codegen is on
  Zod 3 (slice s3).
- **No DI and no HTTP.** The stores are wired by crew's typed wiring; `drizzle-orm` becomes a crew dependency only
  then (t35).

## The key technical finding: Drizzle runs on crew's handle, given one more method

`drizzle-orm/sqlite-proxy` builds an async Drizzle database from one callback, `(sql, params, method) → { rows }`.
crew's `SqlHandle` (`run` / `get` / `all`) almost fits, with one exception (correction from crew's s3 session,
checked against drizzle's source):
- The proxy wants **rows as arrays of values in column order**, not objects. `get` returns one array, and `all` /
  `values` return an array of arrays. Its mapper reads them by position (`mapResultRow(columns, row)` →
  `row[columnIndex]`, `drizzle-orm/utils.js`; the proxy session hands `rows` straight to it,
  `sqlite-proxy/session.js`).
- crew's `get` / `all` return objects, so they can't feed the proxy as they are. Objects would also lose a value
  whenever two selected columns share a name (a join).

The fix is on crew's side: `SqlHandle` gains a `values(sql, …params): Promise<SqlValue[][]>`, which `bun:sqlite`
has natively (`Statement.values()`). The emitted store then does `const db = drizzle(proxyOver(tx.sql))` per
transaction, with `get` mapped to `values(…)[0]` and `run` mapped to `run`:
- crew's transaction rules (joins by async flow, flows kept apart, a handle that is dead after commit) hold unchanged;
- crew's database system needs no Drizzle-specific backend.

The first PR proves this with a spike test against a `bun:sqlite` `SqlHandle` that has `values()`, before anything
else is built on it. **Needs crew:** adding `values()` to `SqlHandle` (a protocol change, so it's crew's decision).

## The sequence

| # | PR | What it emits / changes | Proof | Depends on |
|---|---|---|---|---|
| A | **TGT-2a: the pair's column + constraint renderers** | a row in `TARGET_PAIRS`; `src/targets/drizzle/sqlite/{columns,constraints}.ts` (`sqliteTable`, `text`/`integer`/`real`/`blob`, `{ mode: 'boolean' \| 'timestamp' \| 'json' }`, `.references`, `index`, `uniqueIndex`; no enums, so `choices` is `text({ enum })` plus a check) | its own render goldens for the baseline fixture set under the sqlite pair; postgres goldens unchanged | TGT-1 |
| B | **TGT-2b: what's typed on Postgres becomes per-pair** | the repository template and base classes, `PgTable`/`AnyPgColumn` typing, the `entity.ejs.t` imports, the `PG_IDENTIFIER_MAX_BYTES` rule | the sqlite goldens typecheck against `drizzle-orm/sqlite-core` | A |
| C | **YAML growth crew's tables need** (d2) | composite primary key (building on #780 natural keys and #787 composite FKs); `rev` as a declared CAS column (`move` = `UPDATE … WHERE rev = ?`); an opt-out of the uuid `id` | schema tests; postgres goldens unchanged unless a key is used | none; can run alongside A and B |
| D | **Whole generated modules on the Nest-free target** (d12, 2026-11-26: codegen-patterns is the primary app-generation engine; crew becomes a full codegen project, with only its policy hand-written) | per module: tables, repositories (`<X>Repositories`, built per transaction on `sqlite-proxy` over a handle), services, wiring (`target.wiring: plain`, crew's typed wiring) and tests in crew's `__tests__/` layout | **crew's conformance suites run against the generated modules**, committed in crew and run by its `just check` (d10), plus codegen's own `:memory:` smoke | A, B, C, s3 (Zod 4), and gap-map's (s9) list of what codegen lacks |

`http` stays Nest-only (crew has no HTTP). `runtime: bun` joins when D needs `bun:sqlite` at the edges; the proxy
approach means the emitted code itself is runtime-neutral.

## The gap in D: domain-shaped vs generated repositories

> **2026-11-26, d12.** D is no longer "stores for crew's hand-written modules": crew becomes a full codegen project,
and codegen generates whole modules. d9/d10 already say crew takes codegen's standard (the YAML names the methods;
conformance runs in crew). The options below are kept for the record. gap-map (slice s9) maps what codegen still
needs.

Codegen emits `findById`/`create`/`update`/`delete` plus declarative `queries: by:`. Crew's repositories are named in
crew's terms (`onTeam`, `move`). Three ways to close the gap:

1. **Crew's YAML names the methods.** `queries:` grows a `name:`, and `move` becomes the emitted CAS update named by
   the YAML. The generated store then *is* `<X>Repositories`. This is the most generation, and the most YAML growth.
2. **Codegen emits generic repositories, and crew keeps a thin hand-written adapter** per module mapping its
   interface onto them. Less growth, but crew keeps code that a template could hold.
3. **Codegen emits only tables, and crew keeps its stores** but writes them in Drizzle instead of SQL strings. The
   least growth and the least value.

Recommendation: **1**, since it is where d2 ("the YAML grows") already points. But it is Doug's and crew's call, and
it decides how big C and D are.

## Risks

- **Crew's conformance suites live in crew.** The test needs either a cross-repo fixture (codegen pins a crew commit)
  or crew running codegen's output in its CI. Default: crew's CI, with codegen's own gate being typecheck plus a
  `:memory:` smoke of the generated store.
- **Zod 3 vs 4.** D's emitted row schemas must be Zod 4 for crew, so s3 (Zod 4 everywhere) is a prerequisite for D,
  not for A–C.
- **Enum semantics.** SQLite has no enum type. `choices` becomes `text({ enum: [...] })` (type only) plus a `CHECK`,
  which is a per-pair constraint fact and arrives in A's renderer. The s5 issue 3 (`choices` ignoring `required`) must
  not be copied into the new renderer.

## Needs Doug (and crew)

0. **crew's `SqlHandle` gains `values()`** (positional rows for `sqlite-proxy`). That is crew's protocol, so it's
   crew's call.
1. **How D closes the domain gap: 1, 2 or 3.** Default 1. crew's s3 session leans 2 (generated generic store plus
   a thin crew adapter). Open on the board.
2. **Where the conformance test runs.** Default: crew's CI against a codegen build, plus codegen's own `:memory:`
   smoke. crew's s3 session leans: the generated stores are committed in crew and run in crew's own `just check`.
   Open on the board.
3. **Order against s3 (Zod 4).** Default: A, B and C don't wait for it; D does.

When TGT-1 is in review, A gets a per-PR plan of its own (like TGT-0's), with the spike test as its first commit.
