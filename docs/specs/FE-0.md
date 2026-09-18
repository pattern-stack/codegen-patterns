# FE-0 — The emitted frontend tree must compile in a real install, and a gate that proves it

**Status:** Awaiting strategy review
**Date:** 2026-09-17
**Issue:** #620 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-1 (#586, branch base only) · **Blocks:** FE-REL (#589)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter I9) · ADR-038 ·
`docs/specs/2026-06-04-frontend-pipeline-rebuild.md` (the version-pairing contract) · `docs/specs/FE-REL.md` §1

## Why

The version-pairing contract (`src/emitters/frontend/deps.ts`) tells a consumer which packages to install. Installing
exactly those, the frontend tree codegen emits **does not compile** — and nothing in this repo would have noticed,
because the emitted frontend tree is type-checked nowhere. `test/frontend-golden` compares bytes and says so in its
own header: the baseline tsconfig "can't resolve `@repo/db/entities` or `@pattern-stack/frontend-patterns` to compile
the output."

FE-REL (#589) is a *typed* client-side join over these collections. It cannot be built on a dependency set that
cannot be typed, so this lands first.

## Measured

All numbers below were taken on this branch, against live npm, with **bun** (the package manager every other smoke
uses) and cross-checked with **npm**. Both reproduce it identically.

### 1. Today's ranges resolve four copies of `@tanstack/db`

`bun install` of exactly `FRONTEND_EMITTED_DEPS`:

```
node_modules/@tanstack/db                                     -> 0.5.33   (via @pattern-stack/frontend-patterns)
node_modules/@tanstack/electric-db-collection/…/@tanstack/db  -> 0.6.1
node_modules/@tanstack/react-db/…/@tanstack/db                -> 0.7.0
node_modules/@tanstack/query-db-collection/…/@tanstack/db     -> 0.9.2
```

Compiling the **real** emitted tree (`test/frontend-golden/snapshot/`, unmodified) against it:

```
gen/collections/person.ts(10,2): error TS2769: No overload matches this call.
gen/collections/user.ts(11,2): error TS2769: No overload matches this call.
```

whose elaboration names two of the copies:

```
The types of 'sync.sync' are incompatible between these types.
  Type '(params: { collection: import(".../@tanstack/electric-db-collection/node_modules/@tanstack/db/…").Collection<…>
    is not assignable to type '(params: { collection: import(".../@tanstack/react-db/node_modules/@tanstack/db/…").Collection<…>
```

This is the frontend analogue of the dual-`drizzle-orm` hazard DRZ-2 fixed by moving it to a peer: one package, one
type identity, or nothing that crosses it can be typed.

### 2. The root cause is caret ranges over packages that pin `@tanstack/db` **exactly**

| package | declares `@tanstack/db` |
|---|---|
| `@tanstack/react-db@0.1.55` → `@0.1.96` | `0.5.11` → `0.7.0` |
| `@tanstack/electric-db-collection@0.2.11` → `@0.2.43` | `0.5.10` → `0.6.1` |
| `@tanstack/query-db-collection@1.0.6` → `@1.2.15` | `0.5.11` → `0.9.2` |
| `@pattern-stack/frontend-patterns@0.2.0-alpha.20` | `^0.5.11` (a **dependency**, not a peer) |

Three exact pins behind three carets. Any drift splits the identity, and drift has already happened — the floors in
`deps.ts` sit on `db@0.5.x` while the carets now resolve to three different newer lines.

### 3. The three release in lockstep, so a consistent set exists

Every `@tanstack/db` version has exactly one matching release of each. On the line the pairing is already on:

| `@tanstack/db` | react-db | electric-db-collection | query-db-collection |
|---|---|---|---|
| **0.5.33** | **0.1.77** | **0.2.41** | **1.0.30** |

`0.5.33` also **satisfies** `@pattern-stack/frontend-patterns`' own `^0.5.11`, and is the copy it resolves to today —
so collapsing onto it forces nothing on the package; it deduplicates onto what the package already ships.

### 4. Pinning alone is not enough; one `overrides` entry closes it

Exact pins still leave `frontend-patterns`' bundled copy, because a package manager satisfies its `^0.5.11`
independently. Adding `@tanstack/db` as a direct dependency plus

```jsonc
"overrides": { "@tanstack/db": "$@tanstack/db" }   // resolve every copy to the direct dependency
```

collapses the tree to **one** copy — verified with **bun** (`node_modules/@tanstack/db -> 0.5.33`, sole) and **npm**
(`@tanstack/db@0.5.33 overridden` + three `deduped`). The `$name` form avoids hard-coding the version twice.

### 5. With the fix, the real emitted tree compiles clean

The same unmodified `test/frontend-golden/snapshot/` tree, same tsconfig, against the corrected set: **`tsc --noEmit`
exits 0.**

### 6. One undeclared dependency, latent

The emitted collections import `snakeCamelMapper` from `@electric-sql/client`, which `FRONTEND_EMITTED_DEPS` does
not declare. It resolves today only because `@tanstack/electric-db-collection` depends on it (`^1.5.12`) and it
hoists. Not currently red — an undeclared dependency the emitted code relies on, fixed here because this is the file
that declares them.

## Scope

### 1. `src/emitters/frontend/deps.ts`

- Exact pins for the three TanStack collection packages at the §3 lockstep set, plus `@tanstack/db` itself as a
  direct exact dependency. Exact, not caret, for the same reason DRZ-2 pinned the drizzle prerelease exactly: these
  are versions that must agree with each other, and a caret is what broke the agreement.
- Add `@electric-sql/client` `^1.5.12` (§6) — the range `@tanstack/electric-db-collection@0.2.41` itself declares,
  so no second copy.
- `@pattern-stack/frontend-patterns` stays `^0.2.0-alpha.18`. **Not** bumped to `1.0.0`: that release has no
  `dist/sync` at all — no `createStore`, no `createEntityHooks` — and is not dist-tagged `latest` (measured in
  `FE-REL.md` §2.1).
- `@tanstack/react-query` stays `^5.0.0` — it has no `@tanstack/db` in its tree.
- New export `FRONTEND_DEP_OVERRIDES = { '@tanstack/db': '$@tanstack/db' }`, beside the deps it constrains.

### 2. `src/cli/shared/init-scaffold.ts` — `mergeFrontendDeps`

Merges `overrides` the same way it merges `dependencies`: **add only what is missing, never clobber**. An existing
`overrides['@tanstack/db']` is the consumer's choice and is left alone. `unchanged` stays true only when both maps
already have every key, so re-running init is still a no-op.

The no-`package.json` notice gains the overrides line, so a consumer who has to do it by hand is told the whole
contract rather than half of it.

### 3. `src/emitters/frontend/emit-index.ts`

The version-pairing comment block in `generated/index.ts` gains the overrides stanza. That comment is the only place
the contract is visible from inside a consumer's tree; omitting the half that makes the other half work would be
misleading.

### 4. The gate — `test/smoke/run-smoke-frontend.ts` + `just test-smoke-frontend`

The honest gate the issue asks for. Mirrors `test/smoke/run-smoke.ts`:

1. fresh tmp project, `bun init`;
2. `bun add` the emitted deps **for real, from npm** — plus `react`, `react-dom`, `@types/react`, `typescript`,
   `zod`. No stubbing, no vendored tarball, no offline mode (I9). The `overrides` stanza is written into
   `package.json` first, by the same `mergeFrontendDeps` the CLI uses, so the gate exercises the emitted contract
   rather than a hand-written copy of it;
3. `codegen project init --yes --with-tsconfig` and `codegen entity new --all` over
   `test/smoke/fixtures-frontend/entities/` with `generate.frontend: true`;
4. the consumer-owned `@repo/db/entities/*` modules are copied from
   `test/smoke/fixtures-frontend/db-entities/` and mapped by a tsconfig path. These are **not stubs of anything
   codegen emits** — `locations.dbEntities` is consumer-owned by contract (no template writes there; ADR-038), so
   supplying them is what a consumer does. They are real Zod schemas matching the fixture YAMLs, and drift between
   them shows up as a `tsc` error, which is the correct failure;
5. `tsc --noEmit`, scoped through `test/smoke/_consumer-errors.ts` **by diagnostic location only** — no message
   filters, no directory carve-outs, no predicate added to that helper (I9, GATE-2);
6. plus a direct assertion that exactly **one** `@tanstack/db` is installed, so a future range change that
   re-splits the tree names itself instead of surfacing as an opaque TS2769.

**Cost, measured:** the install is ~12 s and ~110 packages. That is cheaper than the existing backend smokes, so it
goes in **`just test-all`** and needs no separate CI job or cache. Nothing here is cached beyond what `bun`'s own
global cache already does for every other smoke.

### 5. Fixtures

`test/smoke/fixtures-frontend/` — two entities is enough to exercise both collection branches and the cross-entity
store: one `sync: electric` (the `electricCollectionOptions` path, which is where both errors were) and one
`sync: api` (the `queryCollectionOptions` path), with a `belongs_to` between them so resolvers, lookups and
`<Class>Refs` all emit.

## Out of scope

- Any change to `pattern-stack/frontend-patterns`. Its `@tanstack/*` should become peer dependencies — that is the
  real fix and it belongs in that repo (`FE-REL.md` §2.5 items 1–3, for the owner to file). This PR works around it
  with one `overrides` line, and says so.
- Relation accessors — FE-REL (#589).
- Bumping `@pattern-stack/frontend-patterns` to `1.0.0` (§Scope 1).
- `pnpm` / `yarn` override syntax. `overrides` is verified for bun and npm; the notice names the others.

## Acceptance

- `bun run typecheck`, `bun run build`, `bun run test` green.
- `just test-all` green **including the new `test-smoke-frontend`**.
- `just test-integration` green.
- The new smoke is demonstrated to **fail** on the pre-fix ranges — a gate that has never been red has not been shown
  to gate anything.
- No filters, no carve-outs, no new `any`; `_consumer-errors.ts` unchanged.

## Risks

| Risk | Response |
|---|---|
| Forcing `frontend-patterns` onto a `@tanstack/db` it did not resolve itself | It did: `0.5.33` is both the version it resolves to today and inside its declared `^0.5.11`. The override deduplicates rather than upgrades |
| Exact pins go stale as TanStack releases | Deliberate. Caret drift across packages that pin `@tanstack/db` exactly is the defect. Moving the set forward is a one-line change with a gate that proves it still compiles — which is the thing that did not exist before |
| The smoke installs from live npm and can fail because someone else published | True of every smoke here (they `bun add` live ranges too). With exact pins the only live-range packages left are `@pattern-stack/frontend-patterns`, `@electric-sql/client` and `@tanstack/react-query`. Surfacing that here rather than in a consumer is the point |
| `overrides` is npm/bun syntax | Verified on both. pnpm (`pnpm.overrides`) and yarn (`resolutions`) are named in the notice rather than emitted blind |
