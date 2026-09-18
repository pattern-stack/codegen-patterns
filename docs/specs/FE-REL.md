# FE-REL — Frontend graph accessors: `has_many` / junction traversal + a typed include over TanStack DB

**Status:** Awaiting strategy review (gate:human)
**Date:** 2026-09-17
**Issue:** #589 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-1 (#586, the relation graph) · **REL-2 (#587) for `api`-mode entities only** (the allowlisted
include it consumes) · **Blocks:** nothing
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

## §2 Charter Q1 — where the include mechanism lives. **Recommendation: fully generated.**

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

### 2.4 Recommendation, and the alternative

**Fully generated.** Five reasons, each measured above:

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

`generated/graph.ts`, emitted by the frontend emitter from **`src/emitters/relations/build-graph.ts`** — REL-1's
builder, called a second time. Same declaration, same edges, same registry-resolved names; no second traversal of the
YAML and no re-pluralization anywhere (item 4 of the brief).

```ts
// generated/graph.ts   @generated
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
the wire. That is ADR-044 §5's "both sides project from the same declared graph", made literal.

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

So FE-REL adopts the invariant that carries I4's intent:

> **One live query per to-many branch of the include tree. Never one per row.** The number of queries is a function of
> the include *shape*, not of the data. A to-one chain of any depth is one query.

Concretely, for `account → { contacts, opportunities → contacts }`:

- `contacts` and `opportunities` are sibling to-many branches ⇒ 2 live queries (joining both in one query would
  multiply rows cartesian-style — |contacts| × |opportunities| — which is a correctness and performance trap, not a
  saving);
- `opportunities → contacts` is a chain inside one branch ⇒ joined in that branch's query, flat, grouped client-side;
- every `belongs_to` on the path is joined into whichever query already carries its source row.

`N+1` — a fetch per row — never happens, and the emitted code has no loop that could produce one.

### 4.2 `electric` entities — live-query joins

For an entity whose effective `sync` is `electric`, every hop whose target is also `electric` is a join over the
local collections:

```ts
// generated/graph/accounts.ts   @generated
export function useAccountGraph<T extends AccountInclude>(id: string, include: T) { … }
```

and the navigator (item 3):

```ts
store.accounts.from(id).opportunities().contacts().use()
// → { data: { …account, opportunities: Array<{ …opportunity, contacts: Contact[] }> }, isLoading, isError, error }
```

`.from(id)` starts a builder; each `.rel()` appends to an include tree and returns the **target's** navigator type
(cycles are fine — `account.contacts().account()` type-checks); `.use()` is the single React hook that compiles the
accumulated tree into the queries of §4.1 and groups the flat rows. There is no per-hop hook and no `await` inside a
loop. `.include({...})` accepts an object tree for callers who prefer it; both compile to the same thing.

Left-join nullability is preserved as measured: a to-one hop is `T | undefined` in the result type, not `T`.

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

### 4.4 Mixed-mode hops — bounded in v1

A hop whose target's sync mode differs from the root's (electric account → api opportunity) is a **generation error**
in v1, naming both entities and the relation. It is not silently degraded to a fetch loop.

The v2 design is recorded so the error message can point at it: bridge the boundary with **one id-set request per
level** (`?where[accountId][in]=…`, the shape the api client's `list` already threads), which keeps §4.1's invariant.
It is left out of v1 because it needs a list-filter contract that REL-2's allowlist does not define.

---

## §5 Typing

Derived from `Graph` (§3) and the existing per-entity row types (`@repo/db/entities`), so nothing is re-declared:

```ts
export type Include<K extends keyof Graph> = {
  [R in keyof Graph[K]]?: true | { with?: Include<Graph[K][R]['target'] & keyof Graph> };
};
export type GraphResult<K extends keyof Graph, I extends Include<K>> = Row<K> & { … };
```

Requirements, mirroring the backend surface so the two read the same:

- a **misspelled relation name — nested or not — is a compile error**;
- a to-one hop is `T | undefined`; a to-many is `T[]`;
- depth is uncapped client-side (the cap is REL-2's HTTP allowlist, and only for `api` mode);
- the include literal is inferred **at the call site** — the same caveat REL-2 records: annotating an include `const`
  with the `…Include` type widens it and loses the exact result shape.

These are the same properties measured on the backend in `REL-2.md` §2.3, expressed over a different type source.

---

## §6 Gates — closing the "only a consumer can verify" gap honestly

### 6.1 `just test-smoke-frontend` (new) — the real gate

The one that would have caught §1. Mirrors `test/smoke/run-smoke.ts`:

1. fresh tmp project, `npm i` `FRONTEND_EMITTED_DEPS` + `react` / `react-dom` / `@types/react` / `typescript` / `zod`;
2. `codegen project init` + `entity new --all` over a fixture set with `generate.frontend: true` and at least one
   `sync: electric` entity, one `sync: api` entity, a self-reference, a `has_many` and a junction;
3. a fixture module behind the `locations.dbEntities.import` alias (`@repo/db/entities`), mapped by `tsconfig.paths`
   — this is consumer-owned by contract (ADR-038), so supplying it is not a stub of anything codegen emits;
4. `tsc --noEmit`, scoped through the existing `test/smoke/_consumer-errors.ts` — **by diagnostic location only**, no
   message filters, no directory carve-outs (charter I9, GATE-2).

**Measured cost: ~12 s install, 107 packages, 7.7 MB.** That is cheaper than the existing backend smokes, so it goes
in **`just test-all`**, not a separate job.

**It will be red on its first run** — that is §1. The implementing PR fixes the pins (`deps.ts` + the emitted
frontend `package.json` gains a single-version constraint for `@tanstack/db`) so it goes green. If any residual
error survives, it gets a **named single-purpose expectation** — exact file, exact code, issue number, asserted
present *and* sole — never a predicate in `_consumer-errors.ts` (CLAUDE.md › Known-red gates).

### 6.2 Golden snapshots

`test/frontend-golden/` gains the relation fixtures and the new files (`graph.ts`, the per-entity graph modules), with
a focused assertion that the emitted graph is **byte-identical to the edges REL-1's builder produces** for the same
fixtures — the mechanical proof of I1 that a snapshot diff alone would not give.

### 6.3 Unit

`build-graph` already has REL-1's coverage; FE-REL adds the client renderer's own tests (include-type derivation,
the to-many grouping function, the cross-mode generation error).

### 6.4 What is deliberately **not** gated here

Runtime behaviour in a browser (does the live query actually re-render). No headless-browser gate is proposed: it
would be this repo's first, and the compile gate plus unit tests on the pure grouping function cover the parts
codegen owns. Recorded rather than quietly skipped.

---

## §7 Out of scope

- Writes through a relation (nested create/update) — ADR-044 §3: use-cases.
- Aggregation over a to-many (charter I5 — query-surface).
- `offline` / Dexie sync mode (still deferred, rebuild spec OQ-6).
- Any change to `pattern-stack/frontend-patterns` — §2.5 is a proposal for the owner to file there, not work in this
  repo.
- The `clean` pipeline (#602).

## §8 Risks

| Risk | Signal | Response |
|---|---|---|
| §1 is not fixed, or `overrides` is not honoured by the consumer's package manager (bun uses `resolutions`) | the frontend smoke stays red | Emit the constraint for both managers and assert it in the smoke. This is the first thing the implementing PR does |
| TanStack DB's builder types churn (0.5 → 0.9 inside one dep tree today) | the smoke goes red on a fresh install | The smoke installs live ranges deliberately, so drift surfaces here rather than in a consumer. A pinned lockfile would hide exactly the class of bug §1 is |
| `api`-mode traversal blocked behind REL-2 | — | §4.3: split the implementation; the `electric` half needs only REL-1 |
| Sibling to-many branches multiply queries | a deep include issues several live queries | §4.1 is the stated contract, not an accident; the count is a function of the include shape and is visible in the generated code |
| The package's `store.resolve` stays wrong for irregular plurals | a consumer calls `store.resolve.addresse` | Generated code does not use it (§2.2). §2.5 item 3 asks the package to fix or drop it |

## §9 Open questions for the reviewer (gate:human)

1. **Q1 (charter §7)** — confirm **fully generated** (§2.4), with §2.5 items 1–3 filed against
   `pattern-stack/frontend-patterns` regardless, because §1 is a live defect today.
2. **§1 scope** — fix the dependency pinning inside this unit (recommended: it is a `deps.ts` + scaffold change and
   FE-REL is untestable without it), or split it out as its own issue that FE-REL depends on?
3. **§4.4** — cross-mode hops as a generation error in v1, or is the id-set bridge wanted now?
4. **§6.1** — a new smoke in `just test-all` that installs from live npm ranges. Confirm; it is the first frontend
   gate in the repo and the first that will fail when an upstream publishes.

## §10 Scratch

The package tarballs, the repo clone and the four probe projects lived in `.scratch/` and were deleted before this
commit. Nothing in `pattern-stack/frontend-patterns` was modified and no PR was opened there. Every measurement
above is reproduced with the command or file that produced it.
