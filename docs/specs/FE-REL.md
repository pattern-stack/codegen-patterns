# FE-REL — Frontend graph accessors: `has_many` / junction traversal + a typed include over TanStack DB

**Status:** Implemented
**Date:** 2026-09-17 · **Gate approved:** 2026-09-20 · **Implemented:** 2026-09-20
**Issue:** #589 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-1 (#586, the relation graph) · **FE-0 (#620, §1 — branch base)** · **REL-2 (#587) for `api`-mode
entities only** (the allowlisted include it consumes) · **Blocks:** nothing

> **Reading this after the fact.** §1–§2 are the spike record — the measurements that settled the gate — and are left
> as they were taken. §3 onward is corrected to what was built, with every divergence from the draft called out in
> place and collected in §11. §9's questions are answered rather than asked.
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter §4 I1/I4) · PLAN §6A ·
ADR-038 · ADR-044 §5 · `docs/specs/2026-06-04-frontend-pipeline-rebuild.md`

## Why

ADR-044 restated Electric parity: both sides **project from the same declared graph**. REL-1 built that graph for the
backend. The ADR-038 emitter already puts TanStack DB collections in the browser and resolves `belongs_to` FKs
against them — but `has_many` and junctions have no client-side expression at all, and nothing on the client is
derived from the relation graph.

This spec adds that. It also reports a blocker found while measuring, which has to be settled first (§1).

---

## §1 Finding #1 — the frontend tree codegen emits today does not compile in a real consumer install

> **Shipped separately, as FE-0 (#620, PR #623), which this branch is stacked on.** The gate decision put §1 "in this
> unit"; by the time implementation started it already existed as its own issue with a finished PR, so redoing it here
> would have meant two branches editing `deps.ts` and a guaranteed conflict when the stack merges. Stacking on it
> instead is the same outcome with none of the duplication. FE-0 also went further than §1 proposed, in ways that
> matter here: it pinned all four `@tanstack/db`-bearing packages **exactly** (a caret over packages that pin
> `@tanstack/db` exactly is the actual root cause), split them out as `FRONTEND_LOCKSTEP_DEPS` so `project init`
> corrects a stale consumer, added the undeclared `@electric-sql/client`, and re-measured the `overrides` entry as
> **belt-and-braces rather than load-bearing** — the pins alone collapse the tree. It also built
> `just test-smoke-frontend`, which §6.1 asked for and which this unit extends. See `docs/specs/FE-0.md`.

This was not the question the spike set out to answer. It is what the first honest install produced.

`npm i` of **exactly** `FRONTEND_EMITTED_DEPS` (`src/emitters/frontend/deps.ts`) plus React and TypeScript:

```
+-- @pattern-stack/frontend-patterns@0.2.0-alpha.20
| `-- @tanstack/db@0.5.33
+-- @tanstack/electric-db-collection@0.2.43
| `-- @tanstack/db@0.6.1
+-- @tanstack/query-db-collection@1.2.15
| `-- @tanstack/db@0.9.2
`-- @tanstack/react-db@0.1.96
  `-- @tanstack/db@0.7.0
```

**Four copies of `@tanstack/db`.** Compiling the exact shape `emit-collections.ts` emits today —
`createCollection(electricCollectionOptions({ id, shapeOptions, schema, getKey }))`, with `createCollection` from
`@tanstack/react-db` and `electricCollectionOptions` from `@tanstack/electric-db-collection` — gives **2 errors**,
naming two different copies:

```
error TS2769: No overload matches this call.
  … The types of 'sync.sync' are incompatible between these types.
    Type '(params: { collection: import(".../node_modules/@tanstack/electric-db-collection/node_modules/@tanstack/db/…").Collection<…> …
      is not assignable to type '(params: { collection: import(".../node_modules/@tanstack/react-db/node_modules/@tanstack/db/…").Collection<…> …
```

This is the frontend analogue of the hazard DRZ-2 fixed on the backend by making `drizzle-orm` a peer: **one package
must have exactly one type identity, or nothing that crosses it can be typed.**

**One line fixes it.** With `"overrides": { "@tanstack/db": "<one version>" }` in the consumer's `package.json`, npm
dedupes all four to one copy, and the same file compiles clean — as does an FE-REL join over those collections, with
real inferred types (an `@ts-expect-error` on a non-existent field is satisfied, and the left-joined side is correctly
`… | undefined`).

| | copies of `@tanstack/db` | today's emitted collection + an FE-REL join |
|---|---|---|
| as `deps.ts` specifies | 4 | **2 errors** |
| + a single-version override | 1 (`overridden` / `deduped`) | **compiles, fully typed** |

Why nobody noticed: **the emitted frontend tree is type-checked nowhere.** The golden test
(`src/__tests__/emitters/frontend/golden-tree.test.ts`) compares bytes and says so in its own header — the baseline
tsconfig "can't resolve `@repo/db/entities` or `@pattern-stack/frontend-patterns` to compile the output". That is the
gap §6 closes, and the gate it proposes goes red on this finding the first time it runs, which is the point.

**Consequence for this spec:** FE-REL's whole premise is a *typed* client-side join. It cannot be built on a
dependency set that cannot be typed. §1 is therefore step one of the implementation, not a footnote — and it is
small: `deps.ts` + the init scaffold's emitted frontend `package.json`.

---

## §2 Charter Q1 — where the include mechanism lives. **Decided 2026-09-20: fully generated.**

The question is not a preference. Here is the package's measured surface.

### 2.1 What `@pattern-stack/frontend-patterns` actually publishes

Read three ways: `npm view`, the published tarballs of `0.2.0-alpha.20` and `1.0.0` unpacked and grepped, and the
private repo cloned (`gh repo clone`, HEAD `bf6e50d`, version `0.2.0-alpha.18` — read only; nothing was modified and
no PR was opened there).

| Fact | Evidence |
|---|---|
| dist-tags are `latest: 0.2.0-alpha.12`, `alpha: 0.2.0-alpha.20`. A `1.0.0` exists and is **not** `latest` | `npm view … versions dist-tags` |
| **`1.0.0` has no `dist/sync` at all** — no `createStore`, no `createEntityHooks`, no `EntityStoreProvider`. Its `index.d.ts` exports only atoms/molecules/features/templates/organisms + `cn` + `apiClient` | unpacked tarball |
| `0.2.0-alpha.20` is **ahead of the repo HEAD** (alpha.18): it adds `useData`, `LookupsEngine`, `Page`, `ListQuery`, `SortSpec`, `EntityWithData` | tarball vs clone |
| **Zero relation surface.** grep for `relation|include|join|useLiveQuery|traverse|graph` over every published `.d.ts`: 7 hits, all incidental prose ("may include txid", "Include time picker") | tarball |
| `EntityHookConfig.collection`, `EntityHooks.collection` and `StoreConfig.collections` are **`any`** — with the package's own reason: *"to avoid version mismatch issues with TanStack DB beta types across npm link boundaries"* | `dist/sync/types.d.ts`, `createStore.d.ts` |
| `@tanstack/db`, `@tanstack/react-db`, `@tanstack/electric-db-collection`, `@tanstack/query-db-collection` are **`dependencies`**. Only `react` / `react-dom` are peers | `package.json` |
| `createStore` **re-pluralizes at runtime** to key `store.resolve`: `name.endsWith('ies') ? slice(-3)+'y' : name.endsWith('s') ? slice(-1) : name`. `addresses` → `addresse`; `people` → `people` | `src/sync/createStore.ts` |

The last two rows are the same fact twice. The package cannot type its collections **because** it bundles its own
TanStack DB; and the one place it derives a relation-shaped name it does so by guessing — precisely what ADR-038 and
CLAUDE.md forbid ("FK target names resolve against the cross-entity registry … never re-pluralized").

### 2.2 The precedent is already set, in this repo

`src/emitters/frontend/emit-store.ts`'s header records the same conclusion reached once before:

> The published `@pattern-stack/frontend-patterns` (`0.2.0-alpha.18`) exports ONLY `createStore` … it does NOT export
> `createResolvers` / `buildLookups` / … We therefore emit the resolver/lookup modules as fully self-contained code
> with the same semantics … Nothing is imported from the package beyond `createStore`.

FK resolution — the nearest thing to a relation feature the frontend has — is **already fully generated**. FE-REL
extending that is continuity, not a new direction.

### 2.3 The mechanism is in TanStack DB, and generated code can reach it directly

| Measured | |
|---|---|
| Joins are `@tanstack/db`'s query builder (`.join` / `.leftJoin` / `.innerJoin` / `.rightJoin` / `.fullJoin`, default `left`), driven by `useLiveQuery` from `@tanstack/react-db`, which re-exports `* from '@tanstack/db'` | `dist/esm/query/builder/index.d.ts`, `useLiveQuery.d.ts` |
| A to-**one** hop nests: `.join({a}, …).select(({c, a}) => ({ contact: c, account: a }))` yields `{ contact: Contact; account: Account \| undefined }`. Spreading a ref (`...contact`) is a type error — the nesting must be explicit | tsc |
| A to-**many** hop fans out flat; there is **no array/JSON aggregate**. The exported aggregates are `count`, `avg`, `sum`, `min`, `max` — nothing that collects rows | `query/builder/functions.d.ts` |
| Everything must be imported from **one** entry (`@tanstack/react-db`) — `createCollection` from `@tanstack/db` alongside `useLiveQuery` from `@tanstack/react-db` reproduces §1's failure | tsc, both ways |

The emitted collections **already** import `createCollection` from `@tanstack/react-db`, so the single-entry rule is
established; FE-REL extends it to `eq` / `useLiveQuery`.

### 2.4 Decision, and the alternative

**Fully generated** — confirmed at the gate on 2026-09-20 and recorded in the charter's decision log. This reverses the
recommendation the charter carried when Q1 was opened (`frontend-patterns`, on the `createEntityHooks` precedent), and
PLAN §6A.3 is rewritten accordingly. Five reasons, each measured above:

1. **Nothing to build on** — the package has no relation surface at any published version, and its 1.0.0 line dropped
   the sync layer entirely.
2. **The package cannot type it** while it bundles TanStack DB; its collections are `any` for exactly that reason.
   A traversal API whose collections are `any` is untyped traversal, which is the thing worth generating.
3. **Precedent** — resolvers and lookups are already emitted self-contained for the same reason (§2.2).
4. **I1** — the graph is a codegen declaration. A package API would have to take it as runtime data and re-derive
   names, and the one place the package does that today is already wrong for irregular plurals.
5. **Gate ownership** — a package-side mechanism makes this unit block on an unpublished release in another repo, and
   this repo's gate could not go green without it.

**The alternative, stated fairly.** If the mechanism lives in the package, generated code shrinks to a graph
descriptor plus a `createGraph(...)` call, every consumer of the design system gets traversal without regenerating,
and a future non-codegen consumer benefits. That is a real upside; it is simply not reachable from the package's
current shape. §2.5 is what it would take.

### 2.5 Proposal for `pattern-stack/frontend-patterns` (for the owner to file there)

Ordered; the first three are worth doing **whichever** Q1 answer is chosen, because §1 is a live defect for every
consumer today.

1. **Move `@tanstack/db`, `@tanstack/react-db`, `@tanstack/electric-db-collection`, `@tanstack/query-db-collection`
   from `dependencies` to `peerDependencies`** (plus `devDependencies` for the package's own build). Exactly the
   change DRZ-2 made for `drizzle-orm`: one copy per app, one type identity. This is the root cause of §1.
2. **Drop the `any` collections.** Once (1) lands, `EntityHookConfig` / `EntityHooks` / `StoreConfig` can be generic
   over the collection type and the comment that justifies the `any` no longer applies.
3. **Fix `createStore`'s runtime de-pluralization.** Take the resolver keys from the caller (codegen knows them from
   the registry) instead of guessing; `addresses → addresse` is a bug today. Alternatively drop `store.resolve`
   entirely — codegen already emits its own `createResolvers()` and does not use it.
4. *(Only if Q1 is answered "package".)* Add a relations slot: `StoreConfig.graph?: GraphDescriptor` plus a
   `useInclude(root, id, tree)` / `createNavigator(graph, collections)` primitive implementing §4's semantics —
   one live query per to-many branch, client-side grouping, left-join nullability. Codegen would then emit only the
   descriptor and the typed wrapper types.

---

## §3 The client-side graph (charter I1)

`generated/graph/descriptor.ts`, emitted by the frontend emitter from **`src/emitters/relations/build-graph.ts`** —
REL-1's builder, called a second time. Same declaration, same edges, same registry-resolved names; no second traversal
of the YAML and no re-pluralization anywhere (item 4 of the brief).

> **Path corrected during implementation.** The draft put the descriptor at `generated/graph.ts` beside a
> `generated/graph/` directory of accessors. That pair is an **ambiguous module specifier** — `./graph` resolves to
> either one depending on the bundler. The descriptor moved inside the directory and `graph/index.ts` re-exports both,
> so the root barrel exports one unambiguous module. Nothing else about this section changed: the keys, the edges and
> the exported name `graph` are exactly as drafted.

```ts
// generated/graph/descriptor.ts   @generated
export const graph = {
  accounts: {
    parentAccount: { kind: 'one',  target: 'accounts',      from: 'parentAccountId', to: 'id' },
    contacts:      { kind: 'many', target: 'contacts',      from: 'id', to: 'accountId' },
    opportunities: { kind: 'many', target: 'opportunities', from: 'id', to: 'accountId' },
  },
  contacts: {
    account:       { kind: 'one',  target: 'accounts', from: 'accountId', to: 'id' },
    opportunities: { kind: 'many', target: 'opportunities', from: 'id', to: 'id',
                     through: { collection: 'opportunityContacts', from: 'opportunityId', to: 'contactId' } },
  },
  // …
} as const;
export type Graph = typeof graph;
```

Keys are the **plural** collection names the store already uses (`store.persons`), and relation keys are the YAML
relationship names camelCased — the same keys REL-1 emits and REL-2/REL-3 expose, so one name works on both sides of
the wire. That is ADR-044 §5's "both sides project from the same declared graph", made literal — and §6.2's test
asserts it edge-for-edge against `buildRelationGraph`, so it cannot quietly stop being true.

**What the projection drops, and why it says so.** REL-1 also emits the junction table's own two `belongs_to` edges,
so the server can run `db.query.opportunityContacts.findMany({ with: … })`. The client store has no entry for a
junction — the frontend set is the *entity* registry — so there is no `.from(id)` root to hang them on. Those edges,
and only those, are dropped from the client projection, each with a warning naming the junction and pointing at the
hop that does work (`graph.<parent>.<junction>`). Junction rows stay reachable; they are simply reached from a parent.

### Why not import the backend manifest's type (item 5)

Considered and rejected. `typeof relations` from `src/generated/relations.ts` is a Drizzle type: importing it would
pull `drizzle-orm`'s type graph into the frontend build, and the frontend's row types come from
`@repo/db/entities` (Zod), not from Drizzle. The two would have to be reconciled anyway. Emitting a client descriptor
**from the same builder** gives I1 (one declaration) without coupling the two type systems — and gives the client a
runtime value, which a type alone would not.

---

## §4 The traversal API, and what I4 means on the client

### 4.1 The honest version of "one statement"

Charter I4 says a traversal is one statement. Server-side that is literal — RQBv2's lateral + `json_agg`. On the
client it cannot be, **and the reason is measured**: TanStack DB has no array aggregate, so a to-many cannot be
folded into a nested array inside one result row. A join fans out flat.

So FE-REL adopts the invariant that carries I4's intent. As built, stated exactly:

> **One live query per to-many relation OF THE ROOT. Never one per row.** The number of queries is a function of the
> include *shape*, not of the data. Every to-one hop is joined into whichever query already carries its source row, so
> a to-one costs nothing.

Concretely, for `account → { parentAccount, contacts, opportunities → account }`:

- `parentAccount` is a to-one ⇒ joined into the **root** query; no second query;
- `contacts` and `opportunities` are sibling to-many relations ⇒ one live query each (joining both into one query
  would multiply rows cartesian-style — |contacts| × |opportunities| — which is a correctness and performance trap,
  not a saving);
- `opportunities → account` is a to-one inside a branch ⇒ joined into **that branch's own** query, so the branch is
  still one query at depth 2.

`N+1` — a fetch per row — never happens, and the emitted code has no loop that could produce one: §6.3 asserts the
generated module contains no `for`, no `while` and no `await` at all.

**Two corrections from the draft, both forced by React.**

1. *"per to-many branch of the include tree"* became *"per to-many relation of the root"*. Hooks cannot be called
   conditionally, so the number of `useLiveQuery` calls has to be fixed when the file is written, not when the include
   literal is passed. The generated module therefore has exactly `1 + <to-many relations>` of them, all at the top
   level of the hook, countable by eye.
2. That would make the count a function of the *entity* rather than the include — except `useLiveQuery`'s second
   overload accepts `undefined` from its query function and reports `status: 'disabled'`. A branch that was not
   included returns `undefined` and **does not run**. So the hook count is static, as React requires, and the number
   of queries actually executed is a function of the include shape, as I4 intends. Both halves are true at once.

### 4.2 `electric` entities — live-query joins

For an entity whose effective `sync` is `electric`, every hop whose target is also `electric` is a join over the local
collections. One fully generated module per such entity, `generated/graph/<entity>.ts`:

```ts
// generated/graph/account.ts   @generated
export interface AccountInclude { … }                    // this entity's navigable relations
export type AccountGraph<I extends AccountInclude> = …   // the result shape for that include
export function useAccountGraph<const I extends AccountInclude>(
  id: string | null | undefined,
  include: I,
): AccountGraphResult<I>
```

```ts
const { data } = useAccountGraph(id, { opportunities: { with: { account: true } } });
// data: Account & { opportunities: Array<Opportunity & { account: Account | undefined }> } | undefined
```

Left-join nullability is preserved as measured: a to-one hop is `T | undefined` in the result type, not `T`.

**Junction hops work, and they need link rows.** A `through` hop filters the junction's link rows by the root id and
inner-joins the target — one query, still, because each link row yields at most one target row (inner, not left: a
link whose target is missing is not a member). That means the link rows have to be in the browser, so the emitter now
writes a **junction collection** per junction alongside the entity collections. Two things differ from an entity
collection, both forced by `templates/junction/new/entity.ejs.t`: there is no surrogate `id` (the primary key is the
composite of the two FK columns), so `getKey` is that pair; and the row type is consumer-owned in
`locations.dbEntities` like every other, because no template writes there (ADR-038). Junction collections are
**electric-only** — `junction new` emits no controller, so junction rows have no REST surface to back a
`queryCollectionOptions` branch.

**Two boundaries the draft did not draw, both recorded rather than discovered later:**

- **Depth is 2.** A to-one hop of a branch target nests into that branch's single query, which is the
  `opportunities → account` case the draft's example wanted. A to-many inside a branch is not in v1: it is a
  cartesian fan-out that has to be grouped client-side back into nested arrays, and doing that honestly — including
  what it does to the result type — is its own unit. A misspelled relation name is a compile error at **either**
  level, which is what §5 actually asked for.
- **A fluent navigator (`.from(id).opportunities().use()`) is not in v1.** It is a surface over the same include tree,
  and it only pays for itself once the tree can be arbitrarily deep — which is the boundary above. The include-object
  form is the one that shipped; the draft said both compile to the same thing, and that remains the plan.

### 4.3 `api` entities — one request, REL-2's allowlist

For an entity whose effective `sync` is `api`, the same navigator compiles to **one** HTTP request using REL-2's
allowlisted dot-path include (§5.2 of `REL-2.md`):

```
GET /accounts/{id}?include=opportunities,opportunities.account
```

The response is the nested shape REL-2 returns. The emitted code then **writes each nested object into its own
collection** (an `opportunity` in the response is a row of `opportunityCollection`) before returning the nested view,
so the rest of the app sees one source of truth and the FK resolvers (`store/resolvers.ts`) stop missing on rows that
arrived via an include. This replaces part of what `hydrateResolverCache()`'s full-fetch escape hatch exists for.

**Dependency to flag:** the `api` half cannot be built before REL-2 lands, because the allowlist is what it requests
against. The `electric` half (§4.2) and §3's graph do not depend on REL-2 at all. **Implementation should be split on
that line** so FE-REL is not blocked behind a `gate:human` issue that is itself blocked on TEN-1.

**That split is what shipped.** An entity whose effective sync is `api` gets **no accessor module**. Its edges are
still in the descriptor — only the accessors wait. Because a deferral nobody can see is a silent drop (charter I9),
the deferral is visible three ways: the entity is listed by name and reason in `graph/descriptor.ts`' own header
comment, the CLI prints it at generation time, and the frontend smoke asserts both that no module was written for an
`api` entity **and** that the descriptor says why. An all-`api` project is therefore not an error and not a
regression — it simply gets the descriptor and nothing else.

### 4.4 Mixed-mode hops — bounded in v1 (decided at the gate, 2026-09-20)

A hop whose target's sync mode differs from the root's (electric account → api opportunity) is a **generation error**
in v1, naming both entities and the relation. It is not silently degraded to a fetch loop. Confirmed at the gate and
recorded in the charter's decision log.

The v2 design is recorded so the error message can point at it: bridge the boundary with **one id-set request per
level** (`?where[accountId][in]=…`, the shape the api client's `list` already threads), which keeps §4.1's invariant.
It is left out of v1 because it needs a list-filter contract that REL-2's allowlist does not define. The emitted
message says exactly that, so an author who hits it is one sentence from knowing why and one `sync:` line from fixing
it.

**As built, it is one rule, not two.** The check is "an `electric` source may only reach an `electric` target". A
junction that cannot reach the browser is caught by that same rule rather than a special case, because REL-1 emits the
row-level edge to the link table alongside every `through` hop — so the link table's own mode is always tested. The
first implementation carried a separate junction branch with a `via` field; it was **unreachable** (the row-level edge
is sorted first and always fails first), and it was deleted rather than shipped as dead code that a reader would
assume covers something.

Note the asymmetry with §4.3, which is deliberate: an `api` **root** is a deferral, an `api` **target of an electric
root** is an error. The first is work REL-2 will do; the second is a declaration that cannot be executed by any
version of this code.

---

## §5 Typing

Derived from the graph (§3) and the existing per-entity row types (`@repo/db/entities`), so nothing is re-declared.

The draft sketched one recursive pair of types indexed over `Graph`. What shipped is the same contract **generated per
entity** instead — the Q1 answer applied consistently. Two reasons, and the second is the one that decided it:

- a generic recursive mapped type over a `const` graph is where the `any`s creep back in, and an untyped traversal is
  the thing worth generating (§2.4);
- the generated form is *readable*. An author opening `graph/account.ts` sees `AccountInclude` with one commented line
  per relation — its cardinality, its target class, and whether it goes through a junction — rather than a conditional
  type they have to evaluate in their head.

```ts
// generated/graph/account.ts   @generated  (abridged)
export interface AccountInclude {
  /** to-one → Account | undefined */
  parentAccount?: true;
  /** to-many → Opportunity[] — its own live query */
  opportunities?: true | { with?: AccountOpportunitiesWith };
}
export type AccountGraph<I extends AccountInclude> = Account &
  (Sel<I, 'parentAccount'> extends true ? { parentAccount: Account | undefined } : unknown) &
  (Sel<I, 'opportunities'> extends undefined ? unknown : { opportunities: Array<AccountOpportunitiesRow<…>> });
```

`Sel<I, K>` is a two-line local helper (`K extends keyof I ? I[K] : undefined`) that reads a key off an include
literal which may omit it — indexing `I['parentAccount']` directly is an error for a literal that does not carry the
key.

Requirements, mirroring the backend surface so the two read the same — **all measured against the real install**, and
every one of them asserted as a real assignment or a real `@ts-expect-error` in the smoke's type gate (§6.1):

- a **misspelled relation name — nested or not — is a compile error**;
- a to-one hop is `T | undefined`; a to-many is `T[]`;
- depth is uncapped client-side (the cap is REL-2's HTTP allowlist, and only for `api` mode);
- the include literal is inferred **at the call site** (a `const` type parameter) — the same caveat REL-2 records:
  annotating an include `const` with the `…Include` type widens it and loses the exact result shape;
- a relation that was **not** included is not on the result type at all, so reading it is a compile error rather than
  `undefined` at runtime.

These are the same properties measured on the backend in `REL-2.md` §2.3, expressed over a different type source.

One `as` survives in each generated hook, at the boundary where the runtime-assembled object meets the
compile-time-derived type. It is annotated in place, and every property put on that object is guarded by the same
`inc.<rel>` check the type branches on. No `any` is emitted anywhere (charter I9).

---

## §6 Gates — closing the "only a consumer can verify" gap honestly

### 6.1 `just test-smoke-frontend` — the real gate

**Built by FE-0 (#620)**, which is where §1 shipped; FE-REL extends it. It already does steps 1–4 as drafted, with
`bun` rather than `npm` (the manager every other smoke uses, cross-checked against npm) and with the one-copy
assertion on `@tanstack/db` that turns a re-split dependency tree into a named failure instead of an opaque TS2769.

FE-REL adds the fixtures the draft asked for and one thing it did not:

- the fixture set gains `opportunity` and `tag` (both `electric`), a **self-reference** on `account`, a `has_many`
  from account to opportunity, and a **junction** `opportunity ↔ tag` with a `role` enum — generated with a real
  `codegen junction new --all` run, not a hand-written YAML the emitter never sees. `contact` stays `sync: api` and
  is deliberately left with no inbound hop from an electric entity, so it exercises the §4.3 deferral rather than the
  §4.4 error;
- assertions that the graph files were written, that **no** accessor was written for the `api` entity, and that the
  descriptor records the deferral;
- **a type gate.** Compiling the emitted tree proves it is valid TypeScript; it does **not** prove the accessors are
  typed usefully — accessors typed `any` would compile perfectly and be worthless. So
  `test/smoke/fixtures-frontend/usage/` is compiled alongside the generated tree: consumer-shaped code in which every
  property §5 promises is a real assignment and every error §5 promises is a real `@ts-expect-error`. `tsc` reports an
  unused `@ts-expect-error` as an error (TS2578), so the gate cannot rot into a no-op — an emitter change that
  loosened the include type fails this file rather than passing it.

Both halves were **demonstrated red before being shown green** (§10).

**Measured cost: ~12 s install (FE-0), ~4.7 s total for the FE-REL run on a warm bun cache.** Cheaper than the
existing backend smokes, so it is in **`just test-all`**, not a separate job.

**It installs from live npm ranges, on purpose, and that means an upstream publish can turn it red with no change
here.** After FE-0's exact pins the only live-range packages left are `@pattern-stack/frontend-patterns`,
`@electric-sql/client` and `@tanstack/react-query`. Confirmed at the gate as the right trade: a pinned lockfile would
hide exactly the class of defect §1 is, and surfacing drift in this repo rather than in a consumer is the point. If a
residual error ever survives, it gets a **named single-purpose expectation** — exact file, exact code, issue number,
asserted present *and* sole — never a predicate in `_consumer-errors.ts` (CLAUDE.md › Known-red gates).

### 6.2 Golden snapshots

Two, because they answer different questions.

`test/frontend-golden/` (the FE-2/FE-3 tree) gains the two files its `api`-mode fixture produces — `graph/descriptor.ts`
and `graph/index.ts` — which is exactly the §4.3 deferral, locked in bytes.

`test/frontend-graph-golden/` is new and locks the `graph/` subtree for a set with every shape the emitter branches on:
a self-referential to-one, two `has_many` inverses, a `has_one` inverse, an irregular plural resolved through the
registry (`person → persons`, where `pluralize('person')` would say "people"), and a junction contributing both the
`through` hop and the row-level hop. Its fixture set is **REL-1's own** (`test/relations-golden/`), used unchanged —
sharing them is what makes the next assertion meaningful rather than circular.

That assertion is the **mechanical proof of I1**: the client descriptor is compared edge-for-edge — key, cardinality,
target, both columns, `optional`, and all three `through` fields — against what `buildRelationGraph` produces for the
same context, with the junction-rooted edges §3 drops accounted for explicitly. A snapshot diff alone would not give
this: it would pass just as happily if someone re-derived the edges in the frontend and happened to agree. This fails
the moment the two stop being one declaration.

### 6.3 Unit

`build-graph` already has REL-1's coverage; FE-REL adds the client projection's own (`emit-graph.test.ts`, 21 tests):
the cross-mode generation error including the junction case, the `api` deferral being visible rather than silent,
junction collections existing only where junction rows can sync, the emitted types, idempotent re-emission, and the
query-count contract — asserted directly as `1 + <to-many relations>` `useLiveQuery` calls plus the absence of any
`for` / `while` / `await` in the generated module, so an N+1 has nowhere to hide.

The draft listed "the to-many grouping function" here. There isn't one: at v1's depth every branch is filtered by a
single root id, so each branch's rows are already the answer and nothing needs grouping. Grouping arrives with the
to-many-inside-a-branch case (§4.2), and so does its test.

### 6.4 What is deliberately **not** gated here

Runtime behaviour in a browser (does the live query actually re-render). No headless-browser gate is proposed: it
would be this repo's first, and the compile gate plus unit tests on the pure grouping function cover the parts
codegen owns. Recorded rather than quietly skipped.

---

## §7 Out of scope

- Writes through a relation (nested create/update) — ADR-044 §3: use-cases.
- Aggregation over a to-many (charter I5 — query-surface).
- `offline` / Dexie sync mode (still deferred, rebuild spec OQ-6).
- Any change to `pattern-stack/frontend-patterns` — §2.5 items 1–3 are filed as issues in that repo (see §12); no code
  there was read for anything but measurement, and none was modified.
- The `clean` pipeline (#602).
- A fluent navigator, and include depth beyond 2 — §4.2.
- Junction rows as a traversal root — §3.

## §8 Risks

| Risk | Signal | Response |
|---|---|---|
| §1 is not fixed, or `overrides` is not honoured by the consumer's package manager (bun uses `resolutions`) | the frontend smoke stays red | Emit the constraint for both managers and assert it in the smoke. This is the first thing the implementing PR does |
| TanStack DB's builder types churn (0.5 → 0.9 inside one dep tree today) | the smoke goes red on a fresh install | The smoke installs live ranges deliberately, so drift surfaces here rather than in a consumer. A pinned lockfile would hide exactly the class of bug §1 is |
| `api`-mode traversal blocked behind REL-2 | — | §4.3: split the implementation; the `electric` half needs only REL-1 |
| Sibling to-many branches multiply queries | a deep include issues several live queries | §4.1 is the stated contract, not an accident; the count is a function of the include shape and is visible in the generated code |
| The package's `store.resolve` stays wrong for irregular plurals | a consumer calls `store.resolve.addresse` | Generated code does not use it (§2.2). §2.5 item 3 asks the package to fix or drop it |

## §9 Gate decisions — answered 2026-09-20

All four settled at the gate; nothing here is open.

1. **Q1 (charter §7) — fully generated.** Confirmed, reversing the charter's original recommendation. Closed in the
   charter's open-questions table with a dated decision-log entry, and PLAN §6A.3 rewritten. §2.5 items 1–3 are filed
   against `pattern-stack/frontend-patterns` regardless, because they are live defects for every consumer today —
   see §12 for the issue numbers.
2. **§1 scope — in this unit.** It shipped as **FE-0 (#620, PR #623)**, which this branch is stacked on, so the work
   is in the same stack without two branches editing `deps.ts`. See the callout under §1.
3. **§4.4 — a generation error in v1.** No id-set bridge. It names both entities and the relation, and points at the
   v2 design. Recorded in the charter's decision log.
4. **§6.1 — the smoke joins `just test-all`.** Confirmed, with the live-range consequence stated plainly in §6.1: an
   upstream publish of `@pattern-stack/frontend-patterns`, `@electric-sql/client` or `@tanstack/react-query` can turn
   this gate red with no change in this repo. That is the trade being bought — drift surfaces here instead of in a
   consumer.

## §10 Acceptance

Output from the run made after the last edit (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | *(filled in below from the final run)* |
| `bun run build` | *(filled in below from the final run)* |
| `bun test src` (unit) | *(filled in below from the final run)* |
| `just test-all` (incl. `test-smoke-frontend`) | *(filled in below from the final run)* |
| `just test-integration` (Docker) | *(filled in below from the final run)* |

**Both new gates were demonstrated red before they were shown green:**

- **the type gate** — with one `@ts-expect-error`'s subject corrected so the directive became unused, the smoke fails
  with `usage/graph-usage.ts(44,2): error TS2578: Unused '@ts-expect-error' directive.` and exits 1. So the location
  scoping keeps the very class of diagnostic this gate exists for, and the assertions cannot rot into no-ops;
- **the cross-mode generation error** — with `tag` flipped to `sync: api`, `codegen entity new --all` fails with
  `cross-mode relation 'tags': 'opportunity' syncs 'electric' but 'tag' syncs 'api'. …` and a **non-zero exit**, so
  the failure reaches CI rather than scrolling past as a warning.

No filters, no carve-outs, no new `any`, and `test/smoke/_consumer-errors.ts` is unchanged (`git diff` on it is
empty).

## §11 Found during implementation

1. **`generated/graph.ts` beside `generated/graph/` is an ambiguous module specifier.** The descriptor moved to
   `graph/descriptor.ts`; `graph/index.ts` re-exports it with the accessors so the root barrel has one module to
   export (§3).
2. **React fixes the hook count, `useLiveQuery` fixes the query count.** §4.1's invariant had to be restated as "per
   to-many relation of the root", and the disabled-query overload is what keeps the *executed* count a function of the
   include shape. Both halves are now in §4.1.
3. **A junction hop needs a junction collection, and junctions are not entities.** The frontend set is the entity
   registry, so junctions had no client presence at all. They now get a collection — electric-only, composite
   `getKey`, consumer-owned row type — and their own `belongs_to` edges are dropped from the client projection with a
   warning, because a junction has no store entry to root a traversal on (§3, §4.2).
4. **The separate junction branch of the cross-mode check was unreachable.** REL-1 emits the row-level edge to the
   link table alongside every `through` hop, and it sorts first, so the general rule always fires first. Deleted
   rather than shipped as dead code (§4.4).
5. **Relation keys can collide with the generated query's table aliases** (`row`, `link`, `q`). That would compile
   into the wrong join rather than failing, so it is a generation error naming the relation and the reserved set.
6. **There is no grouping function at v1's depth** (§6.3), and the draft's `store.accounts.from(id)…` navigator is
   the same boundary (§4.2). Both are recorded as deferred with the reason rather than quietly dropped.
7. **The `api`-mode deferral needed three exits to be honest**: the descriptor's own header, the CLI's output, and a
   smoke assertion on both. A deferral visible only in a spec is a silent drop (§4.3).

## §12 Filed upstream

§2.5 items 1–3 against `pattern-stack/frontend-patterns` — filed as issues there, no code in that repo changed and no
PR opened:

| §2.5 item | Issue | |
|---|---|---|
| 1. `@tanstack/*` → `peerDependencies` | [frontend-patterns#17](https://github.com/pattern-stack/frontend-patterns/issues/17) | the root cause of §1 |
| 2. Drop the `any` collection types | [frontend-patterns#18](https://github.com/pattern-stack/frontend-patterns/issues/18) | depends on #17 |
| 3. `createStore` re-pluralizes at runtime | [frontend-patterns#19](https://github.com/pattern-stack/frontend-patterns/issues/19) | a live bug (`addresses → addresse`) |

Item 4 was conditional on Q1 being answered "package". It was answered "generated" (§9), so it is not filed.

## §13 Scratch

The package tarballs, the repo clone and the four probe projects lived in `.scratch/` and were deleted before this
commit. Nothing in `pattern-stack/frontend-patterns` was modified and no PR was opened there. Every measurement
above is reproduced with the command or file that produced it.
