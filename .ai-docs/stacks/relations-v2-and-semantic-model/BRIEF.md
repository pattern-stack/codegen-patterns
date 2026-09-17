# Brief — Drizzle relations v2 + semantic model emission

**Stack:** `relations-v2-and-semantic-model`
**Repo state at writing:** `main` @ `efe6afb`, **v0.29.0** (2026-09-13), clean tree, deps installed.
**Every fact below marked *verified* was checked against `origin/main`, not a stale checkout.**

---

## 0. Standing rules for this stack

- **This repository is PUBLIC and `.ai-docs/` is committed.** Never paste consumer, customer, product-strategy,
  infrastructure, or security-defect detail into any file here — including commit messages, issue bodies and PR
  descriptions. External context may be supplied to you at launch by path; read it, reason from it, and keep it out of
  this repo. When you need to refer to a consumer, say "a host application."
- `.claude/sdlc.yml` sets `task_management: github` and `quality_profile: strict` — SDLC commands here will open issues
  on the public repo. Confirm with the operator before creating any.
- ⚠ `.ai-docs/handoff.md` is dated **2026-06-07** and describes a finished jobs worker-scaffold train. It is stale and
  its obstacles are expired. Do not resume from it.

## 1. Goal

Make the entity YAML the single declaration that emits **both** the Drizzle relation graph and a semantic/aggregate
model, and move the generator onto Drizzle 1.0.

Today the YAML already models relationships and carries an `analytics:` block, but the generator emits neither a
relation graph nor a semantic model. Closing that turns one manifest into: the ORM graph, the semantic model, and the
app layers already generated.

## 2. What already exists — do not rebuild (verified on `origin/main`)

- **Relationships in YAML:** `RelationshipSchema` — `belongs_to` / `has_many` / `has_one`, with `inverse` naming the
  reciprocal relation on the target. A `relationship` CLI command and `relationship-types.schema.ts` exist.
- **Pattern library:** `Base | Integrated | Activity | Knowledge | Metadata | Junction`, app-definable, with `extends`
  chains (`src/patterns/pattern-definition.ts`) and `src/patterns/validate-composition.ts`.
- **Analytics vocabulary, partially:** the `analytics:` block carries `agg` (`AnalyticsAggregationSchema`) and
  `measure_packs`. **There is no `additivity`** and no time axis — that is the real gap, not the block.
- **OpenAPI is shipped** (v0.4.0, April 2026 — OPENAPI-1..4 plus `project upgrade-openapi`): generated NestJS apps
  register Zod DTOs as component schemas, decorate controllers, serve Swagger UI at `/docs` and a typed `/docs-json`.
  Live at `src/cli/commands/project-upgrade-openapi.ts`, `src/cli/shared/init-scaffold.ts`,
  `src/__tests__/runtime/shared/openapi-registry.spec.ts`. **A downstream client generator has a working spec to target
  on day one — do not build an OpenAPI path.**
- **Auth guard:** the ADR-043 series is merged (#562–#565) — closed-by-default data plane, auto-wire + boot-fail,
  removal of the self-asserted `x-user-id`/`x-tenant-id` header path, per-entity `api:false`.
- A repository base-class runtime, and generated repositories / services / controllers / DTOs / use cases / module wiring.

**Verified absences:** zero `relations(` emission anywhere in `src`. `drizzle-orm` is still pinned `^0.45.2`.

## 3. The access-pattern contract (decided 2026-09-17)

`docs/relationship-pattern-audit.md` (architecture from cgp-62 r4, unchanged on `origin/main`) states:

> service-layer composition is the **core contract** for cross-entity access; Drizzle's `relations()` const is an
> **opt-in extension** for hand-written ad-hoc queries.

with §4 titled *"Drizzle `relations()` as table metadata (opt-in extension)."*

So the absence in §2 is a **design position**, not an oversight. Emitting a relations-v2 graph that repositories
traverse would **promote or reverse that contract**. Three options:

1. **Promote relations to the core contract** — generated repositories traverse the v2 graph; service-layer composition
   becomes the fallback.
2. **Keep both; relations as first-class opt-in** — emit the v2 manifest as table metadata (its current slot, upgraded),
   repositories keep FK + repo composition.
3. **Split by surface** — relations-driven traversal for reads, service composition for writes.

**DECIDED 2026-09-17 (operator): option 1 — promote relations to the core contract.** Recorded in
`docs/adrs/ADR-044-cross-entity-access-contract.md`. The shape of the decision:

- Generated repositories traverse the v2 graph (RQBv2 `with:`); generated **reads** can be arbitrarily deep row-shaped
  traversals. The CGP-358b two-query service composition is **replaced**, not kept beside it (no second composition
  type). `clean-lite-ps` stays the pipeline in scope.
- Services are fully generated atomic operations ("one surface, many homes"); consumers hand-write **use-cases and
  queries on top**. Writes that span entities / transactions / workflows are use-cases. Aggregations never ride
  relations — they go through the sibling semantic-query package, injected into a use-case/query.
- Electric parity is restated, not dropped: both sides **project from the same YAML graph** — backend via
  `defineRelations()`, frontend via generated relation accessors over the existing TanStack DB collections.
- Tenant scope is **ALS-fed at the repository** (ADR-042, accepted the same day) — a precondition for traversal, since
  every hop must be scoped.

## 4. Units

1. **Generator upgrade: Drizzle 0.45.2 → 1.0.** Note 1.0 is **RC, not GA** (`latest` 0.45.2, `rc` 1.0.0-rc.4,
   `beta` 1.0.0-beta.22). 1.0 removes `relations()`/RQBv1 and changes drizzle-kit's migration format (folder-matched,
   no `journal.json`). Scope here is the **generator and what it emits**; a consumer's migration-history continuity is
   a separate question the operator is handling elsewhere — do not solve it here.
2. **v2 relations emitter + graph traversal** — `defineRelations()` derived from the existing `RelationshipSchema`:
   `alias` from `inverse` (and unit 4's `roles:`), `.through()` from the `Junction` pattern; typed `with` includes on
   generated repositories; service relationship methods delegate to them. **Unblocked by ADR-044; depends on unit 1 and
   on ADR-042 being implemented (TEN-1).**
3. **Semantic/aggregate model emitter** — extend `analytics:` with `additivity` (additive | semi | non) and a `time`
   axis, then emit the host-supplied model shape the sibling semantic-query package consumes: entities, keys,
   cardinality graph, field tags. Confirm the target shape against that package before designing the emission.
4. **Pattern-library extension** — an actor/activity split distinguishing communication-style entities from
   record-style ones, expressed as pattern declarations composing over the existing library.
5. **Frontend graph accessors** — extend the ADR-038 frontend emitter (which already emits TanStack DB collections and
   `belongs_to` resolvers) with `has_many` / junction traversal and a typed include API, projected from the same graph
   as unit 2.

**TS shape rule for units 3–4:** express entity families as **interfaces + generic constraints**, sharing behavior via
mixins/composition — not a generated base-class chain. TS has single inheritance and the families are not mutually
exclusive; the library already supports `extends` chains *and* composition validation. ~~Keep tenant scope an explicit
parameter, never ambient in a generated base.~~ **Revised 2026-09-17:** tenant scope is **ALS-fed at the repository
choke point** (ADR-042), with `scopeEnforcement: 'strict'` for tenant-scoped entities so a missing context throws
rather than reading unscoped. Rationale: the hand-written layer is use-cases; an explicit parameter is forgettable
exactly there, and cannot be threaded through nested `with:` traversal.

## 5. Gates

- `bun run typecheck`, `bun run build`, `bun run test` green at every landing.
- `bun run test:integration` for anything touching emission.
- A generated project boots and serves `/docs-json` with non-empty component schemas.
- Emitted relation graph round-trips: YAML → `defineRelations()` → a traversal returning expected rows.
- Report gate output from the run made **after** the last edit, immediately before the commit.

## 6. Out of scope

No changes to any consumer application. No production RC pin. No merging of the stale open PRs — **#550**
(bullmq/jobs, open since Jun 15, predates ~9 minors and is plausibly part-superseded by #570 `feat(jobs): getRun /
countRuns / listSteps`), **#556** (frontend-exclude knob), **#271** (post-publish smoke, April). If any becomes
relevant, rebase-and-reassess rather than merging.

## 7. Repo context worth knowing

Commit cadence on `main`: 37 (Feb) · 0 (Mar) · **279 (Apr)** · 77 (May) · 74 (Jun) · 0 (Jul) · 4 (Aug) · 4 (Sep).
The project peaked in April and has been near-dormant since July. Treat `origin/main` docs — cgp-62's contract
position, the OpenAPI plan — as **current doctrine**: nothing in flight is quietly superseding them.

## 8. Open questions

- ~~§3's contract decision~~ — decided, ADR-044.
- Where the frontend include API lives: in `@pattern-stack/frontend-patterns` with thin generated wiring (recommended,
  the `createEntityHooks` precedent) or fully generated.
- Whether the metric/measure catalog is authored in the entity YAML or in the consuming model adapter.
- Whether `additivity` belongs per-measure, per-measure-pack, or both.
