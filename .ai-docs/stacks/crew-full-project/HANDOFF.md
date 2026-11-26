# Handoff 2026-11-26: generate crew as a full codegen project (Nest-free, SQLite)

For whoever picks this up in codegen-patterns. It is everything the codegen-targets project
(`~/Farm/codegen-targets` on Doug's Mac) learned and settled, in one place. Read this, then `GAP.md` (the gap list,
with file:line evidence), then `PLAN-SQLITE-DRIZZLE-PAIR.md` and `NEST-INTEGRATION.md` (background).

`crew:` paths refer to crew, Doug's agent-orchestration package: private repo github.com/dugshub/crew, main at
`c181166`. The gap analysis read crew at that commit.

## Direction (Doug, settled)

- **codegen-patterns is the primary app-generation engine. Full codegen projects come first.**
- **crew becomes a full codegen project on a Nest-free target**: Drizzle on SQLite, plain typed wiring, Zod 4, async
  repositories. Only crew's *policy* stays hand-written: the tree rule, liveness, state transitions, refusals.
- **codegen sets the standard.** crew's stores take codegen's standard repository shape, and crew's use cases adapt.
  Anything the standard can't express (compare-and-set, set-once updates, counts, composite keys…) is a gap to build
  here, not something to paper over in crew.
- **codegen supplies the tests**: generated store conformance suites, as strict as crew's hand-written
  `assert-*-repositories` ones, replace them.
- **No NestJS for crew.** codegen gains other DI setups. crew's module system (manifests, typed wiring, layer and purity
  rules in `crew:scripts/architecture.ts`) is the candidate for the plain-wiring target. Generation goes all the way up
  to the service/data layer.

### Already settled on the way (codegen-targets board d1–d12)

| # | Settled |
|---|---|
| d1 | crew's first cut is Drizzle on SQLite (bun:sqlite, through `drizzle-orm/sqlite-proxy` over crew's transaction handle) |
| d2 | The entity YAML grows: `rev` compare-and-set, composite keys (build on #780, #787; epics #783, #793), then value objects |
| d3 | Zod 4 everywhere, its own PR first |
| d4/d5 | crew's `wiring.ts` becomes its own small package; plain wiring emits one flat composition (no per-entity module graph, no forwardRef cycles) |
| d6 | Repositories are async everywhere (one protocol for SQLite, Postgres, Redis) |
| d7 | `target: { database, orm }`, one table of supported pairs (`TARGET_PAIRS`); later keys http, wiring, runtime |
| d8 | Zod 4's own error wording |
| d9 | codegen's standard repository shape; crew adapts; gaps get built in codegen |
| d10 | codegen-generated conformance suites replace crew's |
| d12 | primary engine; full codegen projects first; Zod 4 in generated code follows ZOD-0 directly, as a major |

## In flight (one stack, Doug merges it down)

`dugshub/studio-single-react` (Studio test fix: one React for the test run, so test-file order can't break CI)
→ **#941** TGT-0b (target as a (database, orm) pair; `codegen-config.schema.json` for editor autocomplete)
→ **#946** TGT-1 (constraints behind the target, byte-identical)
→ **#945** ZOD-0 (codegen's own code on Zod 4; generated code unchanged; the entity JSON Schema now comes from the
real schema, #696).

Auto-merge stays **off** for every PR in the stack. A stacked PR that auto-merges lands on its base branch, not main.
That's how #940's amendment was lost. The repo doesn't delete merged branches, so after a squash-merge, rebase the
next layer with `git rebase --onto origin/main <old-base-tip>` and retarget it to main.

Filed: #942, #943, #944 (relationship pipeline field bugs), plus a comment on #867.

## The work: GAP.md's list

Sizes are the analysis's guesses: S ≈ a day, M ≈ 2–4 days, L ≈ a week (human pace).

| # | What | Size |
|---|---|---|
| G1 | Keys: composite natural primary key, an ordering column, a declared identity (`key:`) used by get/update/move instead of `id` | L |
| G2 | Value objects: `shape:` fields as prefixed columns; named shapes; tagged unions over a `kind` column (no issue covers this yet) | L |
| G3 | The plain/sqlite record schema: Zod 4 per noun; a nullable column reads as a *missing* field; `instant` as ISO TEXT; typed `json` | M |
| G4 | `versioned: rev`: compare-and-set `move(next) → row \| undefined` (the `versionable` behaviour is a stub today) | M |
| G5 | Guarded updates: named `updates:` with a `where` on current values (set-once = `WHERE x IS NULL`) → `row \| undefined` | M |
| G6 | Queries: `name:`, `where` with missing / in / range, `count: true`, and a `limit` that works | M |
| G7 | `wiring: plain` store: `create<Backend><Module>Store(handle) → <Module>Repositories`, built per transaction on sqlite-proxy; a miss is `undefined` | L |
| G8 | Module grouping and layer-placed output (`domain/`, `application/`, `infrastructure/<backend>/`) | M |
| G9 | SQLite DDL: emit `<module>.sql` from the same field facts | S–M |
| G10 | Emitted conformance suites `assert-<module>-repositories.ts` from keys, order, `versioned`, `updates`, scopes, with a `:memory:` runner | M |
| G11 | Plain data layer: read/write over a `Database` protocol, no Nest | M |
| G12 | Event schemas in crew's shape (a `TYPE` constant + a Zod 4 schema); crew keeps its own in-transaction events system | S |
| G13 | Jobs off Nest and Postgres: sqlite-core tables, single-statement claim, a plain runner, no `reflect-metadata` | L |
| G14 | **Bug, all consumers:** `BaseRepository.update` returns `rows[0]` typed as the entity when nothing matched (`runtime/base-classes/base-repository.ts:458-470`) | S |
| G15 | Typed duplicate-key error (optional) | S |

Plus these, queued and needed:
- **s7 A:** the `sqlite + drizzle` column and constraint renderers, with their own goldens.
- **s7 B:** the Postgres-typed parts made per-pair.
- **Zod 4 in generated code:** a major version.
- **Bug, all consumers:** `queries: … limit:` is ignored. `entity-locals.js:1096` computes `hasLimit`, and no entity
  template reads it.
- **crew's side:** crew's `SqlHandle` gains `values()`, because sqlite-proxy wants positional rows. crew does this
  (its board, t38).
- **Also on the codegen-targets board (s8, idea):** crew's settings standard as a codegen target. `<area>.settings.ts`
  via `defineSettings`, a roll-up and a JSON Schema of the tree (crew Settled 31 / d51).

**Rough total:** about 45 human-days. At this week's agent pace (TGT-0, an M, took about half a day with review),
2–3 weeks of agent time in sequence, or 1–1.5 weeks in two or three parallel lanes. Reviews, merges, and keeping
Postgres goldens byte-identical are the real limits. G1 and G2 change the YAML language itself and carry the most risk.

## Recommended order (from GAP.md)

1. Merge the stack above.
2. s7 A, with G9 (DDL) and the storage half of G3.
3. s7 B.
4. YAML growth: G1 keys → G4 rev → G6 queries → G5 guarded updates → G2 value objects.
5. Zod 4 in generated code, with the rest of G3.
6. G7 transaction-bound store + G8 module grouping + G10 generated suites, proven module by module on crew: teams,
   then notifications, then mail.
7. G11 data layer, G12 event schemas.
8. G13 jobs, when crew builds its background runner.

G14 and the `limit` bug can go any time; they affect every codegen app today.

## Open for Doug (defaults from GAP.md, all recommended)

1. YAML `name:` only for named updates and counts; crew takes codegen's derived finder names.
2. Build value objects (G2) in codegen, columns only; crew adapts where shapes share columns.
3. Missing vs null and Date vs ISO string are decided per target, so drizzle-pg goldens stay byte-identical.
4. Placement in crew: generated `domain/<noun>.record.ts` beside the hand-written `<noun>.ts`; generated store,
   tables and `.sql` in `infrastructure/sqlite/`; `module.ts` stays hand-written.
5. Generated conformance suites replace crew's once at least as strict, and run in crew's `just check`.
6. For crew, "services" means the generated data layer; policy use cases stay hand-written.
7. crew keeps its own in-transaction events (codegen's Drizzle subscribers run after commit and drop errors); codegen
   emits only event schemas.
8. The Nest-free SQLite jobs runtime lives in codegen, shared.
