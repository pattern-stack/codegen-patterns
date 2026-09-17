# REL-1 — `defineRelations()` manifest: the v2 relation graph, emitted from YAML

**Status:** Planned
**Date:** 2026-09-17
**Issue:** #586 · **Epic:** #580 · **Project:** #578
**Depends on:** DRZ-2 (#584) · **Blocks:** REL-2 (typed includes), REL-3 (services + navigator), FE-REL
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5A.3, §4.5 · ADR-044

## Why

DRZ-1 deleted the v1 `relations()` const and DRZ-2 left a **named seam**: the emitted `database.module.ts` is
`drizzle({ client: pool })` with `export type DrizzleDB = NodePgDatabase`, i.e. `EmptyRelations`. Nothing in a
generated project can traverse the graph the entity YAML already declares.

REL-1 fills that seam. It emits one `defineRelations()` manifest per schema, from the YAML `relationships:` blocks and
the `Junction` entities, and wires it into `drizzle({ client, relations })` so `db.query.X.findMany({ with: … })`
resolves a nested include tree in one statement, typed end to end. REL-2 then puts a typed `with` on repositories;
REL-3 puts the navigator on services. REL-1 ships the graph and nothing else.

## Charter invariants this PR touches

- **I1 declare once.** Every relation in the manifest comes from a YAML declaration — an entity's `relationships:`
  entry or a junction's `between:`. Nothing is recovered by introspecting Drizzle, the emitted schema files, or the
  database. Target naming resolves through the cross-entity registry (the target entity's own `plural`), never by
  re-pluralizing a string at emit time (the ADR-038 rule, restated in CLAUDE.md).
- **I2 generated means regenerated.** `<generated>/relations.ts` is a whole-set, complete-file write with an
  `@generated` banner, name-sorted, byte-identical on re-run. No inject, no anchors, no author seam inside it.
- **I7 no backwards compat.** The v1 const is not resurrected in any form and no compatibility alias is emitted.
  `DrizzleClient` is *changed*, not paralleled. Golden snapshots and smoke assertions are rewritten, not extended.
- **I9 honest gates.** New gates land in `just test-all` (golden + unit + the three relationship/junction smokes) or in
  the `test-integration` CI job (the round-trip). No new `any`; this PR **removes** one (`runtime/types/drizzle.ts`).
- **I11 scope discipline.** The manifest is a cross-entity file, so it is a whole-set TS emitter (ADR-038 precedent),
  not a hygen inject. Gates are `clean-lite-ps`; the `clean` pipeline stays known-red (#602) and is neither repaired
  nor filtered.

## Verified against the installed rc.4 (probed from inside the repo, charter §8)

Every claim below was measured against `node_modules/drizzle-orm@1.0.0-rc.4` in this worktree — `tsc` for the type
claims, a live `postgres:16` (the scaffold's compose file) for the runtime claim. Probes were deleted after measuring.

| # | Claim | Evidence |
|---|---|---|
| R1 | `defineRelations(schema, (r) => ({…}))` accepts a **namespace import** of the generated schema barrel. Non-table exports (types, `pgEnum`s, and even a re-exported `relations` const) are filtered out by `ExtractTablesFromSchema`. | `import * as schema from './schema'` over a barrel that `export *`s tables, enums, types **and** a relations const type-checks and builds the right table set. |
| R2 | **`alias` is never required when both sides declare `from`/`to`.** `alias` is read in exactly one place — `processRelations`' reverse-inference branch (`relations.js:41-48`), which only runs when a relation omits `from`/`to`. It is stored on `Relation` and used nowhere else. `isReversed` (set in that same branch) only re-targets a relation's `where`, which REL-1 does not emit. | `grep -n alias node_modules/drizzle-orm/relations.js` → lines 21/24/41-48 (processRelations) + 93/115/140 (field decls). No other reader. |
| R3 | Explicit `from`/`to` on **both** sides handles self-references and multiple relations between the same pair without ambiguity. | The CRM shape (self-ref `parentAccount` + `contacts`/`opportunities` has_many + their `belongs_to` inverses) type-checks and returns correct rows. |
| R4 | Many-to-many is `from: r.A.id.through(r.J.aId), to: r.B.id.through(r.J.bId)` on each parent. | Type-checks; returns the joined rows at depth 3 against real Postgres. |
| R5 | The include tree is **typed**, not `any`. | `Awaited<ReturnType<…findMany({with:{opportunities:{with:{account:true,contacts:true}}}})>>` resolves to the concrete nested object type; an extra property is a TS2353. |
| R6 | An **empty** manifest is legal: `defineRelations(schema, () => ({}))` over an `export {}` barrel, and `NodePgDatabase<typeof relations>` over it. | Type-checks. This is what `project init` emits before any entity exists. |
| R7 | `NodePgDatabase<typeof relations>` is assignable to `NodePgDatabase<AnyRelations>` (widening works; narrowing does not, as expected). | `tsc`: `Concrete → Permissive` OK, `Permissive → Concrete` TS2322. |
| R8 | Making `DrizzleClient` generic over `AnyRelations` (removing its `any`) leaves `bun run typecheck` at **0 errors**. | Trial edit + `bun run typecheck` → exit 0. Consumer-tsconfig validation is still owed to `just test-smoke` (I9). |
| R9 | Runtime round-trip: self-ref one, has_many, m2m `.through()` in both directions, nested three deep, all return the expected rows. | Live probe against the scaffold's `postgres:16`; output inspected row by row. |

### What R2 means for the ADR

ADR-044 § "Naming and junctions" says *"`alias` comes from `inverse`"*. That was written before the v2 builder was
measured. With explicit `from`/`to` on every relation — which a generator can always produce, because the YAML always
names the FK column — `alias` is **dead weight**: it exists for hand-authored manifests that lean on reverse
inference. REL-1 therefore emits no `alias`, and `inverse:` keeps its existing job (naming the other side's relation)
without feeding a Drizzle field. This PR adds a **dated revision note** to ADR-044 recording that, and records the
`roles:` seam in the same note (see §5).

## Scope

### 1. New emitter — `src/emitters/relations/`

Modelled on `src/emitters/frontend/` (ADR-038): a pure whole-set builder plus a context loader, no fs in the builders.

```
src/emitters/relations/
  types.ts         RelationsEmitContext, RelationEdge, sortEntities-equivalent ordering helpers
  build-graph.ts   YAML → RelationEdge[] (the only place relationship semantics live)
  emit-manifest.ts RelationEdge[] → the relations.ts source string
  load-context.ts  loadRelationsEmitContext(cwd, config, { entitiesDir, junctionsDir })
  index.ts         emitRelationsManifest(ctx, outDir) → string[]; re-exports
```

**Context** (what the builders consume, constructible in tests without fs):

```ts
interface RelationsEmitContext {
  /** Cross-entity naming registry, name-sorted. The only naming source. */
  entities: EntityRegistryEntry[];
  /** Raw, zod-parsed entity definitions keyed by entity name. */
  definitions: Map<string, EntityDefinition>;
  /** Junction definitions, sorted by derived junction name. */
  junctions: JunctionDefinition[];
}
```

The **raw `EntityDefinition`** is used rather than `ParsedEntity` on purpose: `ParsedRelationship` drops
`nullable`, and `ParsedField` collapses "undeclared" into `false`, so the optionality precedence below cannot be
reproduced from the parsed model. The registry still owns naming; the definition owns structure.

**Ordering** is total and derived, never filesystem-dependent: entities by `name`, relations within an entity by
relation key, junction-derived edges after declared ones. Re-running produces a byte-identical file.

### 2. What is emitted

`<generated>/relations.ts`:

```ts
// @generated by @pattern-stack/codegen — do not edit.
// Run `codegen entity new --all` to regenerate.
import { defineRelations } from 'drizzle-orm';

import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  accounts: {
    contacts: r.many.contacts({ from: r.accounts.id, to: r.contacts.accountId }),
    opportunities: r.many.opportunities({ from: r.accounts.id, to: r.opportunities.accountId }),
    parentAccount: r.one.accounts({ from: r.accounts.parentAccountId, to: r.accounts.id, optional: true }),
  },
  // …
}));
```

Per-relationship rules — the whole of the semantics:

| YAML | Emitted |
|---|---|
| `belongs_to`, `target: T`, `foreign_key: f` | `r.one.<T.plural>({ from: r.<self.plural>.<camel(f)>, to: r.<T.plural>.id, optional: <see below> })` |
| `has_many`, `target: T`, `foreign_key: f` | `r.many.<T.plural>({ from: r.<self.plural>.id, to: r.<T.plural>.<camel(f)> })` — `f` is the FK **on the target**, exactly as `processHasMany` reads it today |
| `has_one`, `target: T`, `foreign_key: f` | `r.one.<T.plural>({ from: r.<self.plural>.id, to: r.<T.plural>.<camel(f)>, optional: true })` — inverse side, so the row may be absent |
| junction `between: [A, B]` | on `A`: `r.many.<B.plural>({ from: r.<A.plural>.id.through(r.<J>.<camel(A)>Id), to: r.<B.plural>.id.through(r.<J>.<camel(B)>Id) })`, and the mirror on `B`; on the junction table itself, `r.one.<A.plural>` / `r.one.<B.plural>` from its two FK columns |

- **`optional`** (belongs_to only; the other three are fixed): explicit relationship `nullable:` wins → else the FK
  column's own `fields:` declaration (`required: true` ⇒ `optional: false`; `nullable:` as declared) → else `true`.
  This is `processBelongsTo`'s precedence (`prompt-extension.js:468-482`), applied to the same YAML. It affects the
  include's result type only; getting it wrong is a type inaccuracy, not a wrong row.
- **Relation keys are the YAML relationship names**, camelCased (`parent_account` → `parentAccount`). This replaces
  the v1 derivation, which used the *target entity name* for non-self relations and ignored the author's key
  (`prompt-extension.js:492-505`). I1: the author named the edge; the manifest uses that name. I7: the old derivation
  is not kept as a fallback.
- **Junction-derived keys** are `camelCase(target.plural)` on each parent (`contacts` / `opportunities`), plus
  `camelCase(junction.plural)` for the row-level `many` to the junction table itself, and the junction's own two
  `one()` keys are `camelCase(endpoint entity name)`.
- **Table identifiers** are the schema barrel's export names: `entity.plural` verbatim for entities (the
  `clean-lite-ps` and `clean` entity templates both emit `export const <plural> = pgTable(…)`), and
  `camelCase(pluralize(<a>_<b>))` for a junction (`templates/junction/new/prompt.js:236-240`). Junction FK columns are
  `camelCase(<endpoint>_id)` (`:258-261`).
- **No `alias`, no `where`, no `optional` on `many`.** Per-hop predicates are REL-2's problem (§Out of scope).

### 3. Collision handling — loud, not silent

Two relation keys on the same table is a broken manifest: Drizzle would take the last one silently (object literal),
and the graph would be wrong. The emitter detects duplicates across the three sources (declared `relationships:`,
junction-derived m2m, junction-derived row edges) and **throws** with both contributors named. The `entity new` /
`junction new` / `relationship new` post-step catches it, prints an **error** (not the sibling post-steps' warning),
skips the write, and makes the command exit non-zero.

This is a deliberate departure from the warn-but-don't-fail convention of the other post-steps, and the reason is
concrete: after this PR the manifest is load-bearing for compilation — `database.module.ts` imports it — so a project
that continues past a collision is a project that does not build. A warning would be the quiet kind of gate this
charter forbids (I9).

A relation key that collides with a *column* key is Drizzle's own check (`processRelations` throws
`relation name collides with column …`); it surfaces at boot and in the smoke's boot verifier. The emitter does not
duplicate it — doing so would mean re-deriving the full emitted column set (behaviors included) in a second place,
which is exactly the I1 violation this project exists to remove.

### 4. Wiring

- **`src/cli/shared/init-scaffold.ts`**
  - `databaseModuleContent()` imports the manifest and passes it:
    `drizzle({ client: pool, relations })`, and `export type DrizzleDB = NodePgDatabase<typeof relations>`.
    The import is `../../generated/relations`, the same hard-coded `src/generated` the emitted `app.module.ts` already
    assumes for `./generated/modules`. A `paths.generated` override moves the emitter's output but not these two
    imports — a pre-existing inconsistency, now documented rather than widened (see §Out of scope).
  - A third empty barrel joins `modules.ts` / `schema.ts` at init: `src/generated/relations.ts`, produced by calling
    the emitter's own builder with an empty context — not a second hand-written string (I1/I2). This is what makes
    the `database.module.ts` import resolve on a project with zero entities (R6).
- **`src/cli/commands/{entity,junction,relationship}.ts`** — the manifest regenerates wherever `regenerateBarrels`
  runs, in both the single-target and `--all` paths, and appears in `--dry-run` plans. It is whole-set: generating one
  entity re-reads every YAML, so deleting a YAML removes its relations (ADR-017's contract for the barrels).
- **`runtime/types/drizzle.ts`** — `DrizzleClient` becomes generic with a permissive default:

  ```ts
  export type DrizzleClient<TRelations extends AnyRelations = AnyRelations> = NodePgDatabase<TRelations>;
  ```

  **This is the answer to "how does the typed db reach generated repositories without the runtime package importing
  generated code".** It does not: the published runtime never sees a consumer's manifest. Two handles, one object:

  - the **runtime** package (BaseRepository, the events/jobs/cache/storage backends) holds the relations-agnostic
    `DrizzleClient`. A concrete `NodePgDatabase<typeof relations>` widens to it (R7), so the same instance injected
    under `DRIZZLE` satisfies both;
  - **generated** code reaches the typed handle through **generated** code: `DrizzleDB` in the emitted
    `database.module.ts`. REL-2's generated repositories declare their `db` as `DrizzleDB` (or take `TRelations` as a
    parameter and let the generated subclass bind it). Either way the coupling is generated→generated.

  The change also removes the file's `any` (R8) — the one `eslint-disable no-explicit-any` in it.
  `bun run typecheck` alone does **not** validate this (charter I9): `just test-smoke` is the gate.

### 5. Documented seams for later units

Written into the emitter as comments and into this spec, so the next agent does not have to re-derive them:

- **`roles:` (CAP-2, ADR-041).** When an entity declares roles, each role is another edge from the same source table to
  the same actor table. Because REL-1 emits explicit `from`/`to`, adding them needs **no `alias`** (R2) — a role
  contributes one more entry to `build-graph.ts`'s edge list with `key = camelCase(role name)` and
  `to = r.<actor.plural>.id` through the role's own FK or junction. The seam is a single `// CAP-2:` marker in
  `build-graph.ts` where edge sources are concatenated.
- **Per-hop scope (REL-2).** v2 exposes a predefined `where` on both `one()` and `many()` configs
  (`OneConfig.where` / `ManyConfig.where`, `relations.d.ts:322-334`). REL-2's spike (charter Q2) decides between baking
  the tenant/soft-delete/userTracking predicates in there and rewriting the include tree in the repository. REL-1
  emits no `where`, so either path is open. Note for that spike: a `where` on a relation that omits `from`/`to` flips
  `isReversed` (`relations.js:60`), which re-targets the filter — irrelevant here only because REL-1 always emits
  `from`/`to`.
- **`relationship:` YAML entities** (the older first-class relationship tables, `from:`/`to:` + a `types:` enum) get
  **no** edges in REL-1. Their typed-edge semantics need a per-type `where`, which is REL-2's surface; emitting an
  untyped m2m over them now would conflate distinct relationship types into one traversal. Their tables simply carry
  `{}` in the manifest, which `buildRelations` handles natively.

## Out of scope

- Repository `with` includes, per-hop scoping, the HTTP include allowlist — **REL-2**.
- Services, the navigator, deleting CGP-358b composition — **REL-3**. Service composition is untouched here.
- Frontend relation accessors — **FE-REL**.
- `alias`-from-`roles:` — CAP-2 has not landed, and R2 shows no `alias` is needed either way.
- Repairing or gating the `clean` pipeline (#602). The manifest is emitted for both architectures because it derives
  from YAML, not from a pipeline; only `clean-lite-ps` is gated (I11).
- Making `database.module.ts` / `app.module.ts` honor a `paths.generated` override. Pre-existing, unchanged by this
  PR, and a fix belongs with whoever changes the init scaffold's layout contract. Filed as a follow-up (§Follow-ups).
- A `project update` path that re-wires an already-initialized consumer's `database.module.ts`. I7: no migration shims.

## Gates

| Gate | What it proves | Where it runs |
|---|---|---|
| `src/__tests__/emitters/relations/golden-manifest.test.ts` | Byte-identical whole-set output for a fixture set covering self-ref, cross-entity belongs_to/has_many, has_one, and a junction. Regenerate with `UPDATE_RELATIONS_GOLDEN=1`. Mirrors the frontend golden test. | `just test-unit` → `just test-all` |
| `src/__tests__/emitters/relations/build-graph.test.ts` | Unit: optionality precedence, key derivation, junction edge derivation, duplicate-key throw, registry-resolved plurals (target's own `plural`, not `pluralize(name)`). | `just test-unit` |
| `src/__tests__/templates/no-v1-relations-emission.test.ts` (re-pointed) | The v1 API stays deleted **and** the v2 manifest is allowed. Scope widens from `templates/` alone to `templates/` + `src/emitters/relations/` + the golden snapshot, so the tripwire now covers the surface that actually emits relation code. `defineRelations(` and `import { defineRelations }` pass by construction — the patterns are `\brelations\s*\(` and `\brelations\b` inside an import list, and neither matches after `define`. | `just test-unit` |
| `just test-smoke-relationship` | The CRM fixture set emits a manifest and the **whole generated project type-checks**, `src/generated/relations.ts` and `database.module.ts` included. Adds assertions: manifest present, self-ref `parentAccount` one(), both has_many, `DrizzleDB` parameterised, `drizzle({ client: pool, relations })`. | `just test-all` |
| `just test-smoke-junction`, `just test-smoke-junction-cross-domain` | `.through()` m2m compiles in a generated project, intra- and cross-domain. | `just test-all` |
| `just test-smoke`, `just test-smoke-subsystems`, `just test-smoke-integration` | The empty/near-empty manifest and the `DrizzleClient` generic hold under the consumer tsconfig. | `just test-all` |
| `just test-integration` — **the charter §9 round-trip** | YAML → manifest → `db.query.X.findMany({ with: … })` returns the expected rows against real Postgres, at depth ≥ 2, including one `.through()` hop and one self-reference. | its own CI job |
| `just test-baseline` | Unchanged. The baseline drives `bunx hygen` directly, so no CLI post-step runs in it; the manifest is invisible there by construction. | `just test-all` |

### The round-trip gate, concretely

`test/scaffold/` today generates exactly one entity (`contact-scaffold.yaml`, no relationships) from a single
`entity new <file>` invocation. REL-1 extends it:

- entity YAMLs move under `test/scaffold/entities/` and gain `account`, `opportunity`, and a `belongs_to account` on
  `contact` (nullable, so every existing contact fixture and test keeps working); `test/scaffold/junctions/` gains
  `opportunity_contact`;
- `run-integration.ts` runs `entity new --all` + `junction new --all` against those dirs instead of the single-file
  invocation, and its teardown already removes `modules/` + `generated/`;
- `test/scaffold/shared/database/database.module.ts` and `tests/setup.ts` pass `relations` (they are hand-written
  harness fixtures, deliberately mirroring what the scaffold emits);
- `test/scaffold/tests/relations.test.ts` seeds an account → contact/opportunity → junction row graph and asserts the
  nested result shape, including that a self-referencing parent account resolves and that the m2m hop returns the
  joined rows. It runs under the existing `SCAFFOLD_INTEGRATION=1` skip-guard.

## Acceptance

- `bun run typecheck && bun run build && bun run test` green.
- `just test-all` green (includes every smoke above, the golden suite, and the re-pointed DRZ-1 guard).
- `just test-integration` green, with the new round-trip test asserting rows — not `toBeDefined`.
- `just test-smoke` run after the last `runtime/**` edit (I9: repo typecheck does not validate `runtime/base-classes`
  or `runtime/types` under the consumer tsconfig).
- No new `any`, no `as unknown as`, no filtered error class, no directory carve-out. Net `any` count in
  `runtime/types/drizzle.ts` goes 1 → 0.
- `just test-smoke-junction-clean` stays red at its recorded number (#602) — not repaired, not filtered.

## Risks

| Risk | Signal | Response |
|---|---|---|
| `DrizzleClient` generic breaks a consumer-tsconfig compile that `bun run typecheck` does not see | a smoke fails on `runtime/**` | R8 measured the repo side only; if the consumer side objects, keep the `any` and put the generic on a new alias rather than widening. Do not filter the error. |
| Junction parent-table naming diverges from the registry | a junction fixture whose parent entity declares an irregular `plural` fails to compile | Pre-existing: `templates/junction/new/prompt.js:253` derives parent tables with `pluralize(entity)` instead of the registry. The manifest uses the registry (I1). If they disagree, the *junction template* is wrong — filed as a follow-up, not worked around here. |
| A consumer's relation key collides with a column | `defineRelations` throws at boot | Drizzle's own error names both; the smoke boot verifier catches it. §3 explains why the emitter does not re-derive columns to pre-empt it. |
| rc.4 → GA changes the builder | a gate fails after a pin move | The R1–R9 table is the REL-1 row of DRZ-2's A1–A10 discipline: re-verify it on every RC move. |

## Follow-ups to file

1. `templates/junction/new/prompt.js` derives parent table names with `pluralize(entity)` rather than the entity's
   declared `plural` — breaks any junction whose endpoint declares an irregular plural. (Pre-existing; surfaced while
   verifying REL-1's table identifiers.)
2. Emitted `app.module.ts` / `database.module.ts` hard-code `src/generated` and ignore `paths.generated`.
   (Pre-existing; REL-1 adds a third import that inherits it.)

## Definition of done (charter §9)

1. Gates green, output from the run after the last edit.
2. This spec corrected to post-implementation truth; `Status: Implemented`.
3. ADR-044 carries a dated revision note recording the `alias` finding (R2) and the `roles:` seam.
4. Epic #580 body row updated (state / spec / PR / "what downstream must know") and an epic log entry posted.
5. PLAN §5A.3 corrected if anything here changes what REL-2 / REL-3 must do — in this PR, not later.
