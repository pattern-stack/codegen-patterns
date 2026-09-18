# REL-1 — `defineRelations()` manifest: the v2 relation graph, emitted from YAML

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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
  index.ts         emitRelationsManifest(ctx, outDir) → EmitRelationsResult; re-exports
```

plus one CLI-side wrapper, `src/cli/shared/relations-generator.ts`
(`regenerateRelationsManifest({ ctx, entitiesDir, junctionsDir, generatedDir, dryRun })`), so the three commands share
one call site instead of triplicating the loader wiring.

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

- **`optional`** (belongs_to only; the other three are fixed): an explicit relationship `nullable:` wins, else the FK
  column's `required:` (`true` ⇒ not optional), else `true`. This targets `processBelongsTo`'s precedence
  (`prompt-extension.js:468-482`) on the same YAML, with **one divergence forced by the schema** — see Found #1. It
  affects the include's result type only; getting it wrong is a type inaccuracy, not a wrong row.
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
  PR, and a fix belongs with whoever changes the init scaffold's layout contract. Filed as #612.
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

`test/scaffold/` generated exactly one entity (`contact-scaffold.yaml`, no relationships) from a single
`entity new <file>` invocation. As built:

- entity YAMLs moved under `test/scaffold/entities/` and gained `account` (self-referential `parent_account` plus two
  has_many) and `opportunity`; `contact` gained a **nullable** `account_id` + `belongs_to account`, so every existing
  contact fixture and test keeps working. `test/scaffold/junctions/opportunity_contact.yaml` is the m2m;
- `run-integration.ts` sets `paths.entities_dir: test/scaffold/entities`, runs `entity new --all --force`, stages the
  junction fixture into `<repo>/junctions` (the CLI reads junctions from that fixed path — there is no
  `paths.junctions`), runs `junction new --all --force`, and its teardown removes `junctions/` alongside `modules/`,
  `generated/` and `shared/`;
- `test/scaffold/schema.ts` re-exports each generated entity file **wholesale** (Found #5);
- `test/scaffold/shared/database/database.module.ts` and `tests/setup.ts` pass `relations` and parameterise their
  handle — hand-written harness fixtures, deliberately mirroring what the scaffold emits;
- `test/scaffold/tests/relations.test.ts` seeds parent-account → child-account → (contact, opportunity) → junction row
  and runs four traversals: the full graph from one root, the m2m hop in the reverse direction, `optional: true`
  yielding `null` (and an empty to-many yielding `[]`), and a depth-4 path
  (`has_many → through → one → self-ref one`). It runs under the existing `SCAFFOLD_INTEGRATION=1` skip-guard.

## Found during implementation

### Found #1 — `nullable` cannot be recovered after parsing, so `optional` keys off `required`

The design said the `optional` precedence "mirrors `processBelongsTo`". It cannot, exactly.
`FieldDefinitionSchema` defaults **both** `required` and `nullable` to `false`
(`entity-definition.schema.ts:172-173`), so a zod-parsed field that declared neither is indistinguishable from one
that declared `nullable: false`. The hygen template sees the raw YAML and treats "declared neither" as nullable; the
first draft of `belongsToOptional` read `field.nullable` and duly emitted `optional: false` for
`parent_account_id: { required: false }` — a column that is in fact nullable. The golden snapshot caught it on its
first generation.

What shipped keys off `required` alone. Building the unit-test fixtures through `EntityDefinitionSchema.parse`
rather than hand-shaping objects then showed why `field.nullable` should not be read at all: the schema rejects
`{ required: true, nullable: true }` outright, so `nullable: true` implies `required !== true` and the branch reading
it was unreachable. It was deleted, and a test now pins the schema fact that makes it so.

The result matches the template for every declaration except `{ required: false, nullable: false }` — there the column
is NOT NULL while the include's type stays `T | null`. Over-permissive, never a wrong row. The underlying default is a
pre-existing inconsistency between the generator's TS and hygen halves (`ParsedField` collapses the same way), filed
as #613 rather than changed under this PR.

### Found #2 — the DRZ-1 guard's file-wide rule had to be narrowed, not just widened

The guard banned **any** import list containing `relations`. The v2 wiring legitimately carries
`import { relations } from '../../generated/relations'`, so re-pointing meant naming the module the v1 symbol came
from: the rule is now `import { … relations … } from 'drizzle-orm…'`. Nothing else was loosened, and the scan widened
from `templates/` alone to the relations emitter, the init scaffold, the CLI wrapper and the golden snapshot — the
surface that actually emits relation code now. The guard immediately earned it by failing on a doc comment in
`relations-generator.ts` that spelled the banned call literally; the comment was reworded, the pattern was not.

### Found #3 — a junction's `expose_on_parent` had to be exercised, not just asserted about

The spec claimed `expose_on_parent` governs the parent service's fan-out, not the graph. Running the integration
harness proved the claim load-bearing: with fan-out on, the generated `ContactService` injects
`OpportunityContactService` and the hand-written `ScaffoldContactsModule` could not resolve it. The junction fixture
turns fan-out **off**, and the manifest still carries both `.through()` edges — which the round-trip test then walks.
A unit test pins the same property directly.

### Found #4 — `belongs_to` on `contact` pulled a sibling repository into the harness module

Adding `contact belongs_to account` made the generated `ContactService` inject `AccountRepository` for its CGP-358b
`account(contactId)` composition method. `ScaffoldContactsModule` now provides it, with a comment pointing at REL-3 —
that provider goes away with the composition it exists for. **Service composition itself was not touched** (out of
scope, ADR-044 §2).

### Found #5 — the scaffold schema barrel must re-export entity files wholesale

Naming `opportunityContacts` alone made `drizzle-kit push` abort with `type "opportunity_contact_role" does not
exist`: an entity file also declares the pgEnums its columns reference, and kit only creates enum types it can see.
The barrel now `export *`s each generated entity file, for the same reason its subsystem schemas already did.

### Found #6 — no new `paths.*` key was needed

The design allowed for one. `paths.generated` already names the directory codegen owns for cross-entity barrels
(`modules.ts`, `schema.ts`), and the manifest is a third one. Nothing was added to `PathsConfigSchema`.

## Acceptance — all met

Output from the run made after the last code edit.

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run build` | exit 0 |
| `bun run test` / `just test-unit` | **3205 pass**, 3 skip, 0 fail |
| `just test-all` | exit 0 — typecheck + unit + baseline + `test-smoke` + `-subsystems` (vendored + package) + `-relationship` + `-junction` + `-junction-cross-domain` + `test-junction` + `test-integration-emit` + `test-smoke-integration`, every one PASS |
| `just test-integration` (Docker) | **68 pass**, 2 skip, 0 fail — including the 4 new round-trip tests |
| `just test-smoke` (the `runtime/**` gate, I9) | PASS, inside `test-all` |

- The round-trip gate was **mutation-checked**: deleting the two `.through()` calls from the generated manifest turns
  3 of its 4 tests red. It asserts rows and ids, never `toBeDefined`.
- No new `any`, no `as unknown as`, no filtered error class, no directory carve-out. `runtime/types/drizzle.ts` goes
  from one `any` (plus its eslint-disable) to zero.
- `just test-smoke-junction-clean` was not run, not repaired and not filtered — it stays the documented known-red gate
  (#602).

## Risks — outcome

| Risk | Outcome |
|---|---|
| `DrizzleClient` generic breaks a consumer-tsconfig compile that `bun run typecheck` does not see | **Did not happen.** All four smokes compile the generated project against the changed runtime; the fallback (a separate alias) was not needed. |
| Junction parent-table naming diverges from the registry | **Open, pre-existing, filed** (#611). No fixture in the repo declares an irregular plural on a junction endpoint, so nothing is red today; the manifest uses the registry either way (I1). |
| A consumer's relation key collides with a column | **Open by design.** Drizzle's own `processRelations` error names both, and the junction smoke's AppModule boot gate executes `defineRelations()`, so it surfaces there. §3 explains why the emitter does not re-derive columns to pre-empt it. |
| rc.4 → GA changes the builder | **Open.** The R1–R9 table is the REL-1 row of DRZ-2's A1–A10 discipline: re-verify on every RC move. |

## Follow-ups filed

1. **#611** — `templates/junction/new/prompt.js:253-265` derives parent table names with `pluralize(entity)` rather than the
   entity's declared `plural` — breaks any junction whose endpoint declares an irregular plural. (Pre-existing;
   surfaced while verifying REL-1's table identifiers, which resolve through the registry instead.)
2. **#612** — emitted `app.module.ts` / `database.module.ts` hard-code `src/generated` and ignore `paths.generated`.
   (Pre-existing; REL-1 adds a third import that inherits it.)
3. **#613** — `FieldDefinitionSchema` defaults `nullable` to `false`, so the TS half of the generator cannot tell "undeclared"
   from "declared NOT NULL" while the hygen half can — see Found #1. Affects `ParsedField` consumers too, not just
   this emitter.

## Definition of done (charter §9) — done

1. Gates green, output from the run after the last edit — §Acceptance.
2. This spec corrected to post-implementation truth; `Status: Implemented`.
3. ADR-044 carries a dated revision note recording the `alias` finding (R2) and the `roles:` seam; its `Related:` line
   and REL-2 follow-up were corrected with it.
4. `PLAN.md` §5A.3 rewritten as what was built plus what changes REL-0 / REL-2 / REL-3 / CAP-2.
5. `CHANGELOG.md` 0.31.0 entry (the release note now says the v1 const is *replaced*, not merely removed).
6. Epic #580 body row + epic log entry.
