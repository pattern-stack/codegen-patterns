# ADR-044 — Cross-Entity Access Contract: the relation graph is the core contract

**Status:** Accepted
**Date:** 2026-09-17
**Owner:** Doug
**Related:** ADR-001 (DDD + hexagonal layering), ADR-038 (frontend emitter), ADR-041 (capability composition — `roles:` become named relations; see the 2026-09-17 revision note), ADR-042 (ALS-fed repository tenant scoping — precondition), ADR-043 (closed-by-default data plane — constrains traversal over HTTP), `docs/relationship-pattern-audit.md` §1/§4 (the cgp-62 r4 position this supersedes), `.ai-docs/stacks/relations-v2-and-semantic-model/PLAN.md` §2 (the tradeoff table this chose from)

## Context

The cgp-62 r4 contract made **service-layer composition** the core path for cross-entity access (two repository calls,
no SQL join) and kept Drizzle's `relations()` const as an opt-in extension for hand-written queries. Its rationale was
ElectricSQL parity: the client composes over 1:1 replicated tables, so the backend composed the same way.

Two things changed:

1. **Drizzle 1.0 removes the v1 `relations()` API.** The opt-in slot has to be refilled with `defineRelations()` (v2)
   regardless, so "what consumes the graph" is being decided now either way.
2. **The goal of the stack is one declaration.** The entity YAML already declares the relationship graph. With
   composition as the core contract, the graph existed but the app layers did not project from it — "how do I get from
   A to B" had two answers.

Three options were weighed (PLAN §2): promote relations to core; keep both with relations opt-in; split reads/writes.

## Decision

**Option 1. The YAML-declared relation graph is the core contract for cross-entity reads, on both sides of the wire.**

1. **Backend.** A generated `defineRelations()` manifest is passed to `drizzle({ client, relations })`. Generated
   repositories accept a typed `with` include on `findById` / `list` / declarative `queries:`. Any row-shaped path
   through the graph is therefore a generated read, resolved as one include tree from a root.
2. **Services stay generated and atomic.** Relationship methods on the generated service keep their names and
   signatures; their bodies delegate to the entity's own repository traversal. The CGP-358b cross-repository
   composition is **deleted, not kept as a second composition type**. Scope is the `clean-lite-ps` pipeline.
   The service also exposes a generated typed **navigator** (`service.from(id).opportunity().account()…fetch()`), a
   builder that compiles to one include tree and executes once. All declared relationships are navigable internally by
   default; declaring the relationship is what permits the path.
3. **The hand-written layer is use-cases and queries, composed on top.** Cross-entity writes, transactions and
   workflows are use-cases. Invariants that must hold on every write are declared (DTO/Zod validation) or the entity's
   raw route is suppressed with `api: false` so the use-case is the only write path.
4. **Aggregation is not this surface.** Aggregating over a to-many path fans out; RQB does not address it. Aggregates
   go through the semantic-query package (`AggregateModel` emitted from the same YAML), injected into a use-case/query.
5. **Frontend.** The ADR-038 emitter gains relation accessors (`has_many`, junction, typed include) over the TanStack
   DB collections it already emits, generated from the same graph.
6. **Every hop is scoped.** Traversal applies tenant scope (ADR-042, ALS-fed), soft-delete and `userTracking` filters at
   each level of the include tree. ADR-042 must be implemented before traversal ships.
7. **HTTP exposure is allowlisted.** Controllers accept only includes declared in YAML, depth-capped. A client never
   supplies a raw include tree, and an entity with `api: false` (ADR-043) is not reachable through an exposed neighbour
   unless the allowlist names it.

> **Revision, 2026-09-20 (REL-2, #587) — `api: false` is not overridable by an allowlist.** The last clause of §7
> above ("…unless the allowlist names it") is withdrawn. An allowlist path that traverses an entity declaring
> `api: false` is a **generation error naming both entities**, with no per-path override.
>
> It was in tension with ADR-043 §6, which says `api: false` means "no network data plane" for that entity, full stop.
> REL-2 §5.3 put the choice to the gate and the gate chose strict, for three reasons: the entities people mark
> `api: false` are credentials and internal join tables; an override declared on the *neighbour* is invisible at the
> `api: false` declaration site, so the closed entity's own YAML stops telling the truth; and nothing is lost, because
> an entity that should be reachable through a neighbour can simply not be `api: false`.
>
> Enforced at generation time (`src/emitters/relations/build-includes.ts`), so the property is a build error rather
> than something a reviewer has to notice. Declaring `api.includes` together with `api: { enabled: false }` is the
> same error for the same reason. Evidence + the rejected reading: `docs/specs/REL-2.md` §5.3, §9.1.

### Fate of the Electric-parity rationale

Restated, not dropped. Parity no longer means "both sides compose by hand the same way"; it means **both sides project
from the same declared graph**. Per-entity `sync: electric` remains valid: those entities traverse client-side over
replicated collections; `sync: api` entities request an allowlisted include.

### Naming and junctions

Relation keys are the YAML relationship names; where an entity declares `roles:` (ADR-041 follow-on), role names name
the relations to the same target. Many-to-many uses `.through()` over the `Junction` pattern entity.

> **Revision, 2026-09-17 (REL-1, #586) — `alias` is not used.** This section originally read "`alias` comes from
> `inverse`; … role names are the alias for multiple relations to the same target." That was written before the v2
> builder was measured. Drizzle reads `alias` in exactly one place — the reverse-inference branch of
> `processRelations` (`drizzle-orm/relations.js:41-48`), which runs only when a relation omits `from`/`to`. A generator
> always knows the FK column, so REL-1 emits explicit `from`/`to` on **both** sides of every relation; self-references
> and multiple relations between the same pair of tables then need no `alias` at all, and none is emitted. `inverse:`
> keeps its existing job (naming the other side's relation) without feeding a Drizzle field, and `roles:` (CAP-2) will
> contribute additional explicitly-keyed edges the same way. Evidence: `docs/specs/REL-1.md` §R2.

## Consequences

- `docs/relationship-pattern-audit.md` §1 and §4 are superseded; its rule "generated service methods MUST NOT use
  `with:`" is deleted with a dated note.
- Generated services stop injecting sibling repositories; cross-module import coupling from CGP-358b goes away
  (to be confirmed when REL-3 traces the module wiring).
- New obligations: per-hop scoping correctness is now a security property and needs integration tests (cross-tenant and
  soft-deleted rows must not appear at any depth); include allowlists are a new YAML surface.
- Deep includes can be expensive; the depth cap and allowlist are the control. Internal callers are trusted with the
  full typed include.
- No backwards-compat path is kept (CLAUDE.md operating principle): baselines and snapshots regenerate.

## Alternatives considered

- **Keep both, relations opt-in** — smallest change, preserves the old parity argument, but leaves two answers to
  traversal and the app layers not projecting from the graph.
- **Split by surface (reads traverse, writes compose)** — close to what this ADR lands on in effect (writes are
  use-cases), but framed as two access patterns; `clean-lite-ps` has no read/write split to hang it on.
- **A second, "semantic" service composition type beside CGP-358b** — rejected: reintroduces the two-answers problem,
  and aggregation already has a home in the semantic-query package.

## Open follow-ups (implementation-time)

- ~~Whether v2 predefined relation `where` filters can carry the per-hop scope, or the repository rewrites the include
  tree (REL-2 spike).~~ **Closed 2026-09-20 (REL-2, #587): the predicate is emitted into the manifest.** Both
  candidates produce equivalent SQL for an include, so capability was not the deciding factor. What decided it is that
  RQBv2 traverses a relation in *two* places — the `with:` lateral AND the `where: { <relation>: … }` EXISTS subquery —
  and a repository that rewrites the caller's include tree only ever sees the first. The second was measured leaking,
  with rows, against real Postgres: a caller learned that a row matching a filter existed when that row was another
  tenant's. With the predicate on the relation, every consumer of it carries the guard — including a hand-written
  `db.query.*` that never touches a repository. The `isReversed` caveat below is why this only works: REL-1 emits
  explicit `from`/`to` on both sides, so a hop's `where` always describes the target table. Evidence:
  `docs/specs/REL-2.md` §1.
- ~~YAML shape of the include allowlist.~~ **Closed 2026-09-20 (REL-2, #587):** `api: { includes: { <route>: {
  max_depth, paths: [<dot path>] } } }`, keyed by generated read route (`find_by_id` / `list` / finder names), compiled
  to a literal include fragment per path at generation time. `docs/specs/REL-2.md` §5.1.
- Whether the frontend include mechanism lives in `@pattern-stack/frontend-patterns` or is fully generated.
