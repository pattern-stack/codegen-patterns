# ADR-0001 — Ambient tenant scoping for user-owned repositories

- **Status:** Accepted
- **Date:** 2026-05-25
- **Affects:** `runtime/base-classes/base-repository.ts`, new `runtime/base-classes/tenant-context.ts`, `src/cli/shared/init-scaffold.ts`
- **Ported from:** `dealbrain` `packages/integrations/src/framework/tenant-context.ts` (the proven production pattern, added 2026-05-22)

## Context

Generated repositories scoped data to a user by **threading `userId` explicitly**
through bespoke query methods (`findByUserId`, `findByUserIdAndStage`, …). The
generic accessors every repo inherits — `findById`, `findByIds`, `list`,
`count` — applied **no** ownership filter at all: `findById(id)` would return any
row regardless of who owns it. Cross-tenant isolation depended on every call site
remembering to use a `*ByUserId` method, which is exactly the "forgot to scope"
class of bug.

`dealbrain` solved this in its hand-written integration package with an
AsyncLocalStorage-backed `RequesterContext`: scope is set once at each boundary
and read implicitly inside the repository base, so isolation is automatic and a
missing boundary fails loud. This ADR ports that pattern into the codegen
substrate so every generated consumer gets it.

## Decision

1. **Ambient context primitive** (`tenant-context.ts`). An `AsyncLocalStorage`
   holding `RequesterContext { userId, organizationId, scope?, orgUserIds? }`,
   with `withRequester(ctx, fn)` to set it at boundaries and
   `requireRequester()` / `tryGetRequester()` to read it. Scope model copied
   verbatim from `dealbrain`: `'user'` | `'org'` | `'superuser'`.

2. **`BaseRepository.scopePredicate()`** reads the ambient context and returns a
   `user_id` filter, **gated on the existing `behaviors.userTracking` flag** —
   no new per-entity config knob. `user_tracking` already adds the `user_id`
   column and emits `userTracking: true`; that flag was previously dormant
   (declared, never read), so giving it the "auto-scope" meaning is conflict-free.
   - `'user'` → `user_id = ctx.userId`
   - `'org'` → `user_id IN ctx.orgUserIds` (empty list ⇒ `sql\`false\`` — fail-closed)
   - `'superuser'` → no filter

3. **Single-`WHERE` combination.** Drizzle's `.where()` *overrides* a prior
   `.where()` on a `$dynamic()` query (verified empirically) — so the scope (and
   the pre-existing soft-delete guard) cannot be added as a second chained
   `.where()`; it would be silently dropped. `baseQuery(extra?)` now folds
   soft-delete + scope + the leaf predicate into one AND-joined `WHERE`. Reads
   (`findById`, `findByIds`, `list`, `count`) and by-id writes (`update`,
   `delete`) all carry the guard.

4. **Lenient by default, strict opt-in** (`scopeEnforcement`). With no ambient
   context active, a `userTracking` repo is **not** scoped (`'lenient'`) — so the
   change is additive: existing consumers behave exactly as before until they
   install `withRequester(...)` at their boundaries. A repo (or family base) can
   override `scopeEnforcement = 'strict'` to make a missing boundary throw
   (`dealbrain`'s fail-loud semantics) — recommended for new multi-tenant apps.

## Consequences

- **Soft-delete bug fixed as a side effect.** Because leaf predicates were
  chained via a second `.where()`, the soft-delete guard was being dropped on
  `findById` / `list({where})` / every bespoke query method — only no-arg
  `list()` and `count()` actually excluded soft-deleted rows. The single-`WHERE`
  refactor fixes this: `findById` on a `softDelete` entity now correctly excludes
  deleted rows. **Behavior change** — see CHANGELOG migration note.
- **No template changes.** The predicate lives entirely in the hand-maintained
  base class; concrete repos opt in purely via the `user_tracking` behavior.
- **`create()` is not auto-scoped.** Inserting still sets `user_id` from the
  write payload (e.g. the sync write surface). Auto-injecting the owner on insert
  is deferred.

## Deferred / not in scope

- Junction repositories (`JunctionSyncRepository`) — parent-entity subquery
  scoping, as `dealbrain` does. Follow-up.
- Boundary auto-install — codegen does not yet emit `withRequester(...)` into the
  worker `process()` / use-case / controller it generates; consumers wire it
  (recipe in `tenant-context.ts`). Follow-up.
- Sync-upsert (`onConflict (provider, externalId)`) write-path scoping.

## Alternatives rejected

- **Per-entity `organization_id` column** — nullable-legacy pitfalls; `user_id IN
  (orgUserIds)` works for every user-owned table and keeps repos single-table.
- **Drizzle middleware / global filter** — drizzle 0.45 has no stable per-query
  middleware hook that sees the ambient context cleanly; the base-class chokepoint
  is simpler and explicit.
- **Keep threading `userId`** — the status quo; parameter pollution and the
  forgotten-scope footgun this ADR removes.
